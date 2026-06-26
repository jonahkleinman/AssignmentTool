import OpenAI from "openai";

import {
  buildSuggestUserPrompt,
  DEFAULT_MODEL,
  SUGGEST_SYSTEM_PROMPT,
  STEP_IDS,
  type Answers,
  type StepId,
} from "@/lib/prompt";

export const runtime = "nodejs";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepId(value: unknown): value is StepId {
  return typeof value === "string" && STEP_IDS.includes(value as StepId);
}

function normalizeAnswers(value: unknown): Answers {
  const source = isRecord(value) ? value : {};
  return {
    grade: typeof source.grade === "string" ? source.grade.trim() : "",
    assessment: typeof source.assessment === "string" ? source.assessment.trim() : "",
    parts: typeof source.parts === "string" ? source.parts.trim() : "",
    goal: typeof source.goal === "string" ? source.goal.trim() : "",
    constraints: typeof source.constraints === "string" ? source.constraints.trim() : "",
  };
}

function normalizeChoices(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.choices)) return [];

  return value.choices
    .filter((choice): choice is string => typeof choice === "string")
    .map((choice) => choice.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The studio could not generate suggestions right now.";
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

  if (!isRecord(body) || !isStepId(body.step)) {
    return jsonError(
      "Request body must include a valid step: grade, assessment, parts, goal, or constraints.",
      400,
    );
  }

  const answers = normalizeAnswers(body.answers);
  const client = new OpenAI();

  try {
    const completion = await client.chat.completions.create(
      {
        model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: SUGGEST_SYSTEM_PROMPT },
          { role: "user", content: buildSuggestUserPrompt(body.step, answers) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "suggestion_choices",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                choices: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["choices"],
            },
          },
        },
        max_completion_tokens: 220,
      },
      { signal: request.signal },
    );

    const rawContent = completion.choices[0]?.message.content;
    if (!rawContent) {
      return jsonError("The studio returned an empty suggestion response.", 502);
    }

    const choices = normalizeChoices(JSON.parse(rawContent));
    if (choices.length === 0) {
      return jsonError("The studio returned suggestion choices in an unexpected format.", 502);
    }

    return Response.json({ choices });
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
