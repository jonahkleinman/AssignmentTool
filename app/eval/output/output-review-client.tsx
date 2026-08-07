"use client";

import { useMemo, useRef, useState } from "react";

import { StudioMarkdown } from "@/app/markdown";
import {
  isOutputJudgmentComplete,
  type BlindOutputRun,
  type IrrelevantAdviceChoice,
  type OutputJudgmentDraft,
  type PairwiseChoice,
} from "@/lib/eval/output-types";

type SaveState = "idle" | "pending" | "saved" | "error";

function SaveIndicator({ state }: { state: SaveState }) {
  const copy = {
    idle: "Ready",
    pending: "Saving…",
    saved: "Saved",
    error: "Save failed — keep this page open and try another change",
  }[state];
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-2 font-mono text-[0.68rem] uppercase tracking-[0.15em] ${
        state === "error" ? "text-rose" : state === "pending" ? "text-amber" : "text-ink-faint"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          state === "error" ? "bg-rose" : state === "pending" ? "bg-amber" : "bg-mint"
        }`}
      />
      {copy}
    </span>
  );
}

function ChoiceGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold leading-snug text-ink">{legend}</legend>
      <div className={`mt-3 grid gap-2 ${options.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
              value === option.value
                ? "border-mint bg-mint text-mint-ink"
                : "border-line-bright bg-canvas/50 text-ink-soft hover:bg-card-2 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const PAIRWISE_OPTIONS: Array<{ value: PairwiseChoice; label: string }> = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "tie", label: "Tie" },
];

const NOISE_OPTIONS: Array<{ value: IrrelevantAdviceChoice; label: string }> = [
  { value: "neither", label: "Neither" },
  { value: "left", label: "Left only" },
  { value: "right", label: "Right only" },
  { value: "both", label: "Both" },
];

export function OutputReviewClient({
  run,
  labeler,
  initialJudgments,
}: {
  run: BlindOutputRun;
  labeler: string;
  initialJudgments: Record<string, OutputJudgmentDraft>;
}) {
  const [currentIndex, setCurrentIndex] = useState(() => {
    const firstIncomplete = run.trials.findIndex(
      (trial) => !isOutputJudgmentComplete(initialJudgments[trial.id]),
    );
    return firstIncomplete >= 0 ? firstIncomplete : 0;
  });
  const [judgments, setJudgments] = useState(initialJudgments);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSource, setShowSource] = useState(false);
  const judgmentsRef = useRef(judgments);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const timers = useRef(new Map<string, number>());
  const revision = useRef(0);
  const trial = run.trials[currentIndex];
  const judgment = judgments[trial.id];
  const completedCount = useMemo(
    () => Object.values(judgments).filter(isOutputJudgmentComplete).length,
    [judgments],
  );

  function scheduleSave(trialId: string, draft: OutputJudgmentDraft): void {
    const currentTimer = timers.current.get(trialId);
    if (currentTimer) window.clearTimeout(currentTimer);
    revision.current += 1;
    const saveRevision = revision.current;
    setSaveState("pending");
    const timer = window.setTimeout(() => {
      timers.current.delete(trialId);
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        const response = await fetch("/api/eval/output", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.id, trialId, labeler, judgment: draft }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Judgment could not be saved.");
        }
        if (saveRevision === revision.current) setSaveState("saved");
      });
      saveQueue.current.catch(() => {
        if (saveRevision === revision.current) setSaveState("error");
      });
    }, 400);
    timers.current.set(trialId, timer);
  }

  function updateJudgment(patch: Partial<OutputJudgmentDraft>): void {
    const next = { ...judgmentsRef.current[trial.id], ...patch };
    const all = { ...judgmentsRef.current, [trial.id]: next };
    judgmentsRef.current = all;
    setJudgments(all);
    scheduleSave(trial.id, next);
  }

  function moveTo(index: number): void {
    setCurrentIndex(Math.max(0, Math.min(run.trials.length - 1, index)));
    setShowSource(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="mx-auto w-full max-w-[1580px] flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-10">
      <header className="mb-8 border-b border-line pb-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="mb-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-mint">
              Blind redesign comparison · {labeler}
            </p>
            <h1 className="max-w-4xl font-display text-3xl font-semibold leading-[0.98] tracking-[-0.035em] text-ink sm:text-5xl">
              Which redesign would help this teacher more?
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-soft">
              Judge the two answers on their classroom value. Their generation conditions and source details remain hidden throughout review.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <SaveIndicator state={saveState} />
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ink-faint">
              {completedCount} / {run.trials.length} complete
            </span>
          </div>
        </div>
      </header>

      <aside className="mb-7 rounded-xl border border-line bg-panel/90 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-ink-faint">
              Assignment {currentIndex + 1} of {run.trials.length}
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink">{trial.intake.assessment}</h2>
            <p className="mt-1 text-sm text-mint">{trial.intake.grade}</p>
          </div>
          {isOutputJudgmentComplete(judgment) && (
            <span className="rounded-full border border-mint/45 bg-mint/10 px-3 py-1 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-mint">
              Complete
            </span>
          )}
        </div>
        <dl className="mt-5 grid gap-5 text-sm leading-relaxed md:grid-cols-3">
          <div>
            <dt className="font-mono text-[0.62rem] uppercase tracking-[0.15em] text-ink-faint">Students do</dt>
            <dd className="mt-1 text-ink-soft">{trial.intake.parts}</dd>
          </div>
          <div>
            <dt className="font-mono text-[0.62rem] uppercase tracking-[0.15em] text-ink-faint">Learning goal</dt>
            <dd className="mt-1 text-ink-soft">{trial.intake.goal}</dd>
          </div>
          <div>
            <dt className="font-mono text-[0.62rem] uppercase tracking-[0.15em] text-ink-faint">Time</dt>
            <dd className="mt-1 text-ink-soft">{trial.intake.time}</dd>
          </div>
        </dl>
        {trial.intake.sourceDoc && (
          <div className="mt-5 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setShowSource((value) => !value)}
              className="text-sm font-medium text-ink-soft underline decoration-line-bright underline-offset-4 hover:text-ink"
            >
              {showSource ? "Hide assignment excerpt" : "Read assignment excerpt"}
            </button>
            {showSource && (
              <p className="mt-3 border-l-2 border-mint/50 pl-3 text-sm leading-relaxed text-ink-soft">
                {trial.intake.sourceDoc}
              </p>
            )}
          </div>
        )}
      </aside>

      <section className="grid items-start gap-5 xl:grid-cols-2" aria-label="Anonymous redesign outputs">
        {(["left", "right"] as const).map((side) => (
          <article key={side} className="min-w-0 rounded-xl border border-line bg-card p-5 sm:p-7">
            <div className="mb-5 border-b border-line pb-4">
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-mint">
                {side === "left" ? "Left output" : "Right output"}
              </p>
            </div>
            <div className="studio-prose">
              <StudioMarkdown>{side === "left" ? trial.leftOutput : trial.rightOutput}</StudioMarkdown>
            </div>
          </article>
        ))}
      </section>

      <section className="mx-auto mt-7 max-w-4xl rounded-xl border border-line bg-panel p-5 sm:p-7">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-mint">Your judgment</p>
        <div className="mt-6 grid gap-7 md:grid-cols-2">
          <ChoiceGroup
            legend="Which output is better overall?"
            value={judgment.overall}
            options={PAIRWISE_OPTIONS}
            onChange={(overall) => updateJudgment({ overall })}
          />
          <ChoiceGroup
            legend="Which is more specific to this assignment?"
            value={judgment.specificity}
            options={PAIRWISE_OPTIONS}
            onChange={(specificity) => updateJudgment({ specificity })}
          />
          <ChoiceGroup
            legend="Which offers more feasible redesigns?"
            value={judgment.feasibility}
            options={PAIRWISE_OPTIONS}
            onChange={(feasibility) => updateJudgment({ feasibility })}
          />
          <ChoiceGroup
            legend="Does either contain irrelevant or distracting advice?"
            value={judgment.irrelevantAdvice}
            options={NOISE_OPTIONS}
            onChange={(irrelevantAdvice) => updateJudgment({ irrelevantAdvice })}
          />
        </div>
        <label className="mt-7 block text-sm font-semibold text-ink" htmlFor={`rationale-${trial.id}`}>
          Optional short rationale
        </label>
        <textarea
          id={`rationale-${trial.id}`}
          value={judgment.rationale}
          maxLength={2000}
          rows={3}
          onChange={(event) => updateJudgment({ rationale: event.target.value })}
          placeholder="What made the stronger answer work—or what got in the way?"
          className="mt-3 w-full resize-y rounded-lg border border-line-bright bg-canvas px-4 py-3 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-mint"
        />
      </section>

      <nav className="mt-8 flex items-center justify-between gap-4 border-t border-line pt-6" aria-label="Assignments">
        <button
          type="button"
          disabled={currentIndex === 0}
          onClick={() => moveTo(currentIndex - 1)}
          className="rounded-lg border border-line-bright px-4 py-2.5 text-sm font-semibold text-ink-soft hover:bg-card-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
        >
          Previous assignment
        </button>
        <p className="hidden font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ink-faint sm:block">
          {currentIndex + 1} / {run.trials.length}
        </p>
        <button
          type="button"
          disabled={currentIndex === run.trials.length - 1}
          onClick={() => moveTo(currentIndex + 1)}
          className="rounded-lg bg-mint px-4 py-2.5 text-sm font-bold text-mint-ink hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-35"
        >
          Next assignment
        </button>
      </nav>
    </main>
  );
}

