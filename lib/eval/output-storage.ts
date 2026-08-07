import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getEvalFirestore, normalizeLabeler } from "./storage";
import {
  normalizeOutputRunId,
  parseOutputEvalJudgment,
  parseOutputEvalRun,
  parseOutputEvalTrial,
  type OutputEvalJudgment,
  type OutputEvalRun,
  type OutputEvalTrial,
} from "./output-types";

const OUTPUT_RUNS_DIR = join(process.cwd(), "eval", "output-runs");

interface FileRunBundle {
  run: OutputEvalRun;
  trials: Record<string, OutputEvalTrial>;
  judgments: Record<string, OutputEvalJudgment>;
}

export interface OutputEvalStorage {
  loadRun(runId: string): Promise<OutputEvalRun | null>;
  saveRun(run: OutputEvalRun): Promise<void>;
  loadTrial(runId: string, trialId: string): Promise<OutputEvalTrial | null>;
  listTrials(runId: string): Promise<OutputEvalTrial[]>;
  saveTrial(trial: OutputEvalTrial): Promise<void>;
  loadJudgment(runId: string, labeler: string, trialId: string): Promise<OutputEvalJudgment | null>;
  listJudgments(runId: string): Promise<OutputEvalJudgment[]>;
  saveJudgment(judgment: OutputEvalJudgment): Promise<void>;
}

function filePath(runId: string): string {
  return join(OUTPUT_RUNS_DIR, `${normalizeOutputRunId(runId)}.json`);
}

function judgmentId(labeler: string, trialId: string): string {
  return `${normalizeLabeler(labeler, "")}--${trialId}`;
}

async function readBundle(runId: string): Promise<FileRunBundle | null> {
  try {
    const raw = JSON.parse(await readFile(filePath(runId), "utf8")) as Record<string, unknown>;
    const trialsRaw = raw.trials as Record<string, unknown> | undefined;
    const judgmentsRaw = raw.judgments as Record<string, unknown> | undefined;
    return {
      run: parseOutputEvalRun(raw.run),
      trials: Object.fromEntries(
        Object.entries(trialsRaw ?? {}).map(([id, trial]) => [id, parseOutputEvalTrial(trial)]),
      ),
      judgments: Object.fromEntries(
        Object.entries(judgmentsRaw ?? {}).map(([id, judgment]) => [
          id,
          parseOutputEvalJudgment(judgment),
        ]),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeBundle(bundle: FileRunBundle): Promise<void> {
  const path = filePath(bundle.run.id);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export const fileOutputEvalStorage: OutputEvalStorage = {
  async loadRun(runId) {
    return (await readBundle(runId))?.run ?? null;
  },
  async saveRun(run) {
    const validated = parseOutputEvalRun(run);
    const current = await readBundle(validated.id);
    await writeBundle(current ? { ...current, run: validated } : {
      run: validated,
      trials: {},
      judgments: {},
    });
  },
  async loadTrial(runId, trialId) {
    return (await readBundle(runId))?.trials[trialId] ?? null;
  },
  async listTrials(runId) {
    return Object.values((await readBundle(runId))?.trials ?? {}).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  },
  async saveTrial(trial) {
    const validated = parseOutputEvalTrial(trial);
    const current = await readBundle(validated.runId);
    if (!current) throw new Error(`Output evaluation run ${validated.runId} does not exist.`);
    current.trials[validated.id] = validated;
    await writeBundle(current);
  },
  async loadJudgment(runId, labeler, trialId) {
    return (await readBundle(runId))?.judgments[judgmentId(labeler, trialId)] ?? null;
  },
  async listJudgments(runId) {
    return Object.values((await readBundle(runId))?.judgments ?? {}).sort((a, b) =>
      judgmentId(a.labeler, a.trialId).localeCompare(judgmentId(b.labeler, b.trialId)),
    );
  },
  async saveJudgment(judgment) {
    const validated = parseOutputEvalJudgment(judgment);
    const current = await readBundle(validated.runId);
    if (!current) throw new Error(`Output evaluation run ${validated.runId} does not exist.`);
    current.judgments[judgmentId(validated.labeler, validated.trialId)] = validated;
    await writeBundle(current);
  },
};

function runsCollection() {
  return getEvalFirestore().collection(
    process.env.FIREBASE_OUTPUT_RUNS_COLLECTION ?? "ragOutputEvalRuns",
  );
}

export const firestoreOutputEvalStorage: OutputEvalStorage = {
  async loadRun(runId) {
    const snapshot = await runsCollection().doc(normalizeOutputRunId(runId)).get();
    return snapshot.exists ? parseOutputEvalRun(snapshot.data()) : null;
  },
  async saveRun(run) {
    const validated = parseOutputEvalRun(run);
    await runsCollection().doc(validated.id).set(validated);
  },
  async loadTrial(runId, trialId) {
    const snapshot = await runsCollection()
      .doc(normalizeOutputRunId(runId))
      .collection("trials")
      .doc(trialId)
      .get();
    return snapshot.exists ? parseOutputEvalTrial(snapshot.data()) : null;
  },
  async listTrials(runId) {
    const snapshot = await runsCollection()
      .doc(normalizeOutputRunId(runId))
      .collection("trials")
      .get();
    return snapshot.docs.map((doc) => parseOutputEvalTrial(doc.data())).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  },
  async saveTrial(trial) {
    const validated = parseOutputEvalTrial(trial);
    await runsCollection()
      .doc(validated.runId)
      .collection("trials")
      .doc(validated.id)
      .set(validated);
  },
  async loadJudgment(runId, labeler, trialId) {
    const snapshot = await runsCollection()
      .doc(normalizeOutputRunId(runId))
      .collection("judgments")
      .doc(judgmentId(labeler, trialId))
      .get();
    return snapshot.exists ? parseOutputEvalJudgment(snapshot.data()) : null;
  },
  async listJudgments(runId) {
    const snapshot = await runsCollection()
      .doc(normalizeOutputRunId(runId))
      .collection("judgments")
      .get();
    return snapshot.docs.map((doc) => parseOutputEvalJudgment(doc.data())).sort((a, b) =>
      judgmentId(a.labeler, a.trialId).localeCompare(judgmentId(b.labeler, b.trialId)),
    );
  },
  async saveJudgment(judgment) {
    const validated = parseOutputEvalJudgment(judgment);
    await runsCollection()
      .doc(validated.runId)
      .collection("judgments")
      .doc(judgmentId(validated.labeler, validated.trialId))
      .set(validated);
  },
};

export function outputEvalStorage(): OutputEvalStorage {
  const configured = (
    process.env.EVAL_OUTPUT_STORAGE ?? process.env.EVAL_LABEL_STORAGE
  )?.trim().toLowerCase();
  if (configured === "file") return fileOutputEvalStorage;
  if (configured === "firestore") return firestoreOutputEvalStorage;
  if (process.env.NODE_ENV === "production") {
    throw new Error("EVAL_OUTPUT_STORAGE must be set to firestore in production.");
  }
  return fileOutputEvalStorage;
}

