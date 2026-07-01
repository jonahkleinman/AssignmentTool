import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { SYSTEM_PROMPT } from "@/lib/prompt";
import { reasoningModel } from "@/lib/model";
import { buildFocusedKnowledgeQuery, formatKnowledgeBlock, retrieve } from "@/lib/knowledge";

export const runtime = "nodejs";

type ClientRole = "user" | "assistant";

interface ClientMessage {
  role: ClientRole;
  content: string;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessages(value: unknown): ClientMessage[] | null {
  if (!Array.isArray(value)) return null;

  const messages: ClientMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.role !== "user" && item.role !== "assistant") return null;
    if (typeof item.content !== "string") return null;

    const content = item.content.trim();
    if (!content) continue;

    messages.push({
      role: item.role,
      content,
    });
  }

  return messages;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The studio could not stream a redesign right now.";
}

function extractInlineField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, "i");
  return re.exec(text)?.[1]?.trim() ?? "";
}

function extractLineField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}:\\s*(.+)$`, "im");
  return re.exec(text)?.[1]?.trim() ?? "";
}

function extractSectionItems(text: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}:\\s*([\\s\\S]*?)(?=^\\w[\\w /-]*:\\s*|\\*\\*|$)`, "im");
  const section = re.exec(text)?.[1] ?? "";
  return section
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildRedesignKnowledgeQuery(messages: ClientMessage[]): string {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n");

  return buildFocusedKnowledgeQuery({
    assignmentType: extractInlineField(userText, "Assignment type"),
    parts: extractInlineField(userText, "Assignment components / description"),
    goal: extractInlineField(userText, "Learning goals"),
    time: extractInlineField(userText, "Time budget"),
    purpose: extractLineField(userText, "Purpose read"),
    constraints: extractSectionItems(userText, "Constraints"),
    habits: extractSectionItems(userText, "Habits"),
    raw: userText,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY) {
    return jsonError(
      "OpenAI is not configured yet. Add OPENAI_API_KEY to .env.local and restart the dev server.",
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  if (!isRecord(body)) {
    return jsonError("Request body must include messages.", 400);
  }

  const clientMessages = normalizeMessages(body.messages);
  if (!clientMessages || !clientMessages.some((message) => message.role === "user")) {
    return jsonError("Messages must include at least one non-empty user message.", 400);
  }

  const client = new OpenAI();

  // Let the teacher's reference library quietly inform the reply when an index exists.
  let knowledgeBlock = "";
  try {
    const query = buildRedesignKnowledgeQuery(clientMessages);
    const passages = await retrieve(client, query, 5, request.signal);
    knowledgeBlock = formatKnowledgeBlock(passages);
  } catch {
    // Retrieval is best-effort; fall back to prompt-only on any failure.
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(knowledgeBlock ? [{ role: "system" as const, content: knowledgeBlock }] : []),
    ...clientMessages,
  ];

  try {
    const stream = await client.chat.completions.create(
      {
        ...reasoningModel(),
        messages,
        stream: true,
      },
      { signal: request.signal },
    );

    const encoder = new TextEncoder();
    const bodyStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(bodyStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
