import "server-only";

import { convert as htmlToText } from "html-to-text";

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
  const res = await fetch(url, {
    headers: { "User-Agent": "SyvekaBot/1.0 (+https://syveka.ai)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const body = Buffer.from(await res.arrayBuffer());
  if (contentType.includes("text/html")) return extractText(body, "text/html");
  if (contentType.includes("application/pdf")) return extractText(body, "application/pdf");
  return body.toString("utf8");
}
