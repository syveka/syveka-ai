import { describe, expect, it } from "vitest";
import { validateUrl } from "../providers/scrapling/url-policy.js";

/**
 * Real SSRF defense evals - no mocking of DNS or the validator itself.
 * `validateUrl` does real `dns.lookup()` calls for hostname cases, so
 * these evals prove the actual resolution + range-check logic, not just
 * that the function was called with the right arguments.
 */
describe("Scrapling provider: URL/SSRF policy", () => {
  it("blocks localhost by hostname", async () => {
    const result = await validateUrl("http://localhost/");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("localhost");
  });

  it("blocks 127.0.0.1 (loopback)", async () => {
    const result = await validateUrl("http://127.0.0.1/");
    expect(result.allowed).toBe(false);
  });

  it("blocks IPv6 loopback ::1", async () => {
    const result = await validateUrl("http://[::1]/");
    expect(result.allowed).toBe(false);
  });

  it("blocks the AWS/GCP/Azure cloud metadata address (link-local range)", async () => {
    const result = await validateUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked range");
  });

  it("blocks RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x)", async () => {
    for (const ip of ["10.0.0.5", "172.16.5.5", "172.31.255.255", "192.168.1.1"]) {
      const result = await validateUrl(`http://${ip}/`);
      expect(result.allowed, `${ip} should be blocked`).toBe(false);
    }
  });

  it("does not block a public IP just outside a private range's boundary", async () => {
    // 172.15.255.255 and 172.32.0.0 are adjacent to the blocked
    // 172.16.0.0/12 range but genuinely outside it - proves the CIDR
    // arithmetic isn't accidentally over-blocking.
    const below = await validateUrl("http://172.15.255.255/");
    const above = await validateUrl("http://172.32.0.0/");
    expect(below.allowed).toBe(true);
    expect(above.allowed).toBe(true);
  });

  it("rejects a non-http(s) protocol", async () => {
    const ftp = await validateUrl("ftp://example.com/");
    const file = await validateUrl("file:///etc/passwd");
    expect(ftp.allowed).toBe(false);
    expect(ftp.reason).toContain("protocol");
    expect(file.allowed).toBe(false);
  });

  it("rejects a malformed URL rather than throwing", async () => {
    const result = await validateUrl("not a url");
    expect(result.allowed).toBe(false);
  });

  it("allows a real public hostname (genuine DNS resolution, not mocked)", async () => {
    const result = await validateUrl("https://quotes.toscrape.com/");
    expect(result.allowed).toBe(true);
    expect(result.resolvedIps?.length).toBeGreaterThan(0);
  }, 15_000);

  it("fails closed on an unresolvable hostname rather than allowing it through", async () => {
    const result = await validateUrl("https://this-domain-should-not-exist-syveka-test.invalid/");
    expect(result.allowed).toBe(false);
  }, 15_000);

  it("the test-only private-network override is opt-in and does not affect default calls", async () => {
    const withoutOverride = await validateUrl("http://127.0.0.1/");
    const withOverride = await validateUrl("http://127.0.0.1/", {
      allowPrivateNetworkForTesting: true,
    });
    expect(withoutOverride.allowed).toBe(false);
    expect(withOverride.allowed).toBe(true);
  });
});
