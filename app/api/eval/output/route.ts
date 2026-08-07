import { isEvalRequestAuthorized } from "@/lib/eval/auth";
import { outputEvalStorage } from "@/lib/eval/output-storage";
import {
  OUTPUT_EVAL_SCHEMA_VERSION,
  isOutputJudgmentComplete,
  normalizeOutputRunId,
  parseOutputJudgmentDraft,
  type OutputEvalJudgment,
} from "@/lib/eval/output-types";
import { normalizeLabeler } from "@/lib/eval/storage";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!isEvalRequestAuthorized(request)) {
    return jsonError("Evaluation access is required.", 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }
  if (
    !isRecord(body) ||
    typeof body.runId !== "string" ||
    typeof body.trialId !== "string" ||
    typeof body.labeler !== "string"
  ) {
    return jsonError("A run, trial, labeler, and judgment are required.", 400);
  }

  try {
    const runId = normalizeOutputRunId(body.runId);
    const labeler = normalizeLabeler(body.labeler, "");
    if (!labeler) return jsonError("The labeler name is invalid.", 400);
    const draft = parseOutputJudgmentDraft(body.judgment);
    const storage = outputEvalStorage();
    const [run, trial] = await Promise.all([
      storage.loadRun(runId),
      storage.loadTrial(runId, body.trialId),
    ]);
    if (!run || !trial || trial.runId !== runId) {
      return jsonError("That output evaluation trial was not found.", 404);
    }
    const updatedAt = new Date().toISOString();
    const existing = await storage.loadJudgment(runId, labeler, trial.id);
    const complete = isOutputJudgmentComplete(draft);
    const judgment: OutputEvalJudgment = {
      schemaVersion: OUTPUT_EVAL_SCHEMA_VERSION,
      runId,
      trialId: trial.id,
      labeler,
      ...draft,
      updatedAt,
      ...(complete ? { completedAt: existing?.completedAt ?? updatedAt } : {}),
    };
    await storage.saveJudgment(judgment);
    return Response.json({ savedAt: updatedAt, complete });
  } catch (error) {
    console.error("[eval-output] save failed", error);
    return jsonError(error instanceof Error ? error.message : "Judgment could not be saved.", 500);
  }
}

