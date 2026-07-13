import "server-only";

import { convert as htmlToText } from "html-to-text";
import { assertExtractionLimits } from "@/server/security/document-ingestion";
import { fetchPublicUrl } from "@/server/security/url-ingestion";

/** Extract plain text from an uploaded file buffer (§15.5 ingest). */
export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  switch (mimeType) {
    case "application/pdf": {
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(buffer);
      return result.text;
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
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
export async function extractFromUrl(url: string): Promise<string> {
  const { body, mimeType } = await fetchPublicUrl(url);
  const text = await extractText(body, mimeType);
  assertExtractionLimits(text);
  return text;
}
