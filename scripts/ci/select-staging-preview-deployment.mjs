// Resolves the ONE Vercel Preview deployment of the staging project for an exact PR
// head commit, for .github/workflows/pr-preview-e2e.yml. Every input (GitHub
// deployment/status metadata, Vercel API responses) is untrusted and every guard
// fails closed: the job must never point staging credentials at a production-project
// preview, a production deployment, another PR, another commit, or another
// repository/project.
//
// Pure selection functions are exported for unit tests; `resolveFromApis()` does the
// I/O, and the CLI prints nothing but the verified origin (errors print a code,
// never API bodies).
import { pathToFileURL } from "node:url";

export const STAGING_VERCEL_PROJECT_NAME = "syveka-ai-staging";
export const VERCEL_TEAM_SLUG = "syveka-ai";
/** Exact GitHub deployment environment label Vercel's GitHub app uses for this project's previews (U+2013 en dash). */
export const STAGING_PREVIEW_ENVIRONMENT = `Preview – ${STAGING_VERCEL_PROJECT_NAME}`;
export const VERCEL_BOT_LOGIN = "vercel[bot]";

const PREVIEW_HOST = new RegExp(
  `^${STAGING_VERCEL_PROJECT_NAME}-[a-z0-9]+-${VERCEL_TEAM_SLUG}\\.vercel\\.app$`,
);
const SHA_RE = /^[0-9a-f]{40}$/;

export class SelectionError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SelectionError";
    this.code = code;
  }
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** A bare https origin on the staging project's preview host pattern, else null. */
export function stagingPreviewOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !PREVIEW_HOST.test(url.hostname)
  ) {
    return null;
  }
  return url.origin;
}

/**
 * Step 1: the PR itself must be open, same-repository (never a fork), and its
 * current head must be exactly the commit the operator asked to test.
 */
export function assertPullRequest(pr, { repository, expectedSha, prNumber }) {
  if (!SHA_RE.test(expectedSha)) throw new SelectionError("EXPECTED_SHA_INVALID");
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new SelectionError("PR_NUMBER_INVALID");
  if (!pr || pr.number !== prNumber) throw new SelectionError("PR_NUMBER_MISMATCH");
  if (pr.state !== "open") throw new SelectionError("PR_NOT_OPEN");
  if (lower(pr.head?.sha) !== expectedSha) throw new SelectionError("PR_HEAD_SHA_MISMATCH");
  const repo = lower(repository);
  if (
    !repo ||
    lower(pr.base?.repo?.full_name) !== repo ||
    lower(pr.head?.repo?.full_name) !== repo
  ) {
    throw new SelectionError("PR_REPOSITORY_MISMATCH");
  }
  if (typeof pr.head?.ref !== "string" || !pr.head.ref) {
    throw new SelectionError("PR_HEAD_REF_MISSING");
  }
  return { headRef: pr.head.ref };
}

/**
 * Step 2: GitHub deployment metadata. Only Vercel-bot-created, non-production
 * deployments labelled exactly as the staging project's Preview environment and
 * pinned to the expected SHA qualify. Each one's authoritative status is its single
 * most recent status (highest id), which must be a Vercel-posted success for the
 * same environment on the staging preview host. Zero qualifying URLs, or more than
 * one distinct URL (ambiguous), fails closed.
 */
export function selectGithubDeployment(deployments, statusesById, { expectedSha }) {
  if (!Array.isArray(deployments)) throw new SelectionError("DEPLOYMENTS_INVALID");

  const candidates = deployments.filter(
    (d) =>
      lower(d?.sha) === expectedSha &&
      d.environment === STAGING_PREVIEW_ENVIRONMENT &&
      d.original_environment === STAGING_PREVIEW_ENVIRONMENT &&
      d.production_environment === false &&
      d.task === "deploy" &&
      d.creator?.login === VERCEL_BOT_LOGIN &&
      d.creator?.type === "Bot",
  );
  if (candidates.length === 0) throw new SelectionError("NO_MATCHING_PREVIEW_DEPLOYMENT");

  const verified = new Map();
  for (const deployment of candidates) {
    const statuses = statusesById?.[deployment.id];
    if (!Array.isArray(statuses) || statuses.length === 0) continue;
    const latest = statuses.reduce((newest, s) => (s.id > newest.id ? s : newest), statuses[0]);
    if (
      latest.state !== "success" ||
      latest.creator?.login !== VERCEL_BOT_LOGIN ||
      latest.environment !== STAGING_PREVIEW_ENVIRONMENT
    ) {
      continue;
    }
    const origin = stagingPreviewOrigin(latest.environment_url || latest.target_url);
    if (origin) verified.set(origin, deployment.id);
  }

  if (verified.size === 0) {
    throw new SelectionError("NO_CURRENT_SUCCESSFUL_PREVIEW_DEPLOYMENT_STATUS");
  }
  if (verified.size > 1) {
    throw new SelectionError("AMBIGUOUS_PREVIEW_DEPLOYMENTS", `${verified.size} distinct URLs`);
  }
  const [[origin, deploymentId]] = verified;
  return { origin, deploymentId };
}

/**
 * Step 3: Vercel's own record for that exact host, fetched with the staging token.
 * It must belong to the staging project ID, be a preview (`target` null) that is
 * READY, and be built from the expected commit on the PR's branch in this
 * repository. `projectId`/`target`/`readyState`/`url` are documented API fields.
 * The git `meta` keys are written by Vercel's GitHub integration and are REQUIRED:
 * if Vercel ever stops sending them, this fails closed instead of trusting less.
 */
