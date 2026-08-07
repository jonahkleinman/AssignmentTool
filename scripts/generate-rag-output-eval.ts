import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config as loadEnv } from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

loadEnv({ path: [".env.local", ".env"], quiet: true });

import {
  buildFocusedKnowledgeQuery,
  formatKnowledgeBlock,
  loadKnowledgeIndex,
  scoreKnowledgeChunks,
  type RetrievedPassage,
  type ScoredKnowledgeChunk,
} from "../lib/knowledge";
import { outputEvalStorage } from "../lib/eval/output-storage";
import {
  OUTPUT_EVAL_PROMPT_VERSION,
  OUTPUT_EVAL_SCHEMA_VERSION,
  type OutputCondition,
  type OutputEvalGeneration,
  type OutputEvalRetrievedSource,
  type OutputEvalRun,
  type OutputEvalTrial,
} from "../lib/eval/output-types";
import { parseIntakes, type EvalIntake } from "../lib/eval/types";
import { reasoningModel } from "../lib/model";
import { SYSTEM_PROMPT } from "../lib/prompt";

const ROOT = process.cwd();
const DEFAULT_INTAKE_IDS = [
  "austen-letters-form",
  "neuroscience-ethics-case",
  "soil-texture-cer",
  "tic-tac-toe-java",
  "algebra-exp-log-test",
  "spanish-11-migration-synthesis",
] as const;
const MAX_COMPLETION_TOKENS = 3000;
const RETRIEVAL = {
  queryVariant: "structured",
  lexicalBoost: true,
  k: 10,
  uniqueBy: "source",
  threshold: 0.3,
  thresholdScore: "cosine",
} as const;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedIntakes(all: EvalIntake[]): EvalIntake[] {
  const raw = argument("intakes");
  const requested = new Set(
    (raw ? raw.split(",") : [...DEFAULT_INTAKE_IDS]).map((id) => id.trim()).filter(Boolean),
  );
  const selected = all.filter((intake) => requested.delete(intake.id));
  if (requested.size) throw new Error(`Unknown intake ids: ${[...requested].join(", ")}.`);
  if (!selected.length) throw new Error("No intakes selected.");
  return selected;
}

function defaultRunId(): string {
  return `rag-v1-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase()}`;
}

function buildUserPrompt(intake: EvalIntake): string {
  return [
    "Use this complete assignment intake to propose redesigns.",
    "Do not ask clarifying questions; make the strongest useful proposals possible from the supplied information.",
    "",
    `Grade or age level: ${intake.grade}`,
    `Assignment type: ${intake.assessment}`,
    `Assignment components / description: ${intake.parts}`,
    `Learning goals: ${intake.goal}`,
    `Time budget: ${intake.time}`,
    "",
    "Source assignment:",
    intake.sourceDoc ?? "(not supplied)",
  ].join("\n");
}

function buildQuery(intake: EvalIntake): string {
  return buildFocusedKnowledgeQuery({
    assignmentType: intake.assessment,
    parts: intake.parts,
    goal: intake.goal,
    time: intake.time,
    sourceDoc: intake.sourceDoc,
  });
}

function collapseToUniqueSources(chunks: ScoredKnowledgeChunk[]): ScoredKnowledgeChunk[] {
  const seen = new Set<string>();
  const selected: ScoredKnowledgeChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.cosineScore < RETRIEVAL.threshold || seen.has(chunk.source)) continue;
    seen.add(chunk.source);
    selected.push(chunk);
    if (selected.length === RETRIEVAL.k) break;
  }
  return selected;
}

function retrievedMetadata(chunks: ScoredKnowledgeChunk[]): OutputEvalRetrievedSource[] {
  return chunks.map((chunk, index) => ({
    rank: index + 1,
    source: chunk.source,
    page: chunk.page,
    chunkId: chunk.id,
    cosineScore: chunk.cosineScore,
    lexicalBoost: chunk.lexicalBoost,
    combinedScore: chunk.score,
  }));
}

function passages(chunks: ScoredKnowledgeChunk[]): RetrievedPassage[] {
  return chunks.map((chunk) => ({
    source: chunk.source,
    page: chunk.page,
    text: chunk.text,
    score: chunk.score,
  }));
}

async function generate(
  client: OpenAI,
  condition: OutputCondition,
  userPrompt: string,
  knowledgeBlock: string,
): Promise<{ text: string; metadata: OutputEvalGeneration }> {
  const modelConfig = reasoningModel();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(condition === "rag" ? [{ role: "system" as const, content: knowledgeBlock }] : []),
    { role: "user", content: userPrompt },
  ];
  const started = Date.now();
  const response = await client.chat.completions.create({
    ...modelConfig,
    messages,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  });
  const text = response.choices[0]?.message.content?.trim() ?? "";
  if (!text) throw new Error(`${condition} generation returned an empty response.`);
  const usage = response.usage;
  return {
    text,
    metadata: {
      condition,
      model: modelConfig.model,
      ...(modelConfig.reasoning_effort ? { reasoningEffort: modelConfig.reasoning_effort } : {}),
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    },
  };
}

