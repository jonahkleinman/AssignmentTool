import OpenAI from "openai";

import {
  LENSES,
  LENS_IDS,
  buildLensUserPrompt,
  type Answers,
  type LensId,
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
type Impact = "most" | "some" | "a few";
type DemandType = "procedural" | "conceptual" | "strategic";
type ScaffoldDirection = "add" | "remove";
type AiReach = "does most" | "does some" | "barely";

interface Diagnosis {
  purpose: string;
  constraints: { text: string; kind: ConstraintKind; note: string }[];
  habits: { text: string; status: HabitStatus }[];
  note?: string;
}

interface ConfusionResult {
  summary: string;
  points: { where: string; confusion: string; impact: Impact; fix: string }[];
}

interface ComplexityResult {
  read: string;
  demands: { text: string; type: DemandType }[];
  scaffolding: {
    direction: ScaffoldDirection;
    where: string;
    move: string;
    effect: string;
  }[];
}

interface AiExposureResult {
  verdict: string;
  exposures: {
    part: string;
    reach: AiReach;
    why: string;
    constraint: string;
    effect: string;
  }[];
}

type LensResponse = ConfusionResult | ComplexityResult | AiExposureResult;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLensId(value: unknown): value is LensId {
  return typeof value === "string" && LENS_IDS.includes(value as LensId);
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

function isImpact(value: unknown): value is Impact {
  return value === "most" || value === "some" || value === "a few";
}

function isDemandType(value: unknown): value is DemandType {
  return value === "procedural" || value === "conceptual" || value === "strategic";
}

function isScaffoldDirection(value: unknown): value is ScaffoldDirection {
  return value === "add" || value === "remove";
}

function isAiReach(value: unknown): value is AiReach {
  return value === "does most" || value === "does some" || value === "barely";
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
  const note = cleanText(value.note, 700);

  if (!purpose) return null;
  return { purpose, constraints, habits, note };
}

function normalizeConfusion(value: unknown): ConfusionResult | null {
  if (!isRecord(value)) return null;
  const summary = cleanText(value.summary);
  const points = Array.isArray(value.points)
    ? value.points
        .filter(isRecord)
        .map((item) => ({
          where: cleanText(item.where),
          confusion: cleanText(item.confusion),
          impact: isImpact(item.impact) ? item.impact : "some",
          fix: cleanText(item.fix),
        }))
        .filter((item) => item.where && item.confusion && item.fix)
        .slice(0, 6)
    : [];

  if (!summary) return null;
  return { summary, points };
}

function normalizeComplexity(value: unknown): ComplexityResult | null {
  if (!isRecord(value)) return null;
  const read = cleanText(value.read);
  const demands = Array.isArray(value.demands)
    ? value.demands
        .filter(isRecord)
        .map((item) => ({
          text: cleanText(item.text),
          type: isDemandType(item.type) ? item.type : "strategic",
        }))
        .filter((item) => item.text)
        .slice(0, 8)
    : [];
  const scaffolding = Array.isArray(value.scaffolding)
    ? value.scaffolding
        .filter(isRecord)
        .map((item) => ({
          direction: isScaffoldDirection(item.direction) ? item.direction : "add",
          where: cleanText(item.where),
          move: cleanText(item.move),
          effect: cleanText(item.effect),
        }))
        .filter((item) => item.where && item.move && item.effect)
        .slice(0, 6)
    : [];

  if (!read) return null;
  return { read, demands, scaffolding };
}

function normalizeAiExposure(value: unknown): AiExposureResult | null {
  if (!isRecord(value)) return null;
  const verdict = cleanText(value.verdict);
  const exposures = Array.isArray(value.exposures)
    ? value.exposures
        .filter(isRecord)
        .map((item) => ({
          part: cleanText(item.part),
          reach: isAiReach(item.reach) ? item.reach : "does some",
          why: cleanText(item.why),
          constraint: cleanText(item.constraint),
          effect: cleanText(item.effect),
        }))
        .filter((item) => item.part && item.why && item.constraint && item.effect)
        .slice(0, 6)
    : [];

  if (!verdict) return null;
  return { verdict, exposures };
}

function normalizeLens(lens: LensId, value: unknown): LensResponse | null {
  if (lens === "confusion") return normalizeConfusion(value);
  if (lens === "complexity") return normalizeComplexity(value);
  return normalizeAiExposure(value);
}

function logRetrievedPassages(lens: LensId, passages: RetrievedPassage[]): void {
  if (passages.length === 0) {
    console.info(`[lens:${lens}] no knowledge passages retrieved`);
    return;
  }
  console.info(
    `[lens:${lens}] retrieved knowledge passages`,
    passages.map((p) => ({
      source: p.source,
      page: p.page,
      score: Number(p.score.toFixed(3)),
    })),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The studio could not read that lens right now.";
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
    return jsonError("Request body must include lens, sourceDoc, answers, and diagnosis.", 400);
  }

  if (!isLensId(body.lens)) {
    return jsonError("Request body must include a valid lens.", 400);
  }

  const sourceDoc = cleanSourceDoc(body.sourceDoc);
  if (!sourceDoc) {
    return jsonError("Lens reads require an uploaded or pasted assignment.", 400);
  }

  const diagnosis = normalizeDiagnosis(body.diagnosis);
  if (!diagnosis) {
    return jsonError("Lens reads require a confirmed diagnosis.", 400);
  }

  const lens = body.lens;
  const lensConfig = LENSES[lens];
  const answers = normalizeAnswers(body.answers);
  const focus = cleanText(body.focus, 500);
  const client = new OpenAI();

  let knowledgeBlock = "";
  if (lensConfig.retrieve) {
    try {
      const query = buildFocusedKnowledgeQuery({
        assignmentType: answers.assessment,
        parts: answers.parts,
        goal: answers.goal,
        time: answers.time,
        purpose: diagnosis.purpose,
        constraints: diagnosis.constraints.map((constraint) => constraint.text),
        habits: diagnosis.habits.map((habit) => habit.text),
        sourceDoc,
        raw: [lensConfig.knowledgeSeed, focus].filter(Boolean).join("\n"),
      });
      const passages = await retrieve(client, query, 10, request.signal);
      logRetrievedPassages(lens, passages);
      knowledgeBlock = formatKnowledgeBlock(passages);
    } catch {
      // Retrieval is best-effort; the lens still runs without it.
    }
  } else {
    console.info(`[lens:${lens}] prompt-only; skipped retrieval`);
  }

  try {
    const completion = await client.chat.completions.create(
      {
        ...reasoningModel(),
        messages: [
          { role: "system", content: lensConfig.system },
          ...(knowledgeBlock ? [{ role: "system" as const, content: knowledgeBlock }] : []),
          {
            role: "user",
            content: buildLensUserPrompt(lens, answers, sourceDoc, diagnosis, focus),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `${lens}_read`,
            strict: true,
            schema: lensConfig.schema,
          },
        },
        max_completion_tokens: 4000,
      },
      { signal: request.signal },
    );

    const rawContent = completion.choices[0]?.message.content;
    const result = normalizeLens(lens, rawContent ? JSON.parse(rawContent) : null);
    if (!result) {
      return jsonError("The studio returned a lens read in an unexpected format.", 502);
    }

    return Response.json(result);
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
