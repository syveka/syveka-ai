import { describe, expect, it, vi } from "vitest";
import { fetchPublicUrl, MAX_URL_RESPONSE_BYTES } from "@/server/security/url-ingestion";

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

describe("secure URL ingestion", () => {
  it.each(["http://localhost/admin", "http://10.0.0.8/private"])(
    "rejects localhost or a private IP: %s",
    async (url) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        fetchPublicUrl(url, { lookup: publicLookup, fetch: request }),
      ).rejects.toMatchObject({
        code: "blocked_destination",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("revalidates a redirect and rejects a private destination", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://192.168.1.5/secret" } }),
      );

    await expect(
      fetchPublicUrl("https://example.com/start", { lookup: publicLookup, fetch: request }),
    ).rejects.toMatchObject({ code: "blocked_destination" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects the cloud metadata endpoint", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      fetchPublicUrl("http://169.254.169.254/latest/meta-data", {
        lookup: publicLookup,
        fetch: request,
      }),
    ).rejects.toMatchObject({ code: "blocked_destination" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized URL response before reading its body", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("small placeholder", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_URL_RESPONSE_BYTES + 1),
        },
      }),
    );

    await expect(
      fetchPublicUrl("https://example.com/large", { lookup: publicLookup, fetch: request }),
    ).rejects.toMatchObject({ code: "oversized_response" });
  });
});
