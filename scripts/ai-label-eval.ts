import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import "dotenv/config";
import OpenAI from "openai";

import { reasoningModel } from "../lib/model";
import {
  isRelevanceScore,
  parseIntakes,
  parseSourceCatalog,
  type EvalIntake,
  type LabelsFile,
  type RelevanceLabel,
  type SourceCatalogEntry,
} from "../lib/eval/types";
import { loadKnowledgeIndex } from "../lib/knowledge";

const ROOT = process.cwd();
const PROMPT_VERSION = "source-usefulness-v1";

interface AiJudgment extends RelevanceLabel {
  source: string;
  rationale: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedIntakes(intakes: EvalIntake[]): EvalIntake[] {
  const raw = argument("intakes");
  if (!raw) return intakes;
  const requested = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = intakes.filter((intake) => requested.delete(intake.id));
  if (requested.size) throw new Error(`Unknown intake ids: ${[...requested].join(", ")}.`);
  if (!selected.length) throw new Error("--intakes did not select any intakes.");
  return selected;
}

function responseSchema(sources: SourceCatalogEntry[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      labels: {
        type: "array",
        minItems: sources.length,
        maxItems: sources.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string", enum: sources.map(({ source }) => source) },
            score: { type: "integer", enum: [0, 1, 2, 3] },
            misleading: { type: "boolean" },
            rationale: { type: "string" },
          },
          required: ["source", "score", "misleading", "rationale"],
        },
      },
    },
    required: ["labels"],
  } as const;
}

function userPrompt(intake: EvalIntake, sources: SourceCatalogEntry[]): string {
  const sourceList = sources
    .map(({ source, summary }) => `SOURCE: ${source}\nSUMMARY: ${summary}`)
    .join("\n\n");
  return `ASSIGNMENT
Grade: ${intake.grade}
Type: ${intake.assessment}
What students do: ${intake.parts}
Learning goal: ${intake.goal}
Time: ${intake.time}
${intake.sourceDoc ? `Original assignment excerpt: ${intake.sourceDoc}` : ""}

SOURCES TO JUDGE
${sourceList}`;
}

function validateJudgments(value: unknown, sources: SourceCatalogEntry[]): AiJudgment[] {
  if (typeof value !== "object" || value === null || !("labels" in value)) {
    throw new Error("The judge response has no labels array.");
  }
  const labels = (value as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) throw new Error("The judge response labels value is not an array.");
  const expected = new Set(sources.map(({ source }) => source));
  const result = labels.map((item, index): AiJudgment => {
    if (typeof item !== "object" || item === null) throw new Error(`Label ${index} is invalid.`);
    const label = item as Record<string, unknown>;
    if (typeof label.source !== "string" || !expected.delete(label.source)) {
      throw new Error(`Label ${index} has a duplicate or unknown source.`);
    }
    if (!isRelevanceScore(label.score)) throw new Error(`Label ${index} has an invalid score.`);
    if (typeof label.misleading !== "boolean") {
      throw new Error(`Label ${index} has an invalid misleading flag.`);
    }
    if (typeof label.rationale !== "string" || !label.rationale.trim()) {
      throw new Error(`Label ${index} has no rationale.`);
    }
    return {
      source: label.source,
      score: label.score,
      misleading: label.misleading,
      rationale: label.rationale.trim(),
    };
  });
  if (expected.size) throw new Error(`The judge omitted sources: ${[...expected].join(", ")}.`);
  return result;
}

async function judgeIntake(
  client: OpenAI,
  intake: EvalIntake,
  sources: SourceCatalogEntry[],
): Promise<AiJudgment[]> {
  const completion = await client.chat.completions.create({
    ...reasoningModel(),
    messages: [
      {
        role: "system",
        content: `You are an independent evaluator of source-document usefulness for assignment redesign.

Judge every source using only the assignment and source summary supplied. You do not know and must not infer the retrieval system's scores or ranking.

Use this rubric:
3 = directly supplies a strong, concrete redesign idea for this exact assignment.
2 = clearly useful and on-target; a concrete application to this assignment is identifiable.
1 = only generally educational, weakly transferable, or tangential; no clear concrete change follows.
0 = no useful contribution to redesigning this assignment.

Use "misleading" only when applying the source would probably push the redesign in a wrong direction, not merely when it is irrelevant. Do not force scores to vary, but do not award 2 or 3 merely because a source contains generally good educational advice. In each rationale, name the concrete connection or explain why none exists. Return one label for every source.`,
      },
      { role: "user", content: userPrompt(intake, sources) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "source_relevance_labels",
        strict: true,
        schema: responseSchema(sources),
      },
    },
    max_completion_tokens: 12_000,
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error(`The judge returned no content for ${intake.id}.`);
  return validateJudgments(JSON.parse(content), sources);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");
  const intakes = requestedIntakes(
    parseIntakes(JSON.parse(readFileSync(join(ROOT, "eval", "intakes.json"), "utf8"))),
  );
  const sources = parseSourceCatalog(
    JSON.parse(readFileSync(join(ROOT, "eval", "sources.json"), "utf8")),
  );
  const labelsPath = resolve(ROOT, argument("output") ?? "eval/labels/ai.json");
  const auditPath = resolve(ROOT, argument("audit") ?? "eval/ai/ai-labels.audit.json");
  const client = new OpenAI();
  const judgments: Record<string, AiJudgment[]> = {};

  for (const [index, intake] of intakes.entries()) {
    process.stdout.write(`Judging ${index + 1}/${intakes.length}: ${intake.id}... `);
    judgments[intake.id] = await judgeIntake(client, intake, sources);
    console.log("done");
  }

  const generatedAt = new Date().toISOString();
  const labels: LabelsFile = {
    labeler: "ai",
    labeledAt: generatedAt,
    corpusBuiltAt: index.builtAt,
    labels: Object.fromEntries(
      intakes.map((intake) => [
        intake.id,
        Object.fromEntries(
          judgments[intake.id].map(({ source, score, misleading }) => [
            source,
            { score, misleading },
          ]),
        ),
      ]),
    ),
  };
  const audit = {
    generatedAt,
    corpusBuiltAt: index.builtAt,
    model: reasoningModel(),
    promptVersion: PROMPT_VERSION,
    inputs: "assignment fields plus source-catalog summaries; no retrieval scores or ranks",
    judgments,
  };

  mkdirSync(dirname(labelsPath), { recursive: true });
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(labelsPath, `${JSON.stringify(labels, null, 2)}\n`, "utf8");
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(`Wrote ${labelsPath}.`);
  console.log(`Wrote ${auditPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
