import type { EvalIntake, ExpectedProfile } from "./types";

export const OUTPUT_EVAL_SCHEMA_VERSION = 1 as const;
export const OUTPUT_EVAL_PROMPT_VERSION = "rag-output-v1";

export const OUTPUT_CONDITIONS = ["rag", "no-rag"] as const;
export const OUTPUT_SIDES = ["left", "right"] as const;
export const PAIRWISE_CHOICES = ["left", "right", "tie"] as const;
export const IRRELEVANT_ADVICE_CHOICES = ["neither", "left", "right", "both"] as const;

export type OutputCondition = (typeof OUTPUT_CONDITIONS)[number];
export type OutputSide = (typeof OUTPUT_SIDES)[number];
export type PairwiseChoice = (typeof PAIRWISE_CHOICES)[number];
export type IrrelevantAdviceChoice = (typeof IRRELEVANT_ADVICE_CHOICES)[number];

export interface OutputEvalRetrievalConfig {
  queryVariant: "structured";
  lexicalBoost: true;
  k: 10;
  uniqueBy: "source";
  threshold: 0.3;
  thresholdScore: "cosine";
}

export interface OutputEvalRun {
  schemaVersion: typeof OUTPUT_EVAL_SCHEMA_VERSION;
  id: string;
  status: "generating" | "ready";
  promptVersion: string;
  systemPrompt: string;
  intakeIds: string[];
  corpusBuiltAt: string;
  embeddingModel: string;
  model: string;
  reasoningEffort?: string;
  maxCompletionTokens: number;
  retrieval: OutputEvalRetrievalConfig;
  createdAt: string;
  updatedAt: string;
}

export interface OutputEvalRetrievedSource {
  rank: number;
  source: string;
  page: string;
  chunkId: string;
  cosineScore: number;
  lexicalBoost: number;
  combinedScore: number;
}

export interface OutputEvalUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface OutputEvalGeneration {
  condition: OutputCondition;
  model: string;
  reasoningEffort?: string;
  latencyMs: number;
  usage: OutputEvalUsage;
}

export interface OutputEvalTrial {
  schemaVersion: typeof OUTPUT_EVAL_SCHEMA_VERSION;
  id: string;
  runId: string;
  intake: EvalIntake;
  userPrompt: string;
  leftOutput: string;
  rightOutput: string;
  conditions: Record<OutputSide, OutputCondition>;
  generationOrder: OutputCondition[];
  generations: Record<OutputCondition, OutputEvalGeneration>;
  rag: {
    query: string;
    knowledgeBlock: string;
    retrievedSources: OutputEvalRetrievedSource[];
  };
  createdAt: string;
}

export interface OutputJudgmentDraft {
  overall: PairwiseChoice | null;
  specificity: PairwiseChoice | null;
  feasibility: PairwiseChoice | null;
  irrelevantAdvice: IrrelevantAdviceChoice | null;
  rationale: string;
}

export interface OutputEvalJudgment extends OutputJudgmentDraft {
  schemaVersion: typeof OUTPUT_EVAL_SCHEMA_VERSION;
  runId: string;
  trialId: string;
  labeler: string;
  updatedAt: string;
  completedAt?: string;
}

export interface BlindOutputTrial {
  id: string;
  intake: {
    id: string;
    grade: string;
    assessment: string;
    parts: string;
    goal: string;
    time: string;
    sourceDoc?: string;
  };
  leftOutput: string;
  rightOutput: string;
}

