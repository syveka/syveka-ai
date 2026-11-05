import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  toErrorResult,
  WorkerError,
} from "../../experiments/hyperframes-render-worker/src/errors.mjs";
import { childEnvironment } from "../../experiments/hyperframes-render-worker/src/hyperframes.mjs";
import { sniffMediaType } from "../../experiments/hyperframes-render-worker/src/media.mjs";
import {
  serializeForHtmlScript,
  writeProject,
} from "../../experiments/hyperframes-render-worker/src/project.mjs";
import {
  contrastRatio,
  MAX_RENDERS_PER_JOB,
  parseJob,
} from "../../experiments/hyperframes-render-worker/src/schema.mjs";
import {
  assertSafeMountPath,
  buildDockerArgs,
  JOB_DEADLINE_MS,
} from "../../experiments/hyperframes-render-worker/scripts/run-worker.mjs";
import {
  MAX_FILE_BYTES,
  WorkerOutputReader,
} from "../../experiments/hyperframes-render-worker/scripts/read-output.mjs";
import {
  toWorkerSpec,
  UnsupportedTemplateRequestError,
  type TemplateRenderRequest,
} from "../../experiments/hyperframes-render-worker/integration/creator-template-renderer";

const WORKER_ROOT = path.resolve(__dirname, "../../experiments/hyperframes-render-worker");

const COLORS = {
  background: "#0b1f33",
  text: "#ffffff",
  accent: "#ffd166",
  accentText: "#10202f",
};

