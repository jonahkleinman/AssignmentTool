export const RELEVANCE_SCORES = [0, 1, 2, 3] as const;

export type RelevanceScore = (typeof RELEVANCE_SCORES)[number];
export type ExpectedProfile = "on-corpus" | "mixed" | "off-corpus";
export type QueryVariant = "structured" | "markdown-reparse";

export interface EvalIntake {
  id: string;
  grade: string;
  assessment: string;
  parts: string;
  goal: string;
  time: string;
  sourceDoc?: string;
  expectedProfile: ExpectedProfile;
}

export interface SourceCatalogEntry {
  source: string;
  chunkCount: number;
  summary: string;
}

export interface RelevanceLabel {
  score: RelevanceScore;
  misleading: boolean;
}

export type IntakeLabels = Record<string, Record<string, RelevanceLabel>>;

export interface LabelsFile {
  labeler: string;
  labeledAt: string;
  corpusBuiltAt: string;
  labels: IntakeLabels;
}

export interface RetrievalConfig {
  k: number;
  threshold: number;
  lexicalBoost: boolean;
  queryVariant: QueryVariant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${path} must be a ${allowEmpty ? "string" : "non-empty string"}.`);
  }
  return value;
}

export function parseIntakes(value: unknown): EvalIntake[] {
  if (!Array.isArray(value)) throw new Error("intakes must be an array.");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const path = `intakes[${index}]`;
    if (!isRecord(item)) throw new Error(`${path} must be an object.`);
    const id = requireString(item.id, `${path}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${path}.id must be a stable lowercase slug.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate intake id: ${id}.`);
    ids.add(id);
    const expectedProfile = item.expectedProfile;
    if (
      expectedProfile !== "on-corpus" &&
      expectedProfile !== "mixed" &&
      expectedProfile !== "off-corpus"
    ) {
      throw new Error(`${path}.expectedProfile is invalid.`);
    }
    return {
      id,
      grade: requireString(item.grade, `${path}.grade`),
      assessment: requireString(item.assessment, `${path}.assessment`),
      parts: requireString(item.parts, `${path}.parts`),
      goal: requireString(item.goal, `${path}.goal`),
      time: requireString(item.time, `${path}.time`),
      ...(typeof item.sourceDoc === "string" && item.sourceDoc.trim()
        ? { sourceDoc: item.sourceDoc }
        : {}),
      expectedProfile,
    };
  });
}

export function parseSourceCatalog(value: unknown): SourceCatalogEntry[] {
  if (!Array.isArray(value)) throw new Error("sources must be an array.");
  const names = new Set<string>();
  return value.map((item, index) => {
    const path = `sources[${index}]`;
    if (!isRecord(item)) throw new Error(`${path} must be an object.`);
    const source = requireString(item.source, `${path}.source`);
    if (names.has(source)) throw new Error(`Duplicate source: ${source}.`);
    names.add(source);
    if (!Number.isInteger(item.chunkCount) || (item.chunkCount as number) < 1) {
      throw new Error(`${path}.chunkCount must be a positive integer.`);
    }
    return {
      source,
      chunkCount: item.chunkCount as number,
      summary: requireString(item.summary, `${path}.summary`),
    };
  });
}

export function isRelevanceScore(value: unknown): value is RelevanceScore {
  return typeof value === "number" && RELEVANCE_SCORES.includes(value as RelevanceScore);
}

export function parseLabelsFile(value: unknown): LabelsFile {
  if (!isRecord(value)) throw new Error("labels file must be an object.");
  if (!isRecord(value.labels)) throw new Error("labels must be an object.");
  const labels: IntakeLabels = {};
  for (const [intakeId, intakeValue] of Object.entries(value.labels)) {
    if (!isRecord(intakeValue)) throw new Error(`labels.${intakeId} must be an object.`);
    labels[intakeId] = {};
    for (const [source, labelValue] of Object.entries(intakeValue)) {
      if (!isRecord(labelValue) || !isRelevanceScore(labelValue.score)) {
        throw new Error(`labels.${intakeId}.${source}.score must be 0, 1, 2, or 3.`);
      }
      if (typeof labelValue.misleading !== "boolean") {
        throw new Error(`labels.${intakeId}.${source}.misleading must be boolean.`);
      }
      labels[intakeId][source] = {
        score: labelValue.score,
        misleading: labelValue.misleading,
      };
    }
  }
  return {
    labeler: requireString(value.labeler, "labeler"),
    labeledAt: requireString(value.labeledAt, "labeledAt", true),
    corpusBuiltAt: requireString(value.corpusBuiltAt, "corpusBuiltAt"),
    labels,
  };
}

export function reconcileLabels(
  file: LabelsFile | null,
  labeler: string,
  corpusBuiltAt: string,
  intakes: EvalIntake[],
  sources: SourceCatalogEntry[],
): LabelsFile {
  const labels: IntakeLabels = {};
  for (const intake of intakes) {
    labels[intake.id] = {};
    for (const { source } of sources) {
      labels[intake.id][source] = file?.labels[intake.id]?.[source] ?? {
        score: 0,
        misleading: false,
      };
    }
  }
  return {
    labeler,
    labeledAt: file?.labeledAt ?? "",
    corpusBuiltAt: file?.corpusBuiltAt ?? corpusBuiltAt,
    labels,
  };
}
