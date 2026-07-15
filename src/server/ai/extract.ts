import "server-only";

import { convert as htmlToText } from "html-to-text";
import { assertExtractionLimits } from "@/server/security/document-ingestion";
import { fetchPublicUrl } from "@/server/security/url-ingestion";
import { parseDocumentIsolated } from "@/server/security/parser-security";

/** Extract plain text from an uploaded file buffer (§15.5 ingest). */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {
  switch (mimeType) {
    case "application/pdf":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocumentIsolated(buffer, mimeType, signal);
    case "text/html":
      return htmlToText(buffer.toString("utf8"), {
        wordwrap: false,
        selectors: [
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "nav", format: "skip" },
        ],
      });
    case "text/plain":
    case "text/markdown":
      return buffer.toString("utf8");
    default:
      throw new Error(`Unsupported mime type: ${mimeType}`);
  }
}

/** Fetch + extract a public URL (sourceType=URL). */
export async function extractFromUrl(url: string, signal?: AbortSignal): Promise<string> {
  const { body, mimeType } = await fetchPublicUrl(url, { signal });
  const text = await extractText(body, mimeType, signal);
  assertExtractionLimits(text);
  return text;
}