function spec(overrides: Record<string, unknown> = {}) {
  return {
    template: "product-ad",
    language: "fi",
    aspectRatio: "9:16",
    brand: "Pohjantuuli",
    headline: "Hammaslääkäri lähellä sinua",
    callToAction: "Varaa aika",
    colors: COLORS,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return { jobId: "job-1", renders: [spec(overrides)] };
}

/** The rejected field, or null if the job was accepted. */
function rejectedFields(input: unknown): string[] | null {
  const parsed = parseJob(input);
  return parsed.ok ? null : parsed.fields;
}

describe("render job schema", () => {
  it("accepts every template, language and aspect ratio", () => {
    for (const template of ["product-ad", "local-service", "social-announcement"]) {
      for (const language of ["fi", "en", "ar"]) {
        for (const aspectRatio of ["9:16", "1:1", "16:9"]) {
          expect(rejectedFields(job({ template, language, aspectRatio }))).toBeNull();
        }
      }
    }
  });

  it.each([
    ["an unknown template", { template: "../../etc/passwd" }, "renders.0.template"],
    ["an unknown language", { language: "de" }, "renders.0.language"],
    ["free-form dimensions", { aspectRatio: "100000:1" }, "renders.0.aspectRatio"],
    ["an unknown field", { html: "<script>alert(1)</script>" }, "renders.0"],
    ["an empty headline", { headline: "   " }, "renders.0.headline"],
    ["an oversized headline", { headline: "x".repeat(91) }, "renders.0.headline"],
    [
      "a CSS payload as a color",
      { colors: { ...COLORS, accent: "red;background:url(//x)" } },
      "renders.0.colors.accent",
    ],
  ])("rejects %s", (_label, overrides, field) => {
    expect(rejectedFields(job(overrides))).toContain(field);
  });

  it.each([
    ["a path traversal", "../secret.png"],
    ["an absolute path", "/etc/passwd.png"],
    ["a Windows path", "C:\\secret.png"],
    ["a URL", "https://example.com/a.png"],
    ["a file URL", "file:///etc/passwd"],
    ["a hidden file", ".env.png"],
    ["an SVG, which can run script", "logo.svg"],
    ["a nested path", "a/b.png"],
    ["a null byte", "a\u0000.png"],
  ])("rejects %s as a file name", (_label, file) => {
    expect(rejectedFields(job({ logo: file }))).toContain("renders.0.logo");
    expect(rejectedFields(job({ media: { kind: "image", file } }))).toContain(
      "renders.0.media.file",
    );
  });

  it.each([
    ["a right-to-left override", "safe\u202Eevil"],
    ["a bidi isolate", "safe\u2066evil"],
    ["a line separator", "safe\u2028evil"],
    ["a control character", "safe\u0007evil"],
    ["a newline", "safe\nevil"],
  ])("rejects %s in on-screen text", (_label, headline) => {
    expect(rejectedFields(job({ headline }))).toContain("renders.0.headline");
  });

  it("keeps Arabic and Finnish text, including Arabic marks, unchanged", () => {
    const headline = "مشغّل أعمالك بالذكاء الاصطناعي";
    const parsed = parseJob(job({ language: "ar", headline }));
    expect(parsed.ok && parsed.job.renders[0]).toMatchObject({ headline });
    expect(rejectedFields(job({ headline: "Hyvää päivää, Äänekoski" }))).toBeNull();
  });

  it("refuses unreadable color pairs", () => {
    expect(rejectedFields(job({ colors: { ...COLORS, text: "#10253a" } }))).toContain(
      "renders.0.colors.text",
    );
    expect(rejectedFields(job({ colors: { ...COLORS, accentText: "#ffd166" } }))).toContain(
      "renders.0.colors.accentText",
    );
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("requires a logo with transparency support and a matching media kind", () => {
    expect(rejectedFields(job({ logo: "logo.jpg" }))).toContain("renders.0.logo");
    expect(rejectedFields(job({ media: { kind: "video", file: "a.png" } }))).toContain(
      "renders.0.media.file",
    );
    expect(rejectedFields(job({ media: { kind: "image", file: "a.mp4" } }))).toContain(
      "renders.0.media.file",
    );
  });

  it("caps the renders in a job, so one job can't queue unbounded work", () => {
    const renders = Array.from({ length: MAX_RENDERS_PER_JOB + 1 }, () => spec());
    expect(rejectedFields({ jobId: "a", renders })).toContain("renders");
    expect(rejectedFields({ jobId: "a", renders: [] })).toContain("renders");
  });

  it("rejects a job id that could become a path", () => {
    for (const jobId of ["../x", "a/b", "A", "", "x".repeat(49)]) {
      expect(rejectedFields({ jobId, renders: [spec()] })).toContain("jobId");
    }
  });

  it("reports field paths, never the submitted value", () => {
    const parsed = parseJob(job({ template: "SECRET-VALUE" }));
    expect(JSON.stringify(parsed)).not.toContain("SECRET-VALUE");
  });
});

describe("structured errors", () => {
  it("exposes only the stable code and message", () => {
    const result = toErrorResult(new WorkerError("render_failed"));
    expect(result).toEqual({
      ok: false,
      error: { code: "render_failed", message: "The renderer could not produce a video." },
    });
  });

  it("hides an unexpected error's text, which could carry paths or secrets", () => {
    const result = toErrorResult(new Error("ENOENT /home/someone/.claude/.credentials.json"));
    expect(result.error.code).toBe("internal_error");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });
});

describe("media sniffing", () => {
  const padded = (bytes: number[]) => Buffer.from([...bytes, ...new Array(12).fill(0)]);

  it("recognises the accepted formats by content", () => {
    expect(sniffMediaType(padded([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(sniffMediaType(padded([0xff, 0xd8, 0xff]))).toBe("jpeg");
    expect(sniffMediaType(Buffer.from("RIFF0000WEBP"))).toBe("webp");
    expect(sniffMediaType(Buffer.from("0000ftypisom"))).toBe("mp4");
  });

  it.each([
    ["SVG", '<svg xmlns="http'],
    ["HTML", "<!doctype html>"],
    ["an HLS playlist, which could fetch", "#EXTM3U\n#EXT-X-"],
    ["a shell script", "#!/bin/sh\ncurl x"],
  ])("refuses %s, whatever its extension", (_label, content) => {
    expect(sniffMediaType(Buffer.from(content))).toBeNull();
  });

  it("refuses a file too short to identify", () => {
    expect(sniffMediaType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("template data injection", () => {
  it("can't close the script tag or open a comment", () => {
    const serialized = serializeForHtmlScript({
      headline: '</script><script>alert(1)</script><!-- & "',
    });
    expect(serialized).not.toMatch(/[<>&]/);
    expect(JSON.parse(serialized).headline).toBe('</script><script>alert(1)</script><!-- & "');
  });

  it("escapes the line separators that end a JavaScript string", () => {
    const serialized = serializeForHtmlScript({ headline: "a\u2028b\u2029c" });
    expect(serialized).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(serialized).headline).toBe("a\u2028b\u2029c");
  });

  describe("written project", () => {
    const dirs: string[] = [];

    /** A throwaway app root with the real templates and placeholder font files. */
    function fixtureRoot() {
      const root = mkdtempSync(path.join(tmpdir(), "hf-worker-"));
      dirs.push(root);
      for (const [family, files] of [
        ["noto-sans", ["noto-sans-latin-400-normal.woff2", "noto-sans-latin-800-normal.woff2"]],
        [
          "noto-sans-arabic",
          ["noto-sans-arabic-arabic-400-normal.woff2", "noto-sans-arabic-arabic-800-normal.woff2"],
        ],
      ] as const) {
        const dir = path.join(root, "node_modules/@fontsource", family, "files");
        mkdirSync(dir, { recursive: true });
        for (const file of files) writeFileSync(path.join(dir, file), "font");
      }
      for (const entry of readdirSync(path.join(WORKER_ROOT, "templates"), { recursive: true })) {
        const from = path.join(WORKER_ROOT, "templates", String(entry));
        const to = path.join(root, "templates", String(entry));
        if (path.extname(from)) {
          mkdirSync(path.dirname(to), { recursive: true });
          writeFileSync(to, readFileSync(from));
        }
      }
      return root;
    }

    let appRoot: string;
    beforeAll(() => {
      appRoot = fixtureRoot();
    }, 120_000);

    afterAll(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }, 120_000);

    function written(overrides: Record<string, unknown> = {}) {
      const projectDir = mkdtempSync(path.join(appRoot, "project-"));
      writeProject({ spec: spec(overrides), projectDir, hasLogo: false, appRoot });
      return { projectDir, html: readFileSync(path.join(projectDir, "index.html"), "utf8") };
    }

    it("leaves no placeholder behind, in any template and aspect ratio", () => {
      for (const template of ["product-ad", "local-service", "social-announcement"]) {
        for (const aspectRatio of ["9:16", "1:1", "16:9"]) {
          const { html } = written({ template, aspectRatio });
          expect(html).not.toMatch(/__[A-Z_]+__|MEDIA_SLOT/);
        }
      }
    }, 120_000);

    it("sets size and direction from fixed values", () => {
      const { html } = written({ language: "ar", aspectRatio: "16:9" });
      expect(html).toContain('dir="rtl"');
      expect(html).toContain('lang="ar"');
      expect(html).toContain('data-width="1920"');
      expect(html).toContain('data-height="1080"');
    });

    it("doesn't let submitted text become markup", () => {
      const { html } = written({ headline: "<img src=x onerror=alert(1)>" });
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("\\u003cimg src=x");
    });

    it("doesn't treat $ sequences in text as replacement patterns", () => {
      const { html } = written({ headline: "Price $& $' $` $1" });
      expect(html).toContain("Price $\\u0026 $' $` $1");
    });

    it("never puts a submitted file name into the page", () => {
      const { html } = written({ media: { kind: "video", file: "attacker-chosen.mp4" } });
      expect(html).toContain('src="assets/media.mp4"');
      expect(html).not.toContain("attacker-chosen");
    });

    it("copies bundled fonts and references nothing on the network", () => {
      const { projectDir, html } = written();
      const assets = readdirSync(path.join(projectDir, "assets"));
      expect(assets).toContain("noto-sans-arabic-arabic-800-normal.woff2");
      expect(assets).toContain("base.css");
      const css = readFileSync(path.join(projectDir, "assets/base.css"), "utf8");
      expect(`${html}${css}`).not.toMatch(/https?:\/\/|\/\/cdn|fonts\.googleapis|jsdelivr/);
    });
  });
});

describe("templates", () => {
  const sources = [
    "shared/base.css",
    "shared/base.js",
    "product-ad/index.html",
    "local-service/index.html",
    "social-announcement/index.html",
  ].map((file) => [file, readFileSync(path.join(WORKER_ROOT, "templates", file), "utf8")] as const);

  it("use no animation library, so no third-party animation licence applies", () => {
    for (const [, source] of sources) {
      expect(source).not.toMatch(/\bgsap\b(?!\s*license)|greensock|anime\.js|lottie/i);
    }
  });

  it("write submitted text only through textContent", () => {
    for (const [, source] of sources) {
      expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    }
  });

  it("never split text into letters, which breaks Arabic joining", () => {
    for (const [, source] of sources) {
      expect(source).not.toMatch(/\.split\(\s*["'`]{2}\s*\)|Array\.from\(.*textContent/);
    }
  });

  it("use logical properties, so layouts mirror in Arabic", () => {
    for (const [, source] of sources) {
      expect(source).not.toMatch(/(margin|padding)-(left|right)|text-align:\s*(left|right)/);
    }
  });
});

describe("container isolation flags", () => {
  const args = buildDockerArgs({ inputDir: "/host/in" });

  it.each([
    "--init",
    "--log-driver=none",
    "--network=none",
    "--read-only",
    "--user=10001:10001",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--ulimit=core=1",
  ])("includes %s", (flag) => {
    expect(args).toContain(flag);
  });

  it("limits CPU and memory, with no swap beyond the memory limit", () => {
    expect(args).toContain("--cpus=4");
    expect(args).toContain("--memory=3g");
    expect(args).toContain("--memory-swap=3g");
  });

  it("makes scratch space non-executable", () => {
    const tmpfs = args.find((arg) => arg.startsWith("--tmpfs="));
    expect(tmpfs).toContain("noexec");
    expect(tmpfs).toContain("nosuid");
  });

  it("mounts only the input, read-only, so nothing inside can write to the host", () => {
    const mounts = args.filter((arg) => arg.startsWith("--mount=") || arg === "-v");
    expect(mounts).toEqual(["--mount=type=bind,source=/host/in,target=/input,readonly"]);
  });

  it("is never privileged, and passes no environment or host namespace", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(/--privileged|--env|-e |--pid=host|--ipc=host|docker\.sock/);
    expect(joined).not.toMatch(/\.claude|\.codex|\.grok|credentials/);
  });
});

describe("host-side mount and deadline rules", () => {
  it.each([
    ["the home directory", "/home/someone"],
    ["a parent of the home directory", "/home"],
    ["a relative path", "inputs"],
    ["a comma that could add mount options", "/tmp/a,target=/etc"],
    ["a credentials directory", "/tmp/x/.claude"],
    ["a credentials directory in another case", "/tmp/x/.SSH"],
    ["a Windows profile folder", "/tmp/AppData/Local"],
    ["a long-form Windows path", "\\\\?\\C:\\Users\\someone"],
    ["an ssh directory", "/tmp/.ssh/keys"],
  ])("refuses %s as the input mount", (_label, path) => {
    expect(() => assertSafeMountPath(path, "/home/someone")).toThrow("unsafe_mount_path");
  });

  it("accepts a specific job directory, even inside the home directory", () => {
    expect(() => assertSafeMountPath("/home/someone/jobs/1", "/home/someone")).not.toThrow();
  });

  it("buildDockerArgs refuses an unsafe mount rather than starting", () => {
    expect(() => buildDockerArgs({ inputDir: "/tmp/a,target=/etc" })).toThrow();
  });

  it("has an outer job deadline", () => {
    expect(JOB_DEADLINE_MS).toBeGreaterThan(0);
    expect(JOB_DEADLINE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe("reading the worker's output on the host", () => {
  const dirs: string[] = [];
  const NAME = "job-0-product-ad-ar-9x16.mp4";

  function reader() {
    const dir = mkdtempSync(path.join(tmpdir(), "hf-output-"));
    dirs.push(dir);
    return { dir, output: new WorkerOutputReader(dir) };
  }

  const sha = (content: string) => createHash("sha256").update(content).digest("hex");
  const resultLine = (file: string, hash: string) =>
    `RESULT ${JSON.stringify({ ok: true, jobId: "job", results: [{ index: 0, ok: true, file, sha256: hash }] })}\n`;

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file and confirms its hash, however the stream is split", () => {
    const { dir, output } = reader();
    const stream = Buffer.from(`FILE ${NAME} 5\nhello${resultLine(NAME, sha("hello"))}`);
    for (let i = 0; i < stream.length; i += 3) output.push(stream.subarray(i, i + 3));
    const result = output.finish();
    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.hostVerified).toBe(true);
    expect(readFileSync(path.join(dir, NAME), "utf8")).toBe("hello");
  });

  it("marks a file whose hash doesn't match what the worker claimed", () => {
    const { output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${resultLine(NAME, sha("other"))}`));
    const result = output.finish();
    expect(result.ok).toBe(false);
    expect(result.results?.[0]).toMatchObject({ ok: false, error: { code: "output_unverified" } });
  });

  it("doesn't let a forged result claim a file that never arrived", () => {
    const { output } = reader();
    output.push(Buffer.from(resultLine(NAME, sha("hello"))));
    expect(output.finish().ok).toBe(false);
  });

  it.each([
    ["no renders", { ok: true, results: [] }],
    ["a path with no hash", { ok: true, results: [{ ok: true, file: "../../x" }] }],
    [
      "a failed render claiming verification",
      { ok: true, results: [{ ok: false, hostVerified: true }] },
    ],
    ["results of the wrong type", { ok: true, results: 5 }],
    ["a null item", { ok: true, results: [null] }],
    ["no results at all", { ok: true }],
  ])("a forged result with %s is not success, and doesn't throw", (_label, forged) => {
    const { output } = reader();
    output.push(Buffer.from(`RESULT ${JSON.stringify(forged)}\n`));
    const result = output.finish();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("../../x");
  });

  it("isn't success when fewer renders report than the job asked for", () => {
    const { output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${resultLine(NAME, sha("hello"))}`));
    expect(output.finish(2).ok).toBe(false);
  });

  it("passes on a rejected job's code and field paths, but nothing else", () => {
    const { output } = reader();
    const forged = { ok: false, error: { code: "invalid_job", fields: ["renders.0"], extra: "x" } };
    output.push(Buffer.from(`RESULT ${JSON.stringify(forged)}\n`));
    expect(output.finish(1)).toEqual({
      ok: false,
      error: { code: "invalid_job", fields: ["renders.0"] },
    });
  });

  it.each([
    ["a traversal", "../../evil.mp4"],
    ["an absolute path", "/etc/cron.d/evil.mp4"],
    ["a Windows path", "..\\evil.mp4"],
    ["another extension", "job-0-product-ad-ar-9x16.exe"],
    ["a bare name", "evil.mp4"],
  ])("refuses %s as a file name, and writes nothing", (_label, name) => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${name} 5\nhello`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_name_refused" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an oversized file before writing any of it", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME} ${MAX_FILE_BYTES + 1}\nhello`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_too_large" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caps the job's total, whatever each file claims", () => {
    const { dir, output } = reader();
    const names = [0, 1, 2, 3, 4, 5].map((i) => `job-${i}-product-ad-ar-9x16.mp4`);
    const header = names.map((name) => `FILE ${name} ${MAX_FILE_BYTES}\n`);
    for (const line of header) {
      output.push(Buffer.from(line));
      // Abandon the announced body by ending this reader's interest in it once it has failed.
      if (output.failure) break;
      (output as unknown as { current: { remaining: number } | null }).current!.remaining = 1;
      output.push(Buffer.from("x"));
    }
    expect(output.failure).toBe("output_too_large");
    expect(readdirSync(dir).length).toBeLessThanOrEqual(5);
  });

  it("removes a file cut short, and reports it", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 100\nhello`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_truncated" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses to overwrite a file that already exists", () => {
    const { dir, output } = reader();
    writeFileSync(path.join(dir, NAME), "existing");
    output.push(Buffer.from(`FILE ${NAME} 5\nhello`));
    expect(output.finish().ok).toBe(false);
    expect(readFileSync(path.join(dir, NAME), "utf8")).toBe("existing");
  });

  it("refuses a malformed stream", () => {
    const { output } = reader();
    output.push(Buffer.from("rm -rf /\n"));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_malformed" } });
  });

  it("reports a stream that ends with no result", () => {
    const { output } = reader();
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_truncated" } });
  });
});

describe("worker child process", () => {
  it("gets an allowlisted environment, with nothing inherited from the container", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-pass");
    vi.stubEnv("FAL_API_KEY", "must-not-pass");
    const env = childEnvironment("/tmp/job");
    expect(Object.values(env)).not.toContain("must-not-pass");
    expect(env.HOME).toBe("/tmp/job");
    expect(env.HYPERFRAMES_NO_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
    vi.unstubAllEnvs();
  });

  it("the source only ever spawns check and render, with no shell", () => {
    const source = readFileSync(path.join(WORKER_ROOT, "src/hyperframes.mjs"), "utf8");
    expect(source).not.toMatch(/shell:\s*true|exec\(|execSync/);
    const commands = source.slice(source.indexOf("const COMMANDS"), source.indexOf("};\n"));
    expect(commands.match(/^\s{2}(\w+):/gm)?.map((line) => line.trim())).toEqual([
      "check:",
      "render:",
    ]);
  });
});

describe("image build", () => {
  const dockerfile = readFileSync(path.join(WORKER_ROOT, "Dockerfile"), "utf8");
  const harden = readFileSync(path.join(WORKER_ROOT, "docker/harden-image.mjs"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(WORKER_ROOT, "package.json"), "utf8"));

  it("pins the base image by digest, FFmpeg by checksum and Chrome by version", () => {
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/FFMPEG_SHA256=[0-9a-f]{64}/);
    expect(dockerfile).toContain("sha256sum -c");
    expect(dockerfile).toMatch(/CHROME_VERSION=\d+\.\d+\.\d+\.\d+/);
  });

  it("pins every direct dependency exactly, and installs from the lockfile", () => {
    for (const version of Object.values(manifest.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(manifest.dependencies.hyperframes).toBe("0.8.225");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("--ignore-scripts");
    expect(existsSync(path.join(WORKER_ROOT, "package-lock.json"))).toBe(true);
  });

  it("deletes the commands that read credentials or reach HeyGen, and the vendored GSAP", () => {
    for (const name of ["usage", "auth", "login", "publish", "cloud", "lambda", "billing"]) {
      expect(harden).toContain(`"${name}"`);
    }
    expect(harden).toContain('"vendor"');
  });

  it("removes download tools and runs as a non-root user", () => {
    expect(dockerfile).toContain("apt-get purge -y --auto-remove curl");
    expect(dockerfile).toContain("/usr/local/bin/npm");
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
  });
});

describe("Creator Studio adapter", () => {
  const request: TemplateRenderRequest = {
    template: "product-ad",
    language: "AR",
    aspectRatio: "9:16",
    brand: "Syveka",
    headline: "عنوان",
    callToAction: "ابدأ",
    colors: COLORS,
    media: {
      kind: "video",
      asset: { storagePath: "org-1/generated/../../other-org/clip.mp4", source: "GENERATED" },
    },
  };

  it("maps a request to a spec the worker's schema accepts", async () => {
    const stage = vi.fn(async () => undefined);
    const mapped = await toWorkerSpec(request, stage);
    expect(rejectedFields({ jobId: "a", renders: [mapped] })).toBeNull();
    expect(mapped.language).toBe("ar");
  });

  it("never passes a storage path to the worker", async () => {
    const stage = vi.fn(async () => undefined);
    const mapped = await toWorkerSpec(request, stage);
    expect(JSON.stringify(mapped)).not.toContain("other-org");
    expect(mapped.media?.file).toBe("media-0.mp4");
    expect(stage).toHaveBeenCalledWith(request.media?.asset, "media-0.mp4");
  });

  it("gives each render in a job its own staged files", async () => {
    const stage = vi.fn(async () => undefined);
    const first = await toWorkerSpec(request, stage, 0);
    const second = await toWorkerSpec(request, stage, 1);
    expect(first.media?.file).not.toBe(second.media?.file);
  });

  it("refuses 4:5 rather than cropping, before staging anything", async () => {
    const stage = vi.fn(async () => undefined);
    await expect(toWorkerSpec({ ...request, aspectRatio: "4:5" }, stage)).rejects.toBeInstanceOf(
      UnsupportedTemplateRequestError,
    );
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("isolation from the product", () => {
  it("nothing under src imports the experiment", () => {
    const srcRoot = path.resolve(__dirname, "../../src");
    const entries = readdirSync(srcRoot, { recursive: true }).map(String);
    for (const entry of entries.filter((file) => /\.(ts|tsx)$/.test(file))) {
      const source = readFileSync(path.join(srcRoot, entry), "utf8");
      expect(source.includes("hyperframes-render-worker"), entry).toBe(false);
    }
  }, 120_000);

  it("adds no dependency to the root package", () => {
    const root = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
    const names = Object.keys({ ...root.dependencies, ...root.devDependencies });
    expect(names).not.toContain("hyperframes");
    expect(names).not.toContain("gsap");
  });
});
