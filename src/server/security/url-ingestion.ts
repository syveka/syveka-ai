import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const URL_FETCH_TIMEOUT_MS = 20_000;
export const MAX_URL_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_URL_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const SUPPORTED_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "text/html"],
  ["application/pdf", "application/pdf"],
  ["text/plain", "text/plain"],
  ["text/markdown", "text/markdown"],
] as const);

type ResolvedAddress = { address: string; family: number };
type UrlFetchDependencies = {
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  fetch?: typeof fetch;
};

export class UrlIngestionError extends Error {
  constructor(
    public readonly code:
      | "invalid_protocol"
      | "blocked_destination"
      | "dns_failure"
      | "redirect_limit"
      | "invalid_redirect"
      | "fetch_failed"
      | "unsupported_content_type"
      | "oversized_response",
    message: string,
  ) {
    super(message);
    this.name = "UrlIngestionError";
  }
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

export function isPublicIpAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().split("%")[0] ?? "";
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a = 0, b = 0, c = 0] = ipv4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }

  if (isIP(address) !== 6) return false;
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("fc") || address.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(address)) return false;
  if (/^fe[c-f]/.test(address)) return false;
  if (address.startsWith("ff")) return false;
  if (address.startsWith("2001:db8:")) return false;
  if (address.startsWith("::ffff:")) {
    return isPublicIpAddress(address.slice("::ffff:".length));
  }
  return true;
}

function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlIngestionError("invalid_protocol", "URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlIngestionError("invalid_protocol", "Only HTTP and HTTPS URLs are supported");
  }
  if (url.username || url.password) {
    throw new UrlIngestionError("blocked_destination", "Credentialed URLs are not supported");
  }
  return url;
}

export function assertSupportedUrl(input: string): void {
  parseUrl(input);
}

async function assertPublicDestination(
  url: URL,
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>,
): Promise<void> {
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new UrlIngestionError("blocked_destination", "URL destination is not public");
  }

  const literalFamily = isIP(hostname);
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await resolve(hostname);
  } catch {
    throw new UrlIngestionError("dns_failure", "URL destination could not be resolved");
  }
  if (addresses.length === 0) {
    throw new UrlIngestionError("dns_failure", "URL destination did not resolve to an address");
  }
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new UrlIngestionError("blocked_destination", "URL destination is not public");
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new UrlIngestionError("oversized_response", "URL response exceeds the size limit");
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new UrlIngestionError("oversized_response", "URL response exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPublicUrl(
  input: string,
  dependencies: UrlFetchDependencies = {},
): Promise<{ body: Buffer; mimeType: string; finalUrl: string }> {
  const resolve =
    dependencies.lookup ??
    ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.fetch ?? fetch;
  let current = parseUrl(input);
  const timeoutSignal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_URL_REDIRECTS; redirects += 1) {
    await assertPublicDestination(current, resolve);
    const response = await request(current, {
      redirect: "manual",
      headers: { "User-Agent": "SyvekaBot/1.0 (+https://syveka.ai)" },
      signal: timeoutSignal,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_URL_REDIRECTS) {
        throw new UrlIngestionError("redirect_limit", "URL exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new UrlIngestionError("invalid_redirect", "Redirect response has no location");
      }
      await response.body?.cancel();
      current = parseUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new UrlIngestionError(
        "fetch_failed",
        `URL fetch failed with status ${response.status}`,
      );
    }
    const rawContentType = response.headers.get("content-type") ?? "";
    const contentType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const mimeType = SUPPORTED_CONTENT_TYPES.get(contentType);
    if (!mimeType) {
      throw new UrlIngestionError(
        "unsupported_content_type",
        "URL response content type is not supported",
      );
    }

    return {
      body: await readBoundedBody(response, MAX_URL_RESPONSE_BYTES),
      mimeType,
      finalUrl: current.toString(),
    };
  }

  throw new UrlIngestionError("redirect_limit", "URL exceeded the redirect limit");
}
