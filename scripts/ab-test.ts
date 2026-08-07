/* ------------------------------------------------------------------ *
 *  A/B harness: fast model vs. thinking model on the reasoning routes.
 *
 *  Runs one fixed assignment through both arms for diagnose and redesign,
 *  calling OpenAI directly (no dev server needed), and prints each arm's
 *  output, latency, and token usage — including reasoning tokens — so you
 *  can judge whether thinking earns its cost before committing to it.
 *
 *  Run with:  npm run ab-test              (both routes)
 *             npm run ab-test -- diagnose  (one route: diagnose | redesign)
 *
 *  Requires OPENAI_REASONING_MODEL to be set (in .env), otherwise both
 *  arms are identical and there is nothing to compare. RAG is skipped: both
 *  arms would receive the same knowledge block, so it is held constant and
 *  the only variable is the model.
 * ------------------------------------------------------------------ */

import "dotenv/config";
import OpenAI from "openai";

import { SYSTEM_PROMPT, DIAGNOSIS_SYSTEM_PROMPT, type Answers } from "../lib/prompt";
import { fastModel, thinkingModel, type ModelConfig } from "../lib/model";

/* ---- fixture: one representative assignment ---------------------- */

const ANSWERS: Answers = {
  grade: "10th grade",
  assessment: "Five-paragraph literary analysis essay",
  parts:
    "Students write an intro with a thesis, three body paragraphs each analysing one piece of textual evidence from the novel, and a conclusion that restates the thesis.",
  goal: "Show they can build an interpretation from evidence, not just summarise the plot.",
  time: "One 50-minute class to draft, homework to revise",
};

const SOURCE_DOC = [
  "Literary Analysis Essay — Of Mice and Men",
  "",
  "Write a five-paragraph essay analysing how Steinbeck uses one theme (loneliness, the American Dream, or power) to develop the novel.",
  "Requirements:",
  "- Introduction with a clear thesis naming your theme.",
  "- Three body paragraphs, each with one quotation from the novel and 3-4 sentences of analysis.",
  "- A conclusion that restates your thesis and sums up your three points.",
  "- 500-700 words, MLA format, submitted at the end of the period.",
].join("\n");

/* ---- prompt builders (mirror the routes) ------------------------ */

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

function buildRedesignIntake(answers: Answers): string {
  return [
    `Grade or age level: ${answers.grade}`,
    `Assignment type: ${answers.assessment}`,
    `Assignment components / description: ${answers.parts}`,
    `Learning goals: ${answers.goal}`,
    `Time budget: ${answers.time}`,
    "",
    "Use this information to propose redesigns.",
  ].join("\n");
}

const DIAGNOSIS_RESPONSE_FORMAT = {
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
} as const;

/* ---- runner ----------------------------------------------------- */

type ArmParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "model"
>;

interface ArmResult {
  label: string;
  model: string;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  text: string;
}

async function runArm(
  client: OpenAI,
  label: string,
  config: ModelConfig,
  params: ArmParams,
): Promise<ArmResult> {
  const full: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    ...config,
    ...params,
  };
  const started = Date.now();
  const res = await client.chat.completions.create(full);
  const ms = Date.now() - started;
  const usage = res.usage;
  return {
    label,
    model: config.model + (config.reasoning_effort ? ` (effort: ${config.reasoning_effort})` : ""),
    ms,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    text: res.choices[0]?.message.content ?? "",
  };
}

function printArm(result: ArmResult): void {
  const { label, model, ms, promptTokens, completionTokens, reasoningTokens, text } = result;
  console.log(`\n─── ${label} — ${model} ───`);
  console.log(
    `latency ${(ms / 1000).toFixed(1)}s · prompt ${promptTokens} · completion ${completionTokens}` +
      (reasoningTokens ? ` (reasoning ${reasoningTokens})` : ""),
  );
  console.log("");
  console.log(text.trim());
}

async function compare(
  client: OpenAI,
  section: string,
  params: ArmParams,
): Promise<void> {
  console.log(`\n\n══════════ ${section.toUpperCase()} ══════════`);
  // Run the arms sequentially so the timing of one doesn't affect the other.
  const fast = await runArm(client, "A · fast", fastModel(), params);
  const thinking = await runArm(client, "B · thinking", thinkingModel(), params);
  printArm(fast);
  printArm(thinking);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set (checked .env). Add it and retry.");
    process.exit(1);
  }
  if (fastModel().model === thinkingModel().model) {
    console.error(
      "OPENAI_REASONING_MODEL is not set, so both arms are the same model — nothing to A/B.\n" +
        "Set OPENAI_REASONING_MODEL (and optionally OPENAI_REASONING_EFFORT) in .env, then rerun.",
    );
    process.exit(1);
  }

  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const runDiagnose = only.length === 0 || only.includes("diagnose");
  const runRedesign = only.length === 0 || only.includes("redesign");

  const client = new OpenAI();

  if (runDiagnose) {
    await compare(client, "diagnose", {
      messages: [
        { role: "system", content: DIAGNOSIS_SYSTEM_PROMPT },
        { role: "user", content: buildDiagnosisUserPrompt(ANSWERS, SOURCE_DOC) },
      ],
      response_format: DIAGNOSIS_RESPONSE_FORMAT,
      max_completion_tokens: 4000,
    });
  }

  if (runRedesign) {
    await compare(client, "redesign", {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildRedesignIntake(ANSWERS) },
      ],
      max_completion_tokens: 3000,
    });
  }

  console.log("");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
