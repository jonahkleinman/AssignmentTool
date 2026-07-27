import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import "dotenv/config";
import OpenAI from "openai";

import {
  buildFocusedKnowledgeQuery,
  loadKnowledgeIndex,
  scoreKnowledgeChunks,
  type ScoredKnowledgeChunk,
} from "../lib/knowledge";
import { computeRetrievalMetrics, mean, type RankedSource } from "../lib/eval/metrics";
import {
  parseIntakes,
  parseLabelsFile,
  parseSourceCatalog,
  reconcileLabels,
  type EvalIntake,
  type QueryVariant,
  type RetrievalConfig,
} from "../lib/eval/types";

const ROOT = process.cwd();
const INTAKES_PATH = join(ROOT, "eval", "intakes.json");
const SOURCES_PATH = join(ROOT, "eval", "sources.json");
const DEFAULT_LABELS_PATH = join(ROOT, "eval", "labels", "toy.json");
const RESULTS_DIR = join(ROOT, "eval", "results");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArgument(name: string, fallback: number): number {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
  return value;
}

function booleanArgument(name: string, fallback: boolean): boolean {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function selectIntakes<T extends { id: string }>(intakes: T[]): T[] {
  const raw = argument("intakes");
  if (!raw) return intakes;
  const requested = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = intakes.filter((intake) => requested.delete(intake.id));
  if (requested.size) throw new Error(`Unknown intake ids: ${[...requested].join(", ")}.`);
  if (!selected.length) throw new Error("--intakes did not select any intakes.");
  return selected;
}

function isQueryVariant(value: string): value is QueryVariant {
  return value === "structured" || value === "markdown-reparse";
}

function validateConfig(value: RetrievalConfig): RetrievalConfig {
  if (!Number.isInteger(value.k) || value.k < 1) throw new Error("Config k must be positive.");
  if (!Number.isFinite(value.threshold) || value.threshold < -1 || value.threshold > 1) {
    throw new Error("Config threshold must be between -1 and 1.");
  }
  if (typeof value.lexicalBoost !== "boolean") throw new Error("Config lexicalBoost is invalid.");
  if (!isQueryVariant(value.queryVariant)) throw new Error("Config queryVariant is invalid.");
  return value;
}

function readConfigs(): RetrievalConfig[] {
  const configsPath = argument("configs");
  if (configsPath) {
    const values = JSON.parse(readFileSync(resolve(ROOT, configsPath), "utf8")) as unknown;
    if (!Array.isArray(values)) throw new Error("--configs must point to a JSON array.");
    return values.map((value) => validateConfig(value as RetrievalConfig));
  }
  if (process.argv.includes("--sweep")) {
    const configs: RetrievalConfig[] = [];
    for (const k of [3, 4, 5, 10]) {
      for (const threshold of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
        for (const lexicalBoost of [false, true]) {
          for (const queryVariant of ["structured", "markdown-reparse"] as const) {
            configs.push({ k, threshold, lexicalBoost, queryVariant });
          }
        }
      }
    }
    return configs;
  }
  const queryVariant = argument("query-variant") ?? "structured";
  if (!isQueryVariant(queryVariant)) {
    throw new Error("--query-variant must be structured or markdown-reparse.");
  }
  return [
    validateConfig({
      k: numberArgument("k", 5),
      threshold: numberArgument("threshold", 0),
      lexicalBoost: booleanArgument("lexical-boost", true),
      queryVariant,
    }),
  ];
}

function buildMarkdownIntake(intake: EvalIntake): string {
  return [
    `**Grade level:** ${intake.grade}`,
    `**Assignment type:** ${intake.assessment}`,
    `**Assignment components / description:** ${intake.parts}`,
    `**Learning goals:** ${intake.goal}`,
    `**Time budget:** ${intake.time}`,
    intake.sourceDoc
      ? `**Source assignment (verbatim, for grounding):**\n\n${intake.sourceDoc}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractInlineField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, "i");
  return regex.exec(text)?.[1]?.trim() ?? "";
}

function buildQuery(intake: EvalIntake, variant: QueryVariant): string {
  if (variant === "structured") {
    return buildFocusedKnowledgeQuery({
      assignmentType: intake.assessment,
      parts: intake.parts,
      goal: intake.goal,
      time: intake.time,
      sourceDoc: intake.sourceDoc,
    });
  }
  const raw = buildMarkdownIntake(intake);
  return buildFocusedKnowledgeQuery({
    assignmentType: extractInlineField(raw, "Assignment type"),
    parts: extractInlineField(raw, "Assignment components / description"),
    goal: extractInlineField(raw, "Learning goals"),
    time: extractInlineField(raw, "Time budget"),
    raw,
  });
}

function collapseToSources(chunks: ScoredKnowledgeChunk[], threshold: number): RankedSource[] {
  const seen = new Set<string>();
  const ranked: RankedSource[] = [];
  for (const chunk of chunks) {
    if (chunk.cosineScore < threshold || seen.has(chunk.source)) continue;
    seen.add(chunk.source);
    ranked.push({
      source: chunk.source,
      score: chunk.score,
      cosineScore: chunk.cosineScore,
    });
  }
  return ranked;
}

function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");
  const allIntakes = parseIntakes(JSON.parse(readFileSync(INTAKES_PATH, "utf8")));
  const intakes = selectIntakes(allIntakes);
  const sources = parseSourceCatalog(JSON.parse(readFileSync(SOURCES_PATH, "utf8")));
  const labelsPath = resolve(ROOT, argument("labels") ?? DEFAULT_LABELS_PATH);
  if (!existsSync(labelsPath)) throw new Error(`Labels file not found: ${labelsPath}`);
  const parsedLabels = parseLabelsFile(JSON.parse(readFileSync(labelsPath, "utf8")));
  const labels = reconcileLabels(parsedLabels, parsedLabels.labeler, index.builtAt, allIntakes, sources);
  if (parsedLabels.corpusBuiltAt !== index.builtAt) {
    console.warn(
      `Warning: labels were made against ${parsedLabels.corpusBuiltAt}; index is ${index.builtAt}.`,
    );
  }
  const configs = readConfigs();
  const client = new OpenAI();
  const embeddingCache = new Map<string, number[]>();
  const queries = [
    ...new Set(
      configs.flatMap((config) =>
        intakes.map((intake) => buildQuery(intake, config.queryVariant)),
      ),
    ),
  ];
  const uncached = queries.filter((query) => !embeddingCache.has(query));
  if (uncached.length) {
    const response = await client.embeddings.create({ model: index.model, input: uncached });
    response.data.forEach((item, itemIndex) => {
      embeddingCache.set(uncached[itemIndex], item.embedding);
    });
  }

  const runs = configs.map((config) => {
    const perIntake = intakes.map((intake) => {
      const query = buildQuery(intake, config.queryVariant);
      const embedding = embeddingCache.get(query);
      if (!embedding) throw new Error(`No embedding returned for ${intake.id}.`);
      const chunks = scoreKnowledgeChunks(index, query, embedding, config.lexicalBoost);
      const ranked = collapseToSources(chunks, config.threshold);
      const intakeLabels = labels.labels[intake.id];
      const metrics = computeRetrievalMetrics(ranked, intakeLabels, config.k);
      return {
        intakeId: intake.id,
        expectedProfile: intake.expectedProfile,
        metrics,
        topSources: ranked.slice(0, config.k).map((item, rank) => ({
          rank: rank + 1,
          ...item,
          label: intakeLabels[item.source],
        })),
      };
    });
    const aggregate = {
      recallAtK: mean(perIntake.map((item) => item.metrics.recallAtK)),
      precisionAtK: mean(perIntake.map((item) => item.metrics.precisionAtK)),
      mrr: mean(perIntake.map((item) => item.metrics.mrr)),
      ndcgAtK: mean(perIntake.map((item) => item.metrics.ndcgAtK)),
      negativeControlAboveThreshold: mean(
        perIntake
          .filter((item) => item.expectedProfile === "off-corpus")
          .map((item) => item.metrics.aboveThresholdCount),
      ),
    };
    return { config, perIntake, aggregate };
  });

  for (const [runIndex, run] of runs.entries()) {
    console.log(
      `\nRun ${runIndex + 1}/${runs.length}: k=${run.config.k}, threshold=${run.config.threshold}, ` +
        `boost=${run.config.lexicalBoost}, query=${run.config.queryVariant}`,
    );
    console.table(
      run.perIntake.map((item) => ({
        intake: item.intakeId,
        profile: item.expectedProfile,
        recall: formatMetric(item.metrics.recallAtK),
        precision: formatMetric(item.metrics.precisionAtK),
        mrr: formatMetric(item.metrics.mrr),
        nDCG: formatMetric(item.metrics.ndcgAtK),
        above: item.metrics.aboveThresholdCount,
      })),
    );
    console.log(
      `Mean recall ${formatMetric(run.aggregate.recallAtK)} · precision ${formatMetric(run.aggregate.precisionAtK)} · ` +
        `MRR ${formatMetric(run.aggregate.mrr)} · nDCG ${formatMetric(run.aggregate.ndcgAtK)} · ` +
        `negative-control sources above threshold ${formatMetric(run.aggregate.negativeControlAboveThreshold)}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const outputPath = join(RESULTS_DIR, `${generatedAt.replace(/:/g, "-")}.json`);
  const result = {
    generatedAt,
    corpusBuiltAt: index.builtAt,
    embeddingModel: index.model,
    labelsFile: basename(labelsPath),
    labeler: labels.labeler,
    gain: "2^relevance-1",
    runs,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
