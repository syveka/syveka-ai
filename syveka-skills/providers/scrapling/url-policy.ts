import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/**
 * URL/network policy for the real Scrapling provider. This is the actual
 * SSRF defense - not Scrapling's own `follow_redirects="safe"` (which only
 * covers its HTTP engine and only covers redirects, not the initial
 * target - see docs/skills/SECURITY_REVIEW.md "Network behavior"). This
 * module is deliberately provider-independent: it has no Scrapling import
 * and no knowledge of how the fetch is actually performed, so it could
 * gate any future web-fetching provider the same way.
 *
 * KNOWN LIMITATION - DNS rebinding / TOCTOU: `validateUrl()` resolves and
 * checks the hostname exactly once, here, before the Docker container ever
 * starts. The container's own fetch (Scrapling/curl_cffi) then performs its
 * *own*, separate DNS resolution moments later. A hostile DNS server fully
 * controlling the target's DNS could answer this check with a public IP and
 * then answer the container's later lookup with a private/internal one -
 * this module has no way to pin the fetch to the exact IP it validated. Not
 * fixed in this milestone (would require a custom low-level HTTP client
 * with connect-time IP pinning, replacing Scrapling's own networking - out
 * of scope for a single-fetch MVP capability). Treated as an accepted,
 * disclosed residual risk, not a solved problem - do not read this module
 * as providing complete SSRF resistance against a fully hostile DNS
 * operator; it resists the far more common case of a fixed private/
 * metadata/loopback target.
 */

export interface UrlPolicyResult {
  allowed: boolean;
  reason: string;
  hostname?: string;
  resolvedIps?: string[];
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const LOCALHOST_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range!) & mask);
}

// RFC 1918/5735/6598 private, loopback, link-local (which covers the
// 169.254.169.254 cloud metadata address used by AWS/GCP/Azure IMDS),
// documentation/test ranges, carrier-grade NAT, multicast, and reserved.
const BLOCKED_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some((cidr) => isIpv4InCidr(ip, cidr));
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique-local fc00::/7
  if (normalized.startsWith("ff")) return true; // multicast ff00::/8
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) - unwrap and re-check against IPv4 rules,
  // since this is a documented way to smuggle a private IPv4 address past a
  // naive IPv6-only check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // unrecognized shape - fail closed, not open
}

export interface UrlPolicyOptions {
  /**
   * Test-only escape hatch to allow otherwise-blocked (e.g. loopback)
   * targets. Never read by production code paths - see
   * providers/scrapling/index.ts, which never sets this. Exists so
   * evals/scrapling-prompt-injection.test.ts can serve a malicious fixture
   * from a real local HTTP server without weakening the real policy.
   */
  allowPrivateNetworkForTesting?: boolean;
}

export async function validateUrl(
  url: string,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "not a valid URL" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `protocol "${parsed.protocol}" is not in the allowlist (http, https only)`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (options.allowPrivateNetworkForTesting) {
    return {
      allowed: true,
      reason: "test-only override active - production policy not evaluated",
      hostname,
      resolvedIps: ["(test override - not resolved)"],
    };
  }

  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `hostname "${hostname}" is a localhost alias - blocked` };
  }

  // If the hostname is already a literal IP, no DNS lookup needed.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return {
        allowed: false,
        reason: `IP address ${hostname} is in a blocked range`,
        hostname,
        resolvedIps: [hostname],
      };
    }
    return {
      allowed: true,
      reason: "IP address is not in a blocked range",
      hostname,
      resolvedIps: [hostname],
    };
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return {
      allowed: false,
      reason: `DNS resolution failed for "${hostname}": ${(err as Error).message}`,
    };
  }

  if (records.length === 0) {
    return { allowed: false, reason: `"${hostname}" resolved to zero addresses` };
  }

  const resolvedIps = records.map((r) => r.address);
  const blocked = resolvedIps.filter(isBlockedIp);
  if (blocked.length > 0) {
    return {
      allowed: false,
      reason:
        `"${hostname}" resolves to a blocked address (${blocked.join(", ")}) - rejecting the whole ` +
        'hostname rather than trying to pick a "safe" record, since a multi-homed/rebinding host is ' +
        "exactly the attack this check exists to stop",
      hostname,
      resolvedIps,
    };
  }

  return {
    allowed: true,
    reason: `all resolved addresses (${resolvedIps.join(", ")}) are outside blocked ranges`,
    hostname,
    resolvedIps,
  };
}