export interface BlindOutputRun {
  id: string;
  trials: BlindOutputTrial[];
}

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function requireString(value: unknown, path: string): string {
  if (!isString(value) || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value;
}

export function normalizeOutputRunId(value: string | undefined): string {
  const candidate = value?.trim() ?? "";
  if (!RUN_ID_PATTERN.test(candidate)) {
    throw new Error("Run ids may use letters, numbers, hyphens, and underscores.");
  }
  return candidate;
}

export function isOutputJudgmentComplete(value: OutputJudgmentDraft): boolean {
  return Boolean(
    value.overall && value.specificity && value.feasibility && value.irrelevantAdvice,
  );
}

export function emptyOutputJudgment(): OutputJudgmentDraft {
  return {
    overall: null,
    specificity: null,
    feasibility: null,
    irrelevantAdvice: null,
    rationale: "",
  };
}

function parsePairwise(value: unknown, path: string): PairwiseChoice | null {
  if (value === null) return null;
  if (value === "left" || value === "right" || value === "tie") return value;
  throw new Error(`${path} must be left, right, tie, or null.`);
}

export function parseOutputJudgmentDraft(value: unknown): OutputJudgmentDraft {
  if (!isRecord(value)) throw new Error("judgment must be an object.");
  const irrelevantAdvice = value.irrelevantAdvice;
  if (
    irrelevantAdvice !== null &&
    irrelevantAdvice !== "neither" &&
    irrelevantAdvice !== "left" &&
    irrelevantAdvice !== "right" &&
    irrelevantAdvice !== "both"
  ) {
    throw new Error("judgment.irrelevantAdvice is invalid.");
  }
  if (!isString(value.rationale)) throw new Error("judgment.rationale must be a string.");
  if (value.rationale.length > 2000) throw new Error("Rationale must be 2,000 characters or less.");
  return {
    overall: parsePairwise(value.overall, "judgment.overall"),
    specificity: parsePairwise(value.specificity, "judgment.specificity"),
    feasibility: parsePairwise(value.feasibility, "judgment.feasibility"),
    irrelevantAdvice,
    rationale: value.rationale,
  };
}

export function parseOutputEvalRun(value: unknown): OutputEvalRun {
  if (!isRecord(value)) throw new Error("Output evaluation run must be an object.");
  const id = normalizeOutputRunId(requireString(value.id, "run.id"));
  if (value.schemaVersion !== OUTPUT_EVAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported output evaluation schema for ${id}.`);
  }
  if (value.status !== "generating" && value.status !== "ready") {
    throw new Error("run.status is invalid.");
  }
  if (!isRecord(value.retrieval)) throw new Error("run.retrieval must be an object.");
  const retrieval = value.retrieval;
  if (
    retrieval.queryVariant !== "structured" ||
    retrieval.lexicalBoost !== true ||
    retrieval.k !== 10 ||
    retrieval.uniqueBy !== "source" ||
    retrieval.threshold !== 0.3 ||
    retrieval.thresholdScore !== "cosine"
  ) {
    throw new Error("run.retrieval does not match the frozen v1 configuration.");
  }
  if (!Number.isInteger(value.maxCompletionTokens) || (value.maxCompletionTokens as number) < 1) {
    throw new Error("run.maxCompletionTokens must be a positive integer.");
  }
  return {
    schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
    id,
    status: value.status,
    promptVersion: requireString(value.promptVersion, "run.promptVersion"),
    systemPrompt: requireString(value.systemPrompt, "run.systemPrompt"),
    intakeIds: requireStringArray(value.intakeIds, "run.intakeIds"),
    corpusBuiltAt: requireString(value.corpusBuiltAt, "run.corpusBuiltAt"),
    embeddingModel: requireString(value.embeddingModel, "run.embeddingModel"),
    model: requireString(value.model, "run.model"),
    ...(isString(value.reasoningEffort) && value.reasoningEffort
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    maxCompletionTokens: value.maxCompletionTokens as number,
    retrieval: {
      queryVariant: "structured",
      lexicalBoost: true,
      k: 10,
      uniqueBy: "source",
      threshold: 0.3,
      thresholdScore: "cosine",
    },
    createdAt: requireString(value.createdAt, "run.createdAt"),
    updatedAt: requireString(value.updatedAt, "run.updatedAt"),
  };
}

function parseExpectedProfile(value: unknown): ExpectedProfile {
  if (value === "on-corpus" || value === "mixed" || value === "off-corpus") return value;
  throw new Error("trial.intake.expectedProfile is invalid.");
}

function parseIntake(value: unknown): EvalIntake {
  if (!isRecord(value)) throw new Error("trial.intake must be an object.");
  return {
    id: requireString(value.id, "trial.intake.id"),
    grade: requireString(value.grade, "trial.intake.grade"),
    assessment: requireString(value.assessment, "trial.intake.assessment"),
    parts: requireString(value.parts, "trial.intake.parts"),
    goal: requireString(value.goal, "trial.intake.goal"),
    time: requireString(value.time, "trial.intake.time"),
    ...(isString(value.sourceDoc) && value.sourceDoc.trim() ? { sourceDoc: value.sourceDoc } : {}),
    expectedProfile: parseExpectedProfile(value.expectedProfile),
  };
}

export function parseOutputEvalTrial(value: unknown): OutputEvalTrial {
  if (!isRecord(value)) throw new Error("Output evaluation trial must be an object.");
  if (value.schemaVersion !== OUTPUT_EVAL_SCHEMA_VERSION) {
    throw new Error("Unsupported output evaluation trial schema.");
  }
  if (!isRecord(value.conditions) || !isRecord(value.generations) || !isRecord(value.rag)) {
    throw new Error("Output evaluation trial metadata is incomplete.");
  }
  const left = value.conditions.left;
  const right = value.conditions.right;
  if (
    (left !== "rag" && left !== "no-rag") ||
    (right !== "rag" && right !== "no-rag") ||
    left === right
  ) {
    throw new Error("trial.conditions must contain one RAG and one no-RAG arm.");
  }
  // Trial documents are generated by the trusted CLI. The detailed generation
  // metadata is preserved verbatim after the blindness-critical fields above
  // are checked; the exporter is the only client of those hidden details.
  return {
    ...(value as unknown as OutputEvalTrial),
    schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
    id: requireString(value.id, "trial.id"),
    runId: normalizeOutputRunId(requireString(value.runId, "trial.runId")),
    intake: parseIntake(value.intake),
    userPrompt: requireString(value.userPrompt, "trial.userPrompt"),
    leftOutput: requireString(value.leftOutput, "trial.leftOutput"),
    rightOutput: requireString(value.rightOutput, "trial.rightOutput"),
    conditions: { left, right },
    createdAt: requireString(value.createdAt, "trial.createdAt"),
  };
}

export function parseOutputEvalJudgment(value: unknown): OutputEvalJudgment {
  if (!isRecord(value)) throw new Error("Output evaluation judgment must be an object.");
  if (value.schemaVersion !== OUTPUT_EVAL_SCHEMA_VERSION) {
    throw new Error("Unsupported output evaluation judgment schema.");
  }
  return {
    schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
    runId: normalizeOutputRunId(requireString(value.runId, "judgment.runId")),
    trialId: requireString(value.trialId, "judgment.trialId"),
    labeler: requireString(value.labeler, "judgment.labeler"),
    ...parseOutputJudgmentDraft(value),
    updatedAt: requireString(value.updatedAt, "judgment.updatedAt"),
    ...(isString(value.completedAt) && value.completedAt ? { completedAt: value.completedAt } : {}),
  };
}

export function toBlindOutputTrial(trial: OutputEvalTrial): BlindOutputTrial {
  const { id, grade, assessment, parts, goal, time, sourceDoc } = trial.intake;
  return {
    id: trial.id,
    intake: {
      id,
      grade,
      assessment,
      parts,
      goal,
      time,
      ...(sourceDoc ? { sourceDoc } : {}),
    },
    leftOutput: trial.leftOutput,
    rightOutput: trial.rightOutput,
  };
}

