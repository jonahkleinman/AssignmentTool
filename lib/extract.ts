/* ------------------------------------------------------------------ *
 *  Server-side text extraction for uploaded assignments.
 *
 *  Pulls plain text out of the text-based formats we accept (txt/md,
 *  PDF, .docx). Images are handled separately by /api/extract via the
 *  vision model, since they have no embedded text to pull.
 * ------------------------------------------------------------------ */

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export type UploadKind = "text" | "pdf" | "docx" | "image" | "unknown";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Classifies an upload from its MIME type, falling back to the extension. */
export function classifyUpload(mime: string, filename: string): UploadKind {
  const type = mime.toLowerCase();
  const name = filename.toLowerCase();

  if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return "image";
  }
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === DOCX_MIME || name.endsWith(".docx")) return "docx";
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    /\.(txt|md|markdown|csv|rtf)$/.test(name)
  ) {
    return "text";
  }
  return "unknown";
}

/** Extracts plain text from a non-image upload. Throws on unreadable input. */
export async function extractTextFromBuffer(
  buffer: Buffer,
  kind: UploadKind,
): Promise<string> {
  switch (kind) {
    case "text":
      return buffer.toString("utf8").trim();

    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer });
      return value.trim();
    }

    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return (Array.isArray(text) ? text.join("\n") : text).trim();
    }

    default:
      throw new Error(`Cannot extract text from "${kind}" uploads.`);
  }
}