export function assertVercelDeployment(
  vercel,
  { origin, expectedSha, stagingProjectId, headRef, prNumber, repository },
) {
  if (!vercel || typeof vercel !== "object") throw new SelectionError("VERCEL_DEPLOYMENT_MISSING");
  if (!stagingProjectId) throw new SelectionError("STAGING_PROJECT_ID_MISSING");
  if (vercel.projectId !== stagingProjectId) throw new SelectionError("VERCEL_PROJECT_MISMATCH");
  if (vercel.target !== null && vercel.target !== undefined) {
    throw new SelectionError("VERCEL_TARGET_NOT_PREVIEW", String(vercel.target));
  }
  if (vercel.readyState !== "READY") throw new SelectionError("VERCEL_DEPLOYMENT_NOT_READY");
  if (`https://${lower(vercel.url)}` !== origin) throw new SelectionError("VERCEL_URL_MISMATCH");

  const meta = vercel.meta ?? {};
  if (lower(meta.githubCommitSha) !== expectedSha) {
    throw new SelectionError("VERCEL_COMMIT_SHA_MISMATCH");
  }
  if (!headRef || meta.githubCommitRef !== headRef) {
    throw new SelectionError("VERCEL_BRANCH_MISMATCH");
  }
  // Set when Vercel built the commit for an open PR; a different PR is never OK.
  if (meta.githubPrId !== undefined && String(meta.githubPrId) !== String(prNumber)) {
    throw new SelectionError("VERCEL_PR_MISMATCH");
  }
  const [owner, name] = lower(repository).split("/");
  const metaOrg = lower(meta.githubCommitOrg ?? meta.githubOrg);
  const metaRepo = lower(meta.githubCommitRepo ?? meta.githubRepo);
  if (!owner || !name || metaOrg !== owner || metaRepo !== name) {
    throw new SelectionError("VERCEL_REPOSITORY_MISMATCH");
  }
  return origin;
}

/** The full pipeline over already-fetched data; this is what the tests exercise end to end. */
export function resolveStagingPreview(input) {
  const expectedSha = lower(input.expectedSha);
  const prNumber = Number(input.prNumber);
  const { headRef } = assertPullRequest(input.pr, {
    repository: input.repository,
    expectedSha,
    prNumber,
  });
  const { origin } = selectGithubDeployment(input.deployments, input.statusesById, {
    expectedSha,
  });
  return assertVercelDeployment(input.vercelDeploymentFor(new URL(origin).hostname), {
    origin,
    expectedSha,
    stagingProjectId: input.stagingProjectId,
    headRef,
    prNumber,
    repository: input.repository,
  });
}

/**
 * The I/O around the pure selection: GitHub reads with the job's GitHub token,
 * then exactly one Vercel read with the staging token for the host step 2
 * verified. `fetchImpl` is injectable so tests can check call order and which
 * host receives which credential.
 */
export async function resolveFromApis(env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY_FULL;
  const expectedSha = lower(env.EXPECTED_SHA);
  const prNumber = Number(env.PR_NUMBER);
  if (!env.STAGING_VERCEL_TOKEN || !env.STAGING_VERCEL_PROJECT_ID || !env.STAGING_VERCEL_ORG_ID) {
    throw new SelectionError("STAGING_VERCEL_CONFIG_MISSING");
  }

  const gh = async (apiPath) => {
    const res = await fetchImpl(`https://api.github.com${apiPath}`, {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new SelectionError("GITHUB_API_FAILED", String(res.status));
    return res.json();
  };

  const pr = await gh(`/repos/${repository}/pulls/${prNumber}`);
  // Validate the PR before spending any credentialed Vercel call.
  assertPullRequest(pr, { repository, expectedSha, prNumber });

  const deployments = await gh(`/repos/${repository}/deployments?sha=${expectedSha}&per_page=100`);
  const statusesById = {};
  for (const d of deployments) {
    if (d?.environment === STAGING_PREVIEW_ENVIRONMENT) {
      statusesById[d.id] = await gh(
        `/repos/${repository}/deployments/${d.id}/statuses?per_page=100`,
      );
    }
  }
  const { origin } = selectGithubDeployment(deployments, statusesById, { expectedSha });
  const host = new URL(origin).hostname;

  const res = await fetchImpl(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(host)}?teamId=${encodeURIComponent(env.STAGING_VERCEL_ORG_ID)}`,
    { headers: { Authorization: `Bearer ${env.STAGING_VERCEL_TOKEN}` } },
  );
  if (!res.ok) throw new SelectionError("VERCEL_API_FAILED", String(res.status));
  const vercel = await res.json();

  return resolveStagingPreview({
    repository,
    expectedSha,
    prNumber,
    pr,
    deployments,
    statusesById,
    stagingProjectId: env.STAGING_VERCEL_PROJECT_ID,
    vercelDeploymentFor: (h) => (h === host ? vercel : null),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resolveFromApis(process.env)
    .then((origin) => process.stdout.write(origin))
    .catch((error) => {
      // Codes only: never echo API bodies, tokens, or URLs.
      console.error(error instanceof SelectionError ? error.message : "RESOLVER_FAILED");
      process.exit(1);
    });
}
