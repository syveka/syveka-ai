import { describe, expect, it, vi } from "vitest";
import {
  createPinnedRequestOptions,
  fetchPublicUrl,
  isPublicIpAddress,
  MAX_URL_RESPONSE_BYTES,
  type PinnedRequest,
  type PinnedResponse,
} from "@/server/security/url-ingestion";

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };

function response(status: number, headers: Record<string, string> = {}, body = ""): PinnedResponse {
  return {
    status,
    headers: new Headers(headers),
    body: body
      ? (async function* () {
          yield Buffer.from(body);
        })()
      : null,
    cancel: vi.fn(),
  };
}

describe("public IP classification", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "64:ff9b::1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:192.168.1.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );
});

describe("pinned URL ingestion", () => {
  it("pins the socket to the validated IP and preserves Host and TLS SNI", async () => {
    const lookup = vi.fn(async () => [PUBLIC_V4]);
    const request = vi.fn<PinnedRequest>(async (url, pinned) => {
      expect(pinned).toEqual(PUBLIC_V4);
      const options = createPinnedRequestOptions(url, pinned);
      expect(options.hostname).toBe(PUBLIC_V4.address);
      expect(options.headers).toMatchObject({ Host: "example.com" });
      expect((options as typeof options & { servername?: string }).servername).toBe("example.com");
      return response(200, { "content-type": "text/plain" }, "safe");
    });

    await expect(
      fetchPublicUrl("https://example.com/report", { lookup, request }),
    ).resolves.toMatchObject({ body: Buffer.from("safe") });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("defeats DNS rebinding by never performing a connection-time DNS lookup", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const uncontrolledConnectionLookup = vi.fn(() => ({ address: "127.0.0.1", family: 4 }));
    const request = vi.fn<PinnedRequest>(async (_url, pinned) => {
      expect(pinned.address).toBe(PUBLIC_V4.address);
      // The real transport connects to `pinned.address`; no hostname lookup hook exists here.
      expect(uncontrolledConnectionLookup).not.toHaveBeenCalled();
      return response(200, { "content-type": "text/plain" }, "safe");
    });

    await fetchPublicUrl("https://example.com", { lookup, request });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(uncontrolledConnectionLookup).not.toHaveBeenCalled();
  });

  it("validates every DNS answer and rejects mixed public/private results", async () => {
    const lookup = vi.fn(async () => [PUBLIC_V4, { address: "10.0.0.8", family: 4 }]);
    const request = vi.fn<PinnedRequest>();
    await expect(fetchPublicUrl("https://example.com", { lookup, request })).rejects.toMatchObject({
      code: "blocked_destination",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("re-resolves and rejects a redirect that rebinds to a private address", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce([{ address: "192.168.1.5", family: 4 }]);
    const request = vi
      .fn<PinnedRequest>()
      .mockResolvedValueOnce(response(302, { location: "https://example.com/private" }));

    await expect(
      fetchPublicUrl("https://example.com/start", { lookup, request }),
    ).rejects.toMatchObject({ code: "blocked_destination" });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["http://localhost/admin", "http://10.0.0.8/private"])(
    "rejects hostname or literal private destination: %s",
    async (url) => {
      const lookup = vi.fn(async () => [PUBLIC_V4]);
      const request = vi.fn<PinnedRequest>();
      await expect(fetchPublicUrl(url, { lookup, request })).rejects.toMatchObject({
        code: "blocked_destination",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects the cloud metadata endpoint", async () => {
    const request = vi.fn<PinnedRequest>();
    await expect(
      fetchPublicUrl("http://169.254.169.254/latest/meta-data", { request }),
    ).rejects.toMatchObject({ code: "blocked_destination" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized URL response before reading its body", async () => {
    const oversized = response(200, {
      "content-type": "text/plain",
      "content-length": String(MAX_URL_RESPONSE_BYTES + 1),
    });
    const request = vi.fn<PinnedRequest>().mockResolvedValue(oversized);
    await expect(
      fetchPublicUrl("https://example.com/large", {
        lookup: vi.fn(async () => [PUBLIC_V4]),
        request,
      }),
    ).rejects.toMatchObject({ code: "oversized_response" });
    expect(oversized.cancel).toHaveBeenCalled();
  });
});
