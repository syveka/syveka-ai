import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  buildDockerArgs,
  CONTAINER_LABEL,
  resolveMountPath,
  runWorker,
} from "../../experiments/hyperframes-render-worker/scripts/run-worker.mjs";
import {
  expectedOutputNames,
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
  const args = buildDockerArgs({ inputDir: "/host/in", jobsRoot: "/host" });

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
    expect(args).not.toContain("/output");
  });

  it("is never privileged, and passes no environment or host namespace", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(/--privileged|--env|-e |--pid=host|--ipc=host|docker\.sock/);
    expect(joined).not.toMatch(/\.claude|\.codex|\.grok|credentials/);
  });
});

describe("host-side mount and deadline rules", () => {
  const safe = (path: string, jobsRoot: string | undefined = "/jobs") =>
    resolveMountPath(path, { jobsRoot, home: "/home/someone" });

  it.each([
    ["the home directory", "/home/someone"],
    ["a parent of the home directory", "/home"],
    ["a relative path", "inputs"],
    ["a comma that could add mount options", "/jobs/a,target=/etc"],
    ["a credentials directory", "/jobs/x/.claude"],
    ["a credentials directory in another case", "/jobs/x/.SSH"],
    ["a Windows profile folder", "/jobs/AppData/Local"],
    ["a network path", "//server/share/jobs"],
    ["a long-form Windows path", "\\\\?\\C:\\Users\\someone"],
    ["a directory outside the jobs root", "/etc"],
    ["a sibling sharing the root's prefix", "/jobs-other/1"],
  ])("refuses %s as the input mount", (_label, path) => {
    expect(() => safe(path)).toThrow("unsafe_mount_path");
  });

  it("fails closed when no jobs root is configured", () => {
    expect(() => resolveMountPath("/jobs/1", { home: "/home/someone" })).toThrow(
      "unsafe_mount_path",
    );
  });

  it("accepts a directory inside the jobs root", () => {
    expect(() => safe("/jobs/1")).not.toThrow();
  });

  it("buildDockerArgs refuses an unsafe mount rather than starting", () => {
    expect(() => buildDockerArgs({ inputDir: "/jobs/a,target=/etc", jobsRoot: "/jobs" })).toThrow();
  });

  it("mounts the resolved path, so a link can't be swapped in after the check", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hf-root-"));
    try {
      const real = path.join(root, "real");
      mkdirSync(real);
      const link = path.join(root, "link");
      symlinkSync(real, link, "junction");
      const args = buildDockerArgs({ inputDir: link, jobsRoot: root });
      const mount = args.find((arg) => arg.startsWith("--mount="));
      expect(mount).toContain(realpathSync(real));
      expect(mount).not.toContain("link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a link that leaves the jobs root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hf-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "hf-outside-"));
    try {
      const link = path.join(root, "link");
      symlinkSync(outside, link, "junction");
      expect(() => buildDockerArgs({ inputDir: link, jobsRoot: root })).toThrow(
        "unsafe_mount_path",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("reading the worker's output on the host", () => {
  const dirs: string[] = [];
  const NAME = "job-0-product-ad-ar-9x16.mp4";
  const NAME_2 = "job-1-product-ad-fi-9x16.mp4";

  function reader(expected: string[] | null = [NAME]) {
    const dir = mkdtempSync(path.join(tmpdir(), "hf-output-"));
    dirs.push(dir);
    return { dir, output: new WorkerOutputReader(dir, expected) };
  }

  const sha = (content: string) => createHash("sha256").update(content).digest("hex");
  const item = (index: number, file: string, content: string) => ({
    index,
    ok: true,
    file,
    sha256: sha(content),
    sizeBytes: Buffer.byteLength(content),
  });
  const resultLine = (...results: unknown[]) =>
    `RESULT ${JSON.stringify({ ok: true, jobId: "job", results })}\n`;

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file and confirms its hash, however the stream is split", () => {
    const { dir, output } = reader();
    const stream = Buffer.from(`FILE ${NAME} 5\nhello${resultLine(item(0, NAME, "hello"))}`);
    for (let i = 0; i < stream.length; i += 3) output.push(stream.subarray(i, i + 3));
    const result = output.finish();
    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({ hostVerified: true, sizeBytes: 5 });
    expect(readdirSync(dir)).toEqual([NAME]);
    expect(readFileSync(path.join(dir, NAME), "utf8")).toBe("hello");
  });

  it("marks a file whose hash doesn't match what the worker claimed, and deletes it", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${resultLine(item(0, NAME, "other"))}`));
    const result = output.finish();
    expect(result.ok).toBe(false);
    expect(result.results?.[0]).toMatchObject({ ok: false, error: { code: "output_unverified" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("doesn't let a forged result claim a file that never arrived", () => {
    const { output } = reader();
    output.push(Buffer.from(resultLine(item(0, NAME, "hello"))));
    expect(output.finish().ok).toBe(false);
  });

  it("doesn't let one real file answer for two renders", () => {
    const { dir, output } = reader([NAME, NAME_2]);
    const claim = item(0, NAME, "hello");
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${resultLine(claim, { ...claim, index: 1 })}`));
    const result = output.finish();
    expect(result.ok).toBe(false);
    expect(result.results?.[0]?.ok).toBe(true);
    expect(result.results?.[1]?.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  it("doesn't accept renders reported out of order", () => {
    const { output } = reader([NAME, NAME_2]);
    output.push(
      Buffer.from(
        `FILE ${NAME} 1\naFILE ${NAME_2} 1\nb${resultLine(item(1, NAME_2, "b"), item(0, NAME, "a"))}`,
      ),
    );
    expect(output.finish().ok).toBe(false);
  });

  it("refuses a valid-looking file the job didn't ask for", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME_2} 5\nhello`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_name_refused" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses the same file twice", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 1\naFILE ${NAME} 1\nb`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_name_refused" } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("deletes a delivered file that no render claims", () => {
    const { dir, output } = reader([NAME, NAME_2]);
    output.push(
      Buffer.from(
        `FILE ${NAME} 1\naFILE ${NAME_2} 1\nb${resultLine(item(0, NAME, "a"), { index: 1, ok: false, error: { code: "render_failed" } })}`,
      ),
    );
    const result = output.finish();
    expect(result.ok).toBe(false);
    expect(result.results?.[1]).toMatchObject({ error: { code: "render_failed" } });
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  it("accepts exactly one result, at the very end", () => {
    const late = reader();
    late.output.push(Buffer.from(`${resultLine(item(0, NAME, "a"))}FILE ${NAME} 1\na`));
    expect(late.output.finish()).toEqual({ ok: false, error: { code: "output_malformed" } });
    const twice = reader();
    const line = resultLine(item(0, NAME, "a"));
    twice.output.push(Buffer.from(`FILE ${NAME} 1\na${line}${line}`));
    expect(twice.output.finish()).toEqual({ ok: false, error: { code: "output_malformed" } });
    expect(readdirSync(twice.dir)).toEqual([]);
  });

  it("limits everything that isn't file content, across lines", () => {
    const { output } = reader();
    const padding = "x".repeat(700_000);
    output.push(Buffer.from(`RESULT {"a":"${padding}"}\n`));
    expect(output.failure).toBeNull();
    const second = reader();
    second.output.push(Buffer.from(`RESULT {"a":"${"x".repeat(1_100_000)}"}\n`));
    expect(second.output.failure).toBe("output_header_too_long");
    const unterminated = reader();
    unterminated.output.push(Buffer.alloc(1_100_000, 0x61));
    expect(unterminated.output.failure).toBe("output_header_too_long");
  });

  it("passes on the worker's numbers as claims only, with nothing nested or oversized", () => {
    const { output } = reader();
    const claim = {
      ...item(0, NAME, "hello"),
      video: { codec: "h264", frames: 300, width: "../../x" },
      timings: { renderMs: 1, attacker: "x".repeat(1000) },
    };
    const nested = `${"[".repeat(500)}"deep"${"]".repeat(500)}`;
    const line = resultLine(claim).replace('"codec":"h264"', `"codec":"h264","extra":${nested}`);
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${line}`));
    const result = output.finish() as unknown as {
      results: Array<{ sizeBytes: number; workerClaims: unknown }>;
    };
    expect(result.results[0]?.sizeBytes).toBe(5);
    expect(result.results[0]?.workerClaims).toMatchObject({
      video: { codec: "h264", frames: 300 },
      timings: { renderMs: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("../../x");
    expect(JSON.stringify(result)).not.toContain("attacker");
    expect(JSON.stringify(result)).not.toContain("deep");
  });

  it("doesn't let a claimed size differ from the bytes received", () => {
    const { output } = reader();
    output.push(
      Buffer.from(
        `FILE ${NAME} 5\nhello${resultLine({ ...item(0, NAME, "hello"), sizeBytes: 1 })}`,
      ),
    );
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

  it("nothing succeeds when the job itself couldn't be read", () => {
    const { output } = reader(null);
    output.push(Buffer.from(`FILE ${NAME} 5\nhello${resultLine(item(0, NAME, "hello"))}`));
    expect(output.finish()).toEqual({ ok: false, error: { code: "output_malformed" } });
  });

  it("passes on a rejected job's known code and field paths, but nothing else", () => {
    const { output } = reader();
    const forged = { ok: false, error: { code: "invalid_job", fields: ["renders.0"], extra: "x" } };
    output.push(Buffer.from(`RESULT ${JSON.stringify(forged)}\n`));
    expect(output.finish()).toEqual({
      ok: false,
      error: { code: "invalid_job", fields: ["renders.0"] },
    });
  });

  it("doesn't pass on an error code the worker doesn't have", () => {
    const { output } = reader();
    output.push(Buffer.from(`RESULT ${JSON.stringify({ ok: false, error: { code: "paid" } })}\n`));
    expect(output.finish().error?.code).toBe("output_malformed");
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

  it("caps the job's total across announced files", () => {
    const { output } = reader(null);
    // Each file is announced at the limit, and the sixth would pass the job's total.
    for (let i = 0; i < 6 && !output.failure; i++) {
      output.push(Buffer.from(`FILE job-${i}-product-ad-ar-9x16.mp4 ${MAX_FILE_BYTES}\n`));
      const current = (output as unknown as { current: { remaining: number } | null }).current;
      if (current) {
        current.remaining = 1;
        output.push(Buffer.from("x"));
      }
    }
    expect(output.failure).toBe("output_too_large");
  });

  it("keeps a partial file out from under its final name, and removes it", () => {
    const { dir, output } = reader();
    output.push(Buffer.from(`FILE ${NAME} 100\nhello`));
    expect(readdirSync(dir)).toEqual([`${NAME}.part`]);
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

  it("computes expected names from the job, and refuses a job with unsafe fields", () => {
    const job = {
      jobId: "job",
      renders: [{ template: "product-ad", language: "ar", aspectRatio: "9:16" }],
    };
    expect(expectedOutputNames(job)).toEqual([NAME]);
    expect(
      expectedOutputNames({ ...job, renders: [{ ...job.renders[0], template: "../../x" }] }),
    ).toBeNull();
    expect(expectedOutputNames({ jobId: "job" })).toBeNull();
  });

  it("uses the same output naming as the worker", () => {
    const source = readFileSync(path.join(WORKER_ROOT, "src/main.mjs"), "utf8");
    expect(source).toContain(
      '`${parsed.job.jobId}-${index}-${spec.template}-${spec.language}-${spec.aspectRatio.replace(":", "x")}.mp4`',
    );
  });
});

describe("running a job, with docker faked", () => {
  const dirs: string[] = [];
  const JOB = Buffer.from(
    JSON.stringify({
      jobId: "job",
      renders: [{ template: "product-ad", language: "ar", aspectRatio: "9:16" }],
    }),
  );

  /** A stand-in for `docker run` and `docker kill`, recording what was started. */
  function fakeDocker(options: { killCode?: number; killErrors?: boolean; throws?: boolean } = {}) {
    const started: string[][] = [];
    const runChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
      kill: vi.fn(),
    });
    const spawnProcess = ((_: string, args: string[]) => {
      if (options.throws) throw new Error("spawn failed");
      started.push(args);
      if (args[0] === "run") return runChild;
      const killChild = new EventEmitter();
      setImmediate(() => {
        if (options.killErrors) killChild.emit("error", new Error("no docker"));
        else killChild.emit("close", options.killCode ?? 0);
      });
      return killChild;
    }) as unknown as NonNullable<Parameters<typeof runWorker>[0]["spawnProcess"]>;
    return { spawnProcess, runChild, started };
  }

  function run(
    spawnProcess: NonNullable<Parameters<typeof runWorker>[0]["spawnProcess"]>,
    extra = {},
  ) {
    const root = mkdtempSync(path.join(tmpdir(), "hf-run-"));
    dirs.push(root);
    const inputDir = path.join(root, "in");
    mkdirSync(inputDir);
    return {
      outputDir: path.join(root, "out"),
      result: runWorker({
        job: JOB,
        inputDir,
        jobsRoot: root,
        outputDir: path.join(root, "out"),
        spawnProcess,
        ...extra,
      }),
    };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("kills the container at the deadline, reports it, and leaves no partial file", async () => {
    const docker = fakeDocker();
    const { result, outputDir } = run(docker.spawnProcess, { deadlineMs: 10, forceStopMs: 5000 });
    docker.runChild.stdout.emit(
      "data",
      Buffer.from("FILE job-0-product-ad-ar-9x16.mp4 100\nhello"),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(docker.started.some((args) => args[0] === "kill")).toBe(true);
    docker.runChild.emit("close", 137);
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "job_deadline_exceeded" },
    });
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("still answers, and says so, when the kill fails and the client never exits", async () => {
    const docker = fakeDocker({ killCode: 1 });
    const { result } = run(docker.spawnProcess, { deadlineMs: 5, forceStopMs: 20 });
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "container_may_be_running" },
    });
    expect(docker.runChild.kill).toHaveBeenCalledWith("SIGKILL");
    // Tried again after the first kill failed.
    expect(docker.started.filter((args) => args[0] === "kill").length).toBe(2);
  });

  it("kills once on a broken stream, however many chunks follow", async () => {
    const docker = fakeDocker();
    const { result } = run(docker.spawnProcess);
    for (let i = 0; i < 5; i++) docker.runChild.stdout.emit("data", Buffer.from("garbage\n"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(docker.started.filter((args) => args[0] === "kill").length).toBe(1);
    docker.runChild.emit("close", 137);
    await expect(result).resolves.toEqual({ ok: false, error: { code: "output_malformed" } });
  });

  it("reports a missing docker client, whether it throws or emits", async () => {
    const thrown = fakeDocker({ throws: true });
    await expect(run(thrown.spawnProcess).result).resolves.toEqual({
      ok: false,
      error: { code: "docker_unavailable" },
    });
    const emitted = fakeDocker();
    const { result } = run(emitted.spawnProcess);
    emitted.runChild.emit("error", new Error("ENOENT"));
    await expect(result).resolves.toEqual({ ok: false, error: { code: "docker_unavailable" } });
  });

  it("survives a kill that can't start", async () => {
    const docker = fakeDocker({ killErrors: true });
    const { result } = run(docker.spawnProcess, { deadlineMs: 5, forceStopMs: 20 });
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "container_may_be_running" },
    });
  });

  it("sends the job on stdin, not in the arguments", async () => {
    const docker = fakeDocker();
    const { result } = run(docker.spawnProcess);
    expect(JSON.stringify(docker.started[0])).not.toContain("product-ad");
    docker.runChild.emit("close", 1);
    await result;
  });

  it("labels containers so an orphan can be found, and never pulls an image", async () => {
    const docker = fakeDocker();
    const { result } = run(docker.spawnProcess);
    expect(docker.started[0]).toContain(`--label=${CONTAINER_LABEL}`);
    expect(docker.started[0]).toContain("--pull=never");
    docker.runChild.emit("close", 1);
    await result;
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
    expect(dockerfile).toMatch(/CHROME_SHA256=[0-9a-f]{64}/);
    expect(dockerfile).toContain('echo "$CHROME_SHA256  /tmp/chrome.zip" | sha256sum -c -');
    expect(dockerfile).not.toContain("npx --yes");
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
