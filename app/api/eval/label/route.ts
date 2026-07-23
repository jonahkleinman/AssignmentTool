import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadKnowledgeIndex } from "@/lib/knowledge";
import { isEvalRequestAuthorized } from "@/lib/eval/auth";
import {
  parseIntakes,
  parseLabelsFile,
  parseSourceCatalog,
  reconcileLabels,
} from "@/lib/eval/types";
import { normalizeLabeler, saveLabels } from "@/lib/eval/storage";

export const runtime = "nodejs";

const ROOT = process.cwd();

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
  if (!isRecord(body) || typeof body.labeler !== "string" || !isRecord(body.file)) {
    return jsonError("A labeler and labels file are required.", 400);
  }
  const labeler = normalizeLabeler(body.labeler, "");
  if (!labeler) return jsonError("Labeler names may use letters, numbers, hyphens, and underscores.", 400);

  try {
    const index = loadKnowledgeIndex();
    if (!index) return jsonError("The knowledge index is unavailable.", 503);
    const [intakesRaw, sourcesRaw] = await Promise.all([
      readFile(join(ROOT, "eval", "intakes.json"), "utf8"),
      readFile(join(ROOT, "eval", "sources.json"), "utf8"),
    ]);
    const intakes = parseIntakes(JSON.parse(intakesRaw));
    const sources = parseSourceCatalog(JSON.parse(sourcesRaw));
    const incoming = parseLabelsFile(body.file);
    const reconciled = reconcileLabels(incoming, labeler, index.builtAt, intakes, sources);
    const saved = {
      ...reconciled,
      labeler,
      labeledAt: new Date().toISOString(),
      corpusBuiltAt: index.builtAt,
    };
    await saveLabels(saved);
    return Response.json({ savedAt: saved.labeledAt, corpusBuiltAt: saved.corpusBuiltAt });
  } catch (error) {
    console.error("[eval-label] save failed", error);
    return jsonError(error instanceof Error ? error.message : "Labels could not be saved.", 500);
  }
}
