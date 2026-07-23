import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cookies } from "next/headers";

import { loadKnowledgeIndex } from "@/lib/knowledge";
import {
  EVAL_ACCESS_COOKIE,
  evalAccessConfigured,
  isEvalAccessTokenValid,
} from "@/lib/eval/auth";
import { loadLabels, normalizeLabeler } from "@/lib/eval/storage";
import { parseIntakes, parseSourceCatalog, reconcileLabels } from "@/lib/eval/types";

import { LabelingClient } from "./labeling-client";
import { EvalAccessGate } from "./access-gate";

export default async function LabelingPage({
  searchParams,
}: {
  searchParams: Promise<{ labeler?: string | string[] }>;
}) {
  const query = await searchParams;
  const requested = Array.isArray(query.labeler) ? query.labeler[0] : query.labeler;
  const labeler = normalizeLabeler(requested);
  const cookieStore = await cookies();
  const authorized = isEvalAccessTokenValid(cookieStore.get(EVAL_ACCESS_COOKIE)?.value);
  if (!authorized) {
    return <EvalAccessGate configured={evalAccessConfigured()} labeler={labeler} />;
  }
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("The knowledge index is unavailable.");
  const [intakesRaw, sourcesRaw, saved] = await Promise.all([
    readFile(join(process.cwd(), "eval", "intakes.json"), "utf8"),
    readFile(join(process.cwd(), "eval", "sources.json"), "utf8"),
    loadLabels(labeler),
  ]);
  const intakes = parseIntakes(JSON.parse(intakesRaw));
  const sources = parseSourceCatalog(JSON.parse(sourcesRaw));
  const labels = reconcileLabels(saved, labeler, index.builtAt, intakes, sources);

  return (
    <LabelingClient
      intakes={intakes}
      sources={sources}
      initialFile={labels}
      stale={Boolean(saved && saved.corpusBuiltAt !== index.builtAt)}
    />
  );
}
