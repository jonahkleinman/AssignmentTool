import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

import { outputEvalStorage } from "../lib/eval/output-storage";
import {
  isOutputJudgmentComplete,
  normalizeOutputRunId,
  type OutputCondition,
  type OutputEvalJudgment,
  type OutputEvalTrial,
  type OutputSide,
  type PairwiseChoice,
} from "../lib/eval/output-types";
import { normalizeLabeler } from "../lib/eval/storage";

const ROOT = process.cwd();

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function conditionForChoice(
  trial: OutputEvalTrial,
  choice: PairwiseChoice | null,
): OutputCondition | "tie" | null {
  if (!choice || choice === "tie") return choice;
  return trial.conditions[choice];
}

function noisySides(value: OutputEvalJudgment["irrelevantAdvice"]): OutputSide[] {
  if (value === "both") return ["left", "right"];
  if (value === "left" || value === "right") return [value];
  return [];
}

function percent(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

async function main(): Promise<void> {
  const runId = normalizeOutputRunId(argument("run-id"));
  const labeler = normalizeLabeler(argument("labeler"), "");
  if (!labeler) throw new Error("--labeler is required.");
  const storage = outputEvalStorage();
  const [run, trials, allJudgments] = await Promise.all([
    storage.loadRun(runId),
    storage.listTrials(runId),
    storage.listJudgments(runId),
  ]);
  if (!run) throw new Error(`Output evaluation run ${runId} was not found.`);
  const judgments = allJudgments.filter((judgment) => judgment.labeler === labeler);
  const byTrial = new Map(judgments.map((judgment) => [judgment.trialId, judgment]));
  const missing = trials.filter((trial) => {
    const judgment = byTrial.get(trial.id);
    return !judgment || !isOutputJudgmentComplete(judgment);
  });
  if (missing.length && !process.argv.includes("--allow-incomplete")) {
    throw new Error(
      `${missing.length} trial(s) are incomplete for ${labeler}: ${missing.map((trial) => trial.id).join(", ")}. ` +
        "Finish reviewing or pass --allow-incomplete.",
    );
  }

  const completed = trials.flatMap((trial) => {
    const judgment = byTrial.get(trial.id);
    return judgment && isOutputJudgmentComplete(judgment) ? [{ trial, judgment }] : [];
  });
  const overall = { rag: 0, "no-rag": 0, tie: 0 };
  const specificity = { rag: 0, "no-rag": 0, tie: 0 };
  const feasibility = { rag: 0, "no-rag": 0, tie: 0 };
  const irrelevant = { rag: 0, "no-rag": 0 };
  for (const { trial, judgment } of completed) {
    const overallWinner = conditionForChoice(trial, judgment.overall);
    const specificityWinner = conditionForChoice(trial, judgment.specificity);
    const feasibilityWinner = conditionForChoice(trial, judgment.feasibility);
    if (overallWinner) overall[overallWinner] += 1;
    if (specificityWinner) specificity[specificityWinner] += 1;
    if (feasibilityWinner) feasibility[feasibilityWinner] += 1;
    for (const side of noisySides(judgment.irrelevantAdvice)) {
      irrelevant[trial.conditions[side]] += 1;
    }
  }

  const decided = overall.rag + overall["no-rag"];
  const total = completed.length;
  const summary = {
    completedTrials: total,
    overall,
    winRateExcludingTies: {
      rag: percent(overall.rag, decided),
      noRag: percent(overall["no-rag"], decided),
    },
    rateIncludingTies: {
      ragWin: percent(overall.rag, total),
      noRagWin: percent(overall["no-rag"], total),
      tie: percent(overall.tie, total),
    },
    specificity,
    feasibility,
    irrelevantAdviceRate: {
      rag: percent(irrelevant.rag, total),
      noRag: percent(irrelevant["no-rag"], total),
    },
  };
  const perTrial = trials.map((trial) => {
    const judgment = byTrial.get(trial.id);
    return {
      intakeId: trial.intake.id,
      expectedProfile: trial.intake.expectedProfile,
      conditions: trial.conditions,
      judgment: judgment ?? null,
      revealed: judgment
        ? {
            overallWinner: conditionForChoice(trial, judgment.overall),
            specificityWinner: conditionForChoice(trial, judgment.specificity),
            feasibilityWinner: conditionForChoice(trial, judgment.feasibility),
            irrelevantAdviceConditions: noisySides(judgment.irrelevantAdvice).map(
              (side) => trial.conditions[side],
            ),
          }
        : null,
      retrievedSources: trial.rag.retrievedSources,
      generation: trial.generations,
      prompts: {
        user: trial.userPrompt,
        ragKnowledgeBlock: trial.rag.knowledgeBlock,
      },
      outputs: {
        left: trial.leftOutput,
        right: trial.rightOutput,
      },
    };
  });
  const exportedAt = new Date().toISOString();
  const result = {
    exportedAt,
    warning: "Directional pilot only; six trials are not statistically definitive.",
    run,
    labeler,
    summary,
    perTrial,
    rationales: completed
      .filter(({ judgment }) => judgment.rationale.trim())
      .map(({ trial, judgment }) => ({ intakeId: trial.id, rationale: judgment.rationale.trim() })),
  };
  const outputPath = argument("output")
    ? resolve(ROOT, argument("output") as string)
    : join(ROOT, "eval", "output-exports", `${runId}-${labeler}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.table([
    { result: "RAG wins", count: overall.rag },
    { result: "No-RAG wins", count: overall["no-rag"] },
    { result: "Ties", count: overall.tie },
  ]);
  console.log(`RAG win rate excluding ties: ${summary.winRateExcludingTies.rag === null ? "—" : `${(summary.winRateExcludingTies.rag * 100).toFixed(1)}%`}`);
  console.log(`RAG irrelevant-advice rate: ${summary.irrelevantAdviceRate.rag === null ? "—" : `${(summary.irrelevantAdviceRate.rag * 100).toFixed(1)}%`}`);
  console.log(`No-RAG irrelevant-advice rate: ${summary.irrelevantAdviceRate.noRag === null ? "—" : `${(summary.irrelevantAdviceRate.noRag * 100).toFixed(1)}%`}`);
  console.log(`Wrote private reveal export to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

