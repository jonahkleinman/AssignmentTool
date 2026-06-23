import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import { DEFAULT_MODEL, EXTRACT_SYSTEM_PROMPT, EXTRACT_USER_PROMPT } from "@/lib/prompt";
import { classifyUpload, extractTextFromBuffer } from "@/lib/extract";

export const runtime = "nodejs";

/** Hard cap on upload size (15 MB) to keep parsing and token use bounded. */
const MAX_BYTES = 15 * 1024 * 1024;
/** Cap on how much extracted text we feed the model / return to the client. */
const MAX_TEXT_CHARS = 20_000;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

interface Distilled {
  assessment: string;
  parts: string;
}

function parseDistilled(raw: string | null): Distilled {
  if (!raw) return { assessment: "", parts: "" };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      assessment: typeof obj.assessment === "string" ? obj.assessment.trim() : "",
      parts: typeof obj.parts === "string" ? obj.parts.trim() : "",
    };
  } catch {
    return { assessment: "", parts: "" };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The studio could not read that file right now.";
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY) {
    return jsonError(
      "OpenAI is not configured yet. Add OPENAI_API_KEY to .env.local and restart the dev server.",
      503,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Upload must be sent as multipart/form-data.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("No file was included in the upload.", 400);
  }
  if (file.size === 0) {
    return jsonError("That file is empty.", 400);
  }
  if (file.size > MAX_BYTES) {
    return jsonError("That file is too large (15 MB max).", 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const kind = classifyUpload(file.type, file.name);

  if (kind === "unknown") {
    return jsonError(
      "Unsupported file type. Upload a PDF, Word (.docx), image, or text file.",
      415,
    );
  }

  const client = new OpenAI();
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  try {
    // Image uploads have no embedded text: read them with the vision model,
    // which both transcribes the assignment and distills the two fields.
    if (kind === "image") {
      const dataUrl = `data:${file.type || "image/png"};base64,${buffer.toString("base64")}`;
      const content: ChatCompletionContentPart[] = [
        {
          type: "text",
          text: `${EXTRACT_USER_PROMPT}\nAlso include a "rawText" field with a faithful transcription of all assignment text you can read.`,
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ];
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content },
      ];

      const completion = await client.chat.completions.create(
        { model, messages, response_format: { type: "json_object" } },
        { signal: request.signal },
      );
      const raw = completion.choices[0]?.message?.content ?? null;
      const distilled = parseDistilled(raw);
      let rawText = "";
      try {
        const obj = JSON.parse(raw ?? "{}") as Record<string, unknown>;
        if (typeof obj.rawText === "string") rawText = obj.rawText.trim();
      } catch {
        /* transcription is best-effort */
      }
      if (!distilled.assessment && !distilled.parts) {
        return jsonError("Couldn't read an assignment from that image.", 422);
      }
      return Response.json({ ...distilled, rawText: rawText.slice(0, MAX_TEXT_CHARS) });
    }

    // Text-based formats: extract the text ourselves, then distill it.
    const fullText = await extractTextFromBuffer(buffer, kind);
    if (!fullText) {
      const hint =
        kind === "pdf"
          ? " This PDF may be a scan with no embedded text — try uploading it as an image instead."
          : "";
      return jsonError(`No readable text found in that file.${hint}`, 422);
    }

    const text = fullText.slice(0, MAX_TEXT_CHARS);
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: `${EXTRACT_USER_PROMPT}\n\n---\n${text}` },
    ];

    const completion = await client.chat.completions.create(
      { model, messages, response_format: { type: "json_object" } },
      { signal: request.signal },
    );
    const distilled = parseDistilled(completion.choices[0]?.message?.content ?? null);
    if (!distilled.assessment && !distilled.parts) {
      return jsonError("Couldn't make sense of that assignment.", 422);
    }

    return Response.json({ ...distilled, rawText: text });
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
