import { cookies } from "next/headers";

import {
  EVAL_ACCESS_COOKIE,
  evalAccessConfigured,
  isEvalAccessTokenValid,
} from "@/lib/eval/auth";
import { outputEvalStorage } from "@/lib/eval/output-storage";
import {
  emptyOutputJudgment,
  normalizeOutputRunId,
  toBlindOutputTrial,
  type OutputJudgmentDraft,
} from "@/lib/eval/output-types";
import { normalizeLabeler } from "@/lib/eval/storage";

import { EvalAccessGate } from "../label/access-gate";
import { OutputReviewClient } from "./output-review-client";

function Message({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-5 py-12">
      <div className="w-full rounded-2xl border border-line bg-panel p-8 shadow-2xl shadow-black/20">
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-mint">
          Private output review
        </p>
        <div className="mt-5 text-base leading-relaxed text-ink-soft">{children}</div>
      </div>
    </main>
  );
}

export default async function OutputEvaluationPage({
  searchParams,
}: {
  searchParams: Promise<{
    run?: string | string[];
    labeler?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const requestedLabeler = Array.isArray(query.labeler) ? query.labeler[0] : query.labeler;
  const labeler = normalizeLabeler(requestedLabeler);
  const requestedRun = Array.isArray(query.run) ? query.run[0] : query.run;
  const cookieStore = await cookies();
  const authorized = isEvalAccessTokenValid(cookieStore.get(EVAL_ACCESS_COOKIE)?.value);
  if (!authorized) {
    return (
      <EvalAccessGate
        configured={evalAccessConfigured()}
        labeler={labeler}
        title="Blind redesign comparison"
        description="Compare two anonymous redesigns of the same assignment. Their generation conditions stay hidden until the full review is exported."
      />
    );
  }
  if (!requestedRun) {
    return <Message>The review link is missing its run id. Open the complete link produced by the generation command.</Message>;
  }

  let runId: string;
  try {
    runId = normalizeOutputRunId(requestedRun);
  } catch (error) {
    return <Message>{error instanceof Error ? error.message : "The run id is invalid."}</Message>;
  }

  const storage = outputEvalStorage();
  const [run, trials, allJudgments] = await Promise.all([
    storage.loadRun(runId),
    storage.listTrials(runId),
    storage.listJudgments(runId),
  ]);
  if (!run) return <Message>That output evaluation run could not be found.</Message>;
  if (run.status !== "ready") {
    return <Message>This run is still being generated. Refresh after the generation command finishes.</Message>;
  }
  const orderedTrials = run.intakeIds.flatMap((id) => {
    const trial = trials.find((candidate) => candidate.id === id);
    return trial ? [trial] : [];
  });
  if (orderedTrials.length !== run.intakeIds.length) {
    return <Message>This run is missing one or more generated trials.</Message>;
  }
  const judgments = allJudgments.filter((judgment) => judgment.labeler === labeler);
  const initialJudgments: Record<string, OutputJudgmentDraft> = {};
  for (const trial of orderedTrials) {
    const saved = judgments.find((judgment) => judgment.trialId === trial.id);
    initialJudgments[trial.id] = saved
      ? {
          overall: saved.overall,
          specificity: saved.specificity,
          feasibility: saved.feasibility,
          irrelevantAdvice: saved.irrelevantAdvice,
          rationale: saved.rationale,
        }
      : emptyOutputJudgment();
  }

  // This is the blindness boundary: only anonymous outputs and assignment
  // fields cross from this Server Component into the client bundle.
  return (
    <OutputReviewClient
      run={{ id: run.id, trials: orderedTrials.map(toBlindOutputTrial) }}
      labeler={labeler}
      initialJudgments={initialJudgments}
    />
  );
}

