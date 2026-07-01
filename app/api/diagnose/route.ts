import OpenAI from "openai";

import {
  DIAGNOSIS_SYSTEM_PROMPT,
  type Answers,
} from "@/lib/prompt";
import { reasoningModel } from "@/lib/model";
import {
  buildFocusedKnowledgeQuery,
  formatKnowledgeBlock,
  retrieve,
  type RetrievedPassage,
} from "@/lib/knowledge";

export const runtime = "nodejs";

type ConstraintKind = "hurts" | "inert";
type HabitStatus = "breaks" | "reinforces" | "untouched";

interface Diagnosis {
  purpose: string;
  constraints: { text: string; kind: ConstraintKind; note: string }[];
  habits: { text: string; status: HabitStatus }[];
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAnswers(value: unknown): Answers {
  const source = isRecord(value) ? value : {};
  return {
    grade: typeof source.grade === "string" ? source.grade.trim() : "",
    assessment: typeof source.assessment === "string" ? source.assessment.trim() : "",
    parts: typeof source.parts === "string" ? source.parts.trim() : "",
    goal: typeof source.goal === "string" ? source.goal.trim() : "",
    time: typeof source.time === "string" ? source.time.trim() : "",
  };
}

function isConstraintKind(value: unknown): value is ConstraintKind {
  return value === "hurts" || value === "inert";
}

function isHabitStatus(value: unknown): value is HabitStatus {
  return value === "breaks" || value === "reinforces" || value === "untouched";
}

function cleanText(value: unknown, max = 700): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanSourceDoc(value: unknown, max = 20_000): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function normalizeDiagnosis(value: unknown): Diagnosis | null {
  if (!isRecord(value)) return null;
  const purpose = cleanText(value.purpose);
  const constraints = Array.isArray(value.constraints)
    ? value.constraints
        .filter(isRecord)
        .map((item) => ({
          text: cleanText(item.text),
          kind: isConstraintKind(item.kind) ? item.kind : "inert",
          note: cleanText(item.note, 360),
        }))
        .filter((item) => item.text)
        .slice(0, 8)
    : [];
  const habits = Array.isArray(value.habits)
    ? value.habits
        .filter(isRecord)
        .map((item) => ({
          text: cleanText(item.text),
          status: isHabitStatus(item.status) ? item.status : "untouched",
        }))
        .filter((item) => item.text)
        .slice(0, 8)
    : [];

  if (!purpose) return null;
  return { purpose, constraints, habits };
}

function buildDiagnosisUserPrompt(answers: Answers, sourceDoc: string): string {
  return [
    "Read this assignment back to the teacher in the required JSON shape.",
    "",
    `Grade or age level: ${answers.grade || "(not supplied)"}`,
    `Assignment type: ${answers.assessment || "(not supplied)"}`,
    `Assignment components / description: ${answers.parts || "(not supplied)"}`,
    `Learning goals: ${answers.goal || "(not supplied)"}`,
    `Time budget: ${answers.time || "(not supplied)"}`,
    "",
    "Source assignment:",
    sourceDoc,
  ].join("\n");
}

function logRetrievedPassages(passages: RetrievedPassage[]): void {
  if (passages.length === 0) {
    console.info("[diagnose] no knowledge passages retrieved");
    return;
  }
  console.info(
    "[diagnose] retrieved knowledge passages",
    passages.map((p) => ({
      source: p.source,
      page: p.page,
      score: Number(p.score.toFixed(3)),
    })),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The studio could not diagnose that assignment right now.";
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
    return jsonError("Request body must include sourceDoc and answers.", 400);
  }

  const sourceDoc = cleanSourceDoc(body.sourceDoc);
  if (!sourceDoc) {
    return jsonError("Diagnosis requires an uploaded or pasted assignment.", 400);
  }

  const answers = normalizeAnswers(body.answers);
  const client = new OpenAI();

  let knowledgeBlock = "";
  try {
    const query = buildFocusedKnowledgeQuery({
      assignmentType: answers.assessment,
      parts: answers.parts,
      goal: answers.goal,
      time: answers.time,
      raw: "student habits autopilot stale format constraints focus attention familiar routines surprise novelty status quo habituation dishabituation dishabituate",
    });
    const passages = await retrieve(client, query, 10, request.signal);
    logRetrievedPassages(passages);
    knowledgeBlock = formatKnowledgeBlock(passages);
  } catch {
    // Retrieval is best-effort; the diagnosis still runs without it.
  }

  try {
    const completion = await client.chat.completions.create(
      {
        ...reasoningModel(),
        messages: [
          { role: "system", content: DIAGNOSIS_SYSTEM_PROMPT },
          ...(knowledgeBlock ? [{ role: "system" as const, content: knowledgeBlock }] : []),
          { role: "user", content: buildDiagnosisUserPrompt(answers, sourceDoc) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "assignment_diagnosis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                purpose: { type: "string" },
                constraints: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      text: { type: "string" },
                      kind: { type: "string", enum: ["hurts", "inert"] },
                      note: { type: "string" },
                    },
                    required: ["text", "kind", "note"],
                  },
                },
                habits: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      text: { type: "string" },
                      status: { type: "string", enum: ["breaks", "reinforces", "untouched"] },
                    },
                    required: ["text", "status"],
                  },
                },
              },
              required: ["purpose", "constraints", "habits"],
            },
          },
        },
        // Reasoning tokens draw from this budget, so keep generous headroom above
        // the ~900 the JSON itself needs, or a thinking model can truncate mid-object.
        max_completion_tokens: 4000,
      },
      { signal: request.signal },
    );

    const rawContent = completion.choices[0]?.message.content;
    const diagnosis = normalizeDiagnosis(rawContent ? JSON.parse(rawContent) : null);
    if (!diagnosis) {
      return jsonError("The studio returned a diagnosis in an unexpected format.", 502);
    }

    return Response.json(diagnosis);
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
