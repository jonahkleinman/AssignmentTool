"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  EvalIntake,
  IntakeLabels,
  LabelsFile,
  RelevanceLabel,
  RelevanceScore,
  SourceCatalogEntry,
} from "@/lib/eval/types";

type SaveState = "idle" | "pending" | "saved" | "error";

const SCORE_COPY: Record<RelevanceScore, string> = {
  0: "Off-topic or useless",
  1: "Tangential",
  2: "Useful and on-target",
  3: "Directly sparks a redesign idea",
};

function seededShuffle<T>(values: T[], seedText: string): T[] {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i += 1) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const random = () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

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

function ScoreRail({
  source,
  label,
  onChange,
}: {
  source: string;
  label: RelevanceLabel;
  onChange: (score: RelevanceScore) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Relevance score for {source}</legend>
      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-line-bright bg-canvas/40">
        {([0, 1, 2, 3] as RelevanceScore[]).map((score) => {
          const selected = label.score === score;
          return (
            <button
              key={score}
              type="button"
              aria-label={`${score}: ${SCORE_COPY[score]}`}
              aria-pressed={selected}
              title={SCORE_COPY[score]}
              onClick={() => onChange(score)}
              className={`min-h-10 border-r border-line-bright px-2 font-mono text-sm font-semibold transition-colors last:border-r-0 ${
                selected
                  ? score >= 2
                    ? "bg-mint text-mint-ink"
                    : "bg-ink text-canvas"
                  : "text-ink-faint hover:bg-card-2 hover:text-ink"
              }`}
            >
              {score}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function LabelingClient({
  intakes,
  sources,
  initialFile,
  stale,
}: {
  intakes: EvalIntake[];
  sources: SourceCatalogEntry[];
  initialFile: LabelsFile;
  stale: boolean;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [labels, setLabels] = useState<IntakeLabels>(initialFile.labels);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSource, setShowSource] = useState(false);
  const initialized = useRef(false);
  const revision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const intake = intakes[currentIndex];
  const orderedSources = useMemo(
    () => seededShuffle(sources, intake.id),
    [intake.id, sources],
  );
  const currentLabels = labels[intake.id];
  const relevantCount = Object.values(currentLabels).filter((label) => label.score >= 2).length;

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    revision.current += 1;
    const saveRevision = revision.current;
    setSaveState("pending");
    const timer = window.setTimeout(() => {
      const file: LabelsFile = { ...initialFile, labels };
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        const response = await fetch("/api/eval/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labeler: initialFile.labeler, file }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Labels could not be saved.");
        }
        if (saveRevision === revision.current) setSaveState("saved");
      });
      saveQueue.current.catch(() => {
        if (saveRevision === revision.current) setSaveState("error");
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [initialFile, labels]);

  function updateLabel(source: string, patch: Partial<RelevanceLabel>): void {
    setLabels((current) => ({
      ...current,
      [intake.id]: {
        ...current[intake.id],
        [source]: { ...current[intake.id][source], ...patch },
      },
    }));
  }

  function moveTo(index: number): void {
    setCurrentIndex(Math.max(0, Math.min(intakes.length - 1, index)));
    setShowSource(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-7 lg:px-10 lg:py-10">
      <header className="mb-8 border-b border-line pb-6 lg:mb-10">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="mb-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-mint">
              Retrieval relevance desk · {initialFile.labeler}
            </p>
            <h1 className="max-w-4xl font-display text-3xl font-semibold leading-[0.98] tracking-[-0.035em] text-ink sm:text-5xl">
              Would this source help redesign this assignment?
            </h1>
          </div>
          <SaveIndicator state={saveState} />
        </div>
        {stale && (
          <p className="mt-5 max-w-3xl rounded-lg border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber">
            The corpus changed after this label file was started. Existing source names were preserved;
            review any new or renamed sources before treating the set as complete.
          </p>
        )}
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.65fr)] lg:gap-12">
        <aside className="lg:sticky lg:top-8">
          <div className="rounded-xl border border-line bg-panel/90 p-5 shadow-2xl shadow-black/15 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-3 border-b border-line pb-4">
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-ink-faint">
                Assignment {currentIndex + 1} of {intakes.length}
              </p>
              <span className="rounded-full border border-line-bright px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-ink-soft">
                {intake.expectedProfile}
              </span>
            </div>
            <h2 className="font-display text-2xl font-semibold leading-tight tracking-[-0.025em] text-ink">
              {intake.assessment}
            </h2>
            <p className="mt-2 text-sm text-mint">{intake.grade}</p>
            <dl className="mt-6 space-y-5 text-sm leading-relaxed">
              <div>
                <dt className="mb-1 font-mono text-[0.63rem] uppercase tracking-[0.16em] text-ink-faint">
                  Students do
                </dt>
                <dd className="text-ink-soft">{intake.parts}</dd>
              </div>
              <div>
                <dt className="mb-1 font-mono text-[0.63rem] uppercase tracking-[0.16em] text-ink-faint">
                  Learning goal
                </dt>
                <dd className="text-ink-soft">{intake.goal}</dd>
              </div>
              <div>
                <dt className="mb-1 font-mono text-[0.63rem] uppercase tracking-[0.16em] text-ink-faint">
                  Time
                </dt>
                <dd className="text-ink-soft">{intake.time}</dd>
              </div>
            </dl>
            {intake.sourceDoc && (
              <div className="mt-5 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setShowSource((visible) => !visible)}
                  className="text-sm font-medium text-ink-soft underline decoration-line-bright underline-offset-4 hover:text-ink"
                >
                  {showSource ? "Hide assignment excerpt" : "Read assignment excerpt"}
                </button>
                {showSource && (
                  <p className="mt-3 border-l-2 border-mint/50 pl-3 text-sm leading-relaxed text-ink-soft">
                    {intake.sourceDoc}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-line bg-card/70 p-5 text-sm leading-relaxed text-ink-soft">
            <p className="font-semibold text-ink">Score usefulness, not topical similarity.</p>
            <ul className="mt-3 space-y-1.5">
              <li><span className="font-mono text-ink">3</span> · directly sparks a redesign idea</li>
              <li><span className="font-mono text-ink">2</span> · useful and on-target</li>
              <li><span className="font-mono text-ink">1</span> · tangential</li>
              <li><span className="font-mono text-ink">0</span> · off-topic or useless</li>
            </ul>
            <p className="mt-3 text-xs text-ink-faint">
              “Misleading” means the source could push the redesign in a wrong direction, not merely that it is irrelevant.
            </p>
          </div>
        </aside>

        <section aria-label={`Sources for ${intake.assessment}`}>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-ink-faint">
                Blind source review
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                {sources.length} sources · {relevantCount} currently scored 2 or 3
              </p>
            </div>
            <p className="max-w-sm text-right text-xs text-ink-faint">
              Order is randomized for this assignment and stays stable on refresh. Similarity scores are hidden.
            </p>
          </div>

          <div className="space-y-3">
            {orderedSources.map((source, sourceIndex) => {
              const label = currentLabels[source.source];
              return (
                <article
                  key={source.source}
                  className={`grid gap-5 rounded-xl border bg-card p-5 transition-colors sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center ${
                    label.score >= 2 ? "border-mint/45" : label.misleading ? "border-rose/50" : "border-line"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 font-mono text-[0.62rem] text-ink-faint">
                        {String(sourceIndex + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h3 className="font-display text-lg font-semibold leading-snug text-ink">
                          {source.source}
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{source.summary}</p>
                        <p className="mt-2 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-ink-faint">
                          {source.chunkCount} {source.chunkCount === 1 ? "passage" : "passages"}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div>
                    <ScoreRail
                      source={source.source}
                      label={label}
                      onChange={(score) => updateLabel(source.source, { score })}
                    />
                    <label className="mt-3 flex cursor-pointer items-center justify-end gap-2 text-xs text-ink-faint hover:text-ink-soft">
                      <input
                        type="checkbox"
                        checked={label.misleading}
                        onChange={(event) =>
                          updateLabel(source.source, { misleading: event.target.checked })
                        }
                        className="h-4 w-4 rounded border-line-bright accent-rose"
                      />
                      Misleading direction
                    </label>
                  </div>
                </article>
              );
            })}
          </div>

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
              {currentIndex + 1} / {intakes.length}
            </p>
            <button
              type="button"
              disabled={currentIndex === intakes.length - 1}
              onClick={() => moveTo(currentIndex + 1)}
              className="rounded-lg bg-mint px-4 py-2.5 text-sm font-bold text-mint-ink hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-35"
            >
              Next assignment
            </button>
          </nav>
        </section>
      </div>
    </main>
  );
}
