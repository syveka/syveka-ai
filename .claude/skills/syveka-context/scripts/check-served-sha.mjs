#!/usr/bin/env node
// Read-only: GETs <origin>/api/health for each origin and compares the served
// build SHA with the expected one. Never sends credentials or mutating requests.
//
// Usage: node check-served-sha.mjs <expected-sha|-> <origin> [origin...]
//   expected-sha "-" just reports what each origin serves.
// Exit: 0 all match (or report-only), 1 mismatch/unhealthy/unreachable, 2 bad usage.

const [expected, ...origins] = process.argv.slice(2);

if (!expected || origins.length === 0 || (expected !== "-" && !/^[0-9a-f]{40}$/.test(expected))) {
  process.stderr.write(
    "usage: check-served-sha.mjs <40-char-sha|-> <https://origin> [https://origin...]\n",
  );
  process.exit(2);
}

async function probe(origin) {
  let url;
  try {
    url = new URL("/api/health", origin);
  } catch {
    return { origin, error: "invalid origin" };
  }
  if (url.username || url.password) return { origin, error: "origin must not contain credentials" };
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    return {
      origin: url.origin,
      http: res.status,
      status: body?.status ?? "unparseable",
      checks: body?.checks ?? null,
      build: body?.build ?? "missing",
    };
  } catch (err) {
    return { origin: url.origin, error: err instanceof Error ? err.name : "request failed" };
  }
}

const results = await Promise.all(origins.map(probe));
let ok = true;
for (const r of results) {
  if (r.error) {
    ok = false;
    console.log(`FAIL  ${r.origin}  ${r.error}`);
    continue;
  }
  const shaMatch = expected === "-" || r.build === expected;
  const healthy = r.http === 200 && r.status === "healthy";
  if (!shaMatch || (expected !== "-" && !healthy)) ok = false;
  const verdict = expected === "-" ? "INFO" : shaMatch && healthy ? "PASS" : "FAIL";
  console.log(
    `${verdict}  ${r.origin}  http=${r.http} status=${r.status} checks=${JSON.stringify(r.checks)} ` +
      `served=${r.build}${expected === "-" ? "" : ` expected=${expected} match=${shaMatch}`}`,
  );
}
process.exit(ok ? 0 : 1);
