import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";

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

export type ResolvedAddress = { address: string; family: number };
export type PinnedResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
  cancel: () => void;
};
export type PinnedRequest = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
) => Promise<PinnedResponse>;
type UrlFetchDependencies = {
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: PinnedRequest;
  signal?: AbortSignal;
};

type Cidr = { bytes: readonly number[]; prefix: number };

const BLOCKED_IPV4_CIDRS: readonly Cidr[] = [
  cidr("0.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("100.64.0.0", 10),
  cidr("127.0.0.0", 8),
  cidr("169.254.0.0", 16),
  cidr("172.16.0.0", 12),
  cidr("192.0.0.0", 24),
  cidr("192.0.2.0", 24),
  cidr("192.88.99.0", 24),
  cidr("192.168.0.0", 16),
  cidr("198.18.0.0", 15),
  cidr("198.51.100.0", 24),
  cidr("203.0.113.0", 24),
  cidr("224.0.0.0", 4),
  cidr("240.0.0.0", 4),
];

const BLOCKED_IPV6_CIDRS: readonly Cidr[] = [
  cidr("::", 128),
  cidr("::1", 128),
  cidr("::", 96), // IPv4-compatible and other embedded IPv4 forms.
  cidr("64:ff9b::", 96),
  cidr("64:ff9b:1::", 48),
  cidr("100::", 64),
  cidr("2001::", 32), // Teredo.
  cidr("2001:2::", 48), // Benchmarking.
  cidr("2001:10::", 28), // Deprecated ORCHID.
  cidr("2001:20::", 28), // ORCHIDv2.
  cidr("2001:db8::", 32), // Documentation.
  cidr("2002::", 16), // 6to4 embeds an uncontrolled IPv4 address.
  cidr("3fff::", 20), // Documentation.
  cidr("5f00::", 16), // Segment-routing local identifiers.
  cidr("fc00::", 7),
  cidr("fe80::", 10),
  cidr("fec0::", 10),
  cidr("ff00::", 8),
];

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

function parseIpv6(address: string): number[] | null {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (isIP(normalized) !== 6) return null;
  let source = normalized;
  const dottedTail = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const ipv4 = parseIpv4(dottedTail);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
    source = `${source.slice(0, -dottedTail.length)}${replacement}`;
  }
  const [leftRaw, rightRaw = ""] = source.split("::", 2);
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = source.includes("::") ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function addressBytes(address: string): number[] {
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4;
  const ipv6 = parseIpv6(address);
  if (ipv6) return ipv6;
  throw new Error(`Invalid IP address: ${address}`);
}

function cidr(address: string, prefix: number): Cidr {
  return { bytes: addressBytes(address), prefix };
}

function matchesCidr(bytes: readonly number[], range: Cidr): boolean {
  if (bytes.length !== range.bytes.length) return false;
  const wholeBytes = Math.floor(range.prefix / 8);
  const remainingBits = range.prefix % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== range.bytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes]! & mask) === (range.bytes[wholeBytes]! & mask);
}

export function isPublicIpAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().split("%")[0] ?? "";
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address)!;
    return !BLOCKED_IPV4_CIDRS.some((range) => matchesCidr(bytes, range));
  }
  if (family !== 6) return false;
  const bytes = parseIpv6(address)!;

  // IPv4-mapped IPv6 must be classified by the embedded IPv4 address.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpAddress(bytes.slice(12).join("."));
  }
  return !BLOCKED_IPV6_CIDRS.some((range) => matchesCidr(bytes, range));
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

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

async function resolvePublicDestination(
  url: URL,
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>,
): Promise<ResolvedAddress> {
  const hostname = normalizedHostname(url);
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
  if (
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || isIP(address) !== family || !isPublicIpAddress(address),
    )
  ) {
    throw new UrlIngestionError("blocked_destination", "URL destination is not public");
  }
  return addresses[0]!;
}

export function createPinnedRequestOptions(url: URL, address: ResolvedAddress): RequestOptions {
  const originalHostname = normalizedHostname(url);
  return {
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    method: "GET",
    path: `${url.pathname}${url.search}`,
    headers: {
      Host: url.host,
      "User-Agent": "SyvekaBot/1.0 (+https://syveka.ai)",
      Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown",
    },
    ...(url.protocol === "https:" && isIP(originalHostname) === 0
      ? { servername: originalHostname }
      : {}),
  };
}

async function requestPinned(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { ...createPinnedRequestOptions(url, address), signal },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: response as Readable,
          cancel: () => response.destroy(),
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function readBoundedBody(response: PinnedResponse, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    response.cancel();
    throw new UrlIngestionError("oversized_response", "URL response exceeds the size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maximumBytes) {
      response.cancel();
      throw new UrlIngestionError("oversized_response", "URL response exceeds the size limit");
    }
    chunks.push(chunk);
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
  const request = dependencies.request ?? requestPinned;
  let current = parseUrl(input);
  const timeoutSignal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);
  const requestSignal = dependencies.signal
    ? AbortSignal.any([timeoutSignal, dependencies.signal])
    : timeoutSignal;

  for (let redirects = 0; redirects <= MAX_URL_REDIRECTS; redirects += 1) {
    // Every hop resolves once, validates every answer, and connects to the selected answer directly.
    const pinnedAddress = await resolvePublicDestination(current, resolve);
    let response: PinnedResponse;
    try {
      response = await request(current, pinnedAddress, requestSignal);
    } catch (error) {
      if (error instanceof UrlIngestionError) throw error;
      throw new UrlIngestionError("fetch_failed", "Pinned URL request failed");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_URL_REDIRECTS) {
        response.cancel();
        throw new UrlIngestionError("redirect_limit", "URL exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      response.cancel();
      if (!location) {
        throw new UrlIngestionError("invalid_redirect", "Redirect response has no location");
      }
      current = parseUrl(new URL(location, current).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.cancel();
      throw new UrlIngestionError(
        "fetch_failed",
        `URL fetch failed with status ${response.status}`,
      );
    }
    const rawContentType = response.headers.get("content-type") ?? "";
    const contentType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const mimeType = SUPPORTED_CONTENT_TYPES.get(contentType);
    if (!mimeType) {
      response.cancel();
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
