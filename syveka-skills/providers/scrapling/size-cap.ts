/**
 * Pure, provider-independent response-size enforcement - separated out so
 * it can be unit-tested directly without needing a live fetch (Docker,
 * network) to prove the cap actually applies. Truncates on a UTF-8-safe
 * boundary (Buffer.slice on bytes, not String.slice on UTF-16 code units)
 * so a cap landing mid-multibyte-character doesn't produce corrupt output.
 */
export interface SizeCapResult {
  content: string;
  oversized: boolean;
  originalByteLength: number;
}

export function applySizeCap(content: string, maxBytes: number): SizeCapResult {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) {
    return { content, oversized: false, originalByteLength: buf.byteLength };
  }
  // toString("utf-8") on a buffer sliced mid-character replaces the
  // partial trailing bytes with U+FFFD rather than throwing - acceptable
  // for a hard truncation boundary.
  return {
    content: buf.subarray(0, maxBytes).toString("utf-8"),
    oversized: true,
    originalByteLength: buf.byteLength,
  };
}