function assertResumeCompatible(run: OutputEvalRun, expected: OutputEvalRun): void {
  const fields: Array<keyof OutputEvalRun> = [
    "promptVersion",
    "systemPrompt",
    "corpusBuiltAt",
    "embeddingModel",
    "model",
    "reasoningEffort",
    "maxCompletionTokens",
  ];
  for (const field of fields) {
    if (run[field] !== expected[field]) {
      throw new Error(`Cannot resume ${run.id}: ${field} differs from the current configuration.`);
    }
  }
  if (JSON.stringify(run.intakeIds) !== JSON.stringify(expected.intakeIds)) {
    throw new Error(`Cannot resume ${run.id}: the selected intakes differ.`);
  }
  if (JSON.stringify(run.retrieval) !== JSON.stringify(expected.retrieval)) {
    throw new Error(`Cannot resume ${run.id}: the frozen retrieval configuration differs.`);
  }
}

async function main(): Promise<void> {
  const allIntakes = parseIntakes(
    JSON.parse(readFileSync(join(ROOT, "eval", "intakes.json"), "utf8")),
  );
  const intakes = requestedIntakes(allIntakes);
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");
  const runId = argument("run-id")?.trim() || defaultRunId();
  const modelConfig = reasoningModel();
  const plannedGenerations = intakes.length * 2;

  console.log(`Run id: ${runId}`);
  console.log(`Pilot intakes: ${intakes.map((intake) => intake.id).join(", ")}`);
  console.log(`Planned generations: ${plannedGenerations} (${intakes.length} trials × 2 arms)`);
  console.log(
    `Frozen RAG arm: structured query, lexical boost on, cosine >= ${RETRIEVAL.threshold}, ` +
      `${RETRIEVAL.k} unique source documents`,
  );
  console.log(`Model: ${modelConfig.model}${modelConfig.reasoning_effort ? ` (${modelConfig.reasoning_effort})` : ""}`);

  if (!process.argv.includes("--run")) {
    console.log("\nDry run only. Re-run with --run to issue paid OpenAI calls.");
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");

  const now = new Date().toISOString();
  const expectedRun: OutputEvalRun = {
    schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
    id: runId,
    status: "generating",
    promptVersion: OUTPUT_EVAL_PROMPT_VERSION,
    systemPrompt: SYSTEM_PROMPT,
    intakeIds: intakes.map((intake) => intake.id),
    corpusBuiltAt: index.builtAt,
    embeddingModel: index.model,
    model: modelConfig.model,
    ...(modelConfig.reasoning_effort ? { reasoningEffort: modelConfig.reasoning_effort } : {}),
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    retrieval: RETRIEVAL,
    createdAt: now,
    updatedAt: now,
  };
  const storage = outputEvalStorage();
  const existing = await storage.loadRun(runId);
  if (existing) assertResumeCompatible(existing, expectedRun);
  const run: OutputEvalRun = existing
    ? { ...existing, status: "generating", updatedAt: now }
    : expectedRun;
  await storage.saveRun(run);

  const client = new OpenAI();
  let completed = 0;
  for (const intake of intakes) {
    if (await storage.loadTrial(runId, intake.id)) {
      completed += 2;
      console.log(`[${intake.id}] already complete; skipping both arms.`);
      continue;
    }

    console.log(`[${intake.id}] embedding structured retrieval query…`);
    const query = buildQuery(intake);
    const embeddingResponse = await client.embeddings.create({ model: index.model, input: query });
    const embedding = embeddingResponse.data[0]?.embedding;
    if (!embedding) throw new Error(`No query embedding returned for ${intake.id}.`);
    const selectedChunks = collapseToUniqueSources(
      scoreKnowledgeChunks(index, query, embedding, RETRIEVAL.lexicalBoost),
    );
    const knowledgeBlock = formatKnowledgeBlock(passages(selectedChunks));
    if (!knowledgeBlock) throw new Error(`No passages cleared the threshold for ${intake.id}.`);

    const userPrompt = buildUserPrompt(intake);
    const generationOrder: OutputCondition[] = randomBytes(1)[0] % 2 === 0
      ? ["no-rag", "rag"]
      : ["rag", "no-rag"];
    const results = {} as Record<OutputCondition, Awaited<ReturnType<typeof generate>>>;
    for (const condition of generationOrder) {
      console.log(`[${intake.id}] generating ${condition} arm (${completed + 1}/${plannedGenerations})…`);
      results[condition] = await generate(client, condition, userPrompt, knowledgeBlock);
      completed += 1;
    }

    const ragOnLeft = randomBytes(1)[0] % 2 === 0;
    const conditions = ragOnLeft
      ? ({ left: "rag", right: "no-rag" } as const)
      : ({ left: "no-rag", right: "rag" } as const);
    const trial: OutputEvalTrial = {
      schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
      id: intake.id,
      runId,
      intake,
      userPrompt,
      leftOutput: results[conditions.left].text,
      rightOutput: results[conditions.right].text,
      conditions,
      generationOrder,
      generations: {
        rag: results.rag.metadata,
        "no-rag": results["no-rag"].metadata,
      },
      rag: {
        query,
        knowledgeBlock,
        retrievedSources: retrievedMetadata(selectedChunks),
      },
      createdAt: new Date().toISOString(),
    };
    await storage.saveTrial(trial);
    console.log(`[${intake.id}] saved blind trial with ${selectedChunks.length} unique sources.`);
  }

  const ready: OutputEvalRun = {
    ...run,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  await storage.saveRun(ready);
  console.log(`\nRun ${runId} is ready.`);
  console.log(
    `Review URL: https://prototype.betterconnect.app/eval/output?run=${encodeURIComponent(runId)}&labeler=jonah`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

