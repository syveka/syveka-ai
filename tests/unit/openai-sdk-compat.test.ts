import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OpenAI integration against the real `openai` SDK (v6), with only the
 * network replaced: what each call sends, how the reply is read, and that a
 * transcription makes exactly one attempt. No request leaves the process,
 * on any SDK version: the SDK is pointed at a `.invalid` host (RFC 2606), so
 * a request the stub misses can't resolve, and the file refuses to run at all
 * on an SDK older than v6, which sends through its own bundled fetch rather
 * than the stubbed global one (openai 4.x did, and reached the network).
 */

const BASE_URL = vi.hoisted(() => {
  const url = "https://api.openai.invalid/v1";
  vi.stubEnv("OPENAI_BASE_URL", url);
  return url;
});

/** Provider replies, in order. The SDK's own `data:` probe (FormData support) is answered locally. */
const replies = vi.hoisted(() => [] as Response[]);
const fetchMock = vi.hoisted(() =>
  vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url).startsWith("data:")) return new Response("");
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request to ${String(url)}`);
    return reply;
  }),
);
vi.stubGlobal("fetch", fetchMock);

import { VERSION as OPENAI_SDK_VERSION } from "openai/version";
import { embed, isFlaggedByModeration, transcribeAudio } from "@/server/integrations/openai";

if (Number(OPENAI_SDK_VERSION.split(".")[0]) < 6) {
  throw new Error(
    `openai ${OPENAI_SDK_VERSION} doesn't send through the stubbed fetch; refusing to run`,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The calls that reached the provider (not the SDK's local probe). */
function apiCalls() {
  return fetchMock.mock.calls.filter(([url]) => !String(url).startsWith("data:"));
}

function lastRequest() {
  const [url, init = {}] = apiCalls().at(-1)!;
  return { url: String(url), init, headers: new Headers(init.headers) };
}

/** The SDK asks for base64 embeddings (float32, little-endian) and decodes them itself. */
function base64Floats(values: number[]) {
  return Buffer.from(new Float32Array(values).buffer).toString("base64");
}

afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  fetchMock.mockClear();
  replies.length = 0;
});

describe("OpenAI SDK v6 compatibility", () => {
  it("embeds a batch and returns the vectors in input order", async () => {
    replies.push(
      json({
        object: "list",
        data: [
          { object: "embedding", index: 1, embedding: base64Floats([0.5, 0.25]) },
          { object: "embedding", index: 0, embedding: base64Floats([1, -1]) },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    );
    await expect(embed(["a", "b"])).resolves.toEqual([
      [1, -1],
      [0.5, 0.25],
    ]);

    const { url, init, headers } = lastRequest();
    expect(url).toBe(`${BASE_URL}/embeddings`);
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer test-openai-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "text-embedding-3-small",
      input: ["a", "b"],
      dimensions: 1536,
      encoding_format: "base64",
    });
  });

  it("sends audio as a named multipart file and reads the text", async () => {
    replies.push(json({ text: "  hello there  " }));
    await expect(transcribeAudio(new Uint8Array([1, 2, 3]), "webm")).resolves.toBe("hello there");

    const { url, init } = lastRequest();
    expect(url).toBe(`${BASE_URL}/audio/transcriptions`);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("makes exactly one transcription attempt when the provider fails", async () => {
    replies.push(
      json({ error: { message: "upstream" } }, 500),
      json({ error: { message: "upstream" } }, 500),
    );
    await expect(transcribeAudio(new Uint8Array([1]), "webm")).rejects.toThrow();
    expect(apiCalls()).toHaveLength(1);
  });

  it("reports flagged content from a moderation result", async () => {
    replies.push(
      json({ id: "modr-1", model: "omni-moderation-latest", results: [{ flagged: true }] }),
    );
    await expect(isFlaggedByModeration("x".repeat(40_000))).resolves.toBe(true);

    const { url, init } = lastRequest();
    expect(url).toBe(`${BASE_URL}/moderations`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("omni-moderation-latest");
    expect(body.input).toHaveLength(30_000);
  });

  it("reports unflagged content as not flagged", async () => {
    replies.push(
      json({ id: "modr-2", model: "omni-moderation-latest", results: [{ flagged: false }] }),
    );
    await expect(isFlaggedByModeration("hello")).resolves.toBe(false);
  });
});
