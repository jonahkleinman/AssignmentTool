"use client";

import { useEffect, useRef, useState } from "react";
import {
  STEPS,
  buildIntakeMessage,
  buildConstraintSwapMessage,
  diagnoseAssignment,
  extractAssignment,
  fetchSuggestions,
  streamRedesign,
  type Diagnosis,
  type DiagnosisConstraint,
  type DiagnosisHabit,
  type StepConfig,
  type StepId,
} from "./agent";
import { isDriveConfigured, pickFromGoogleDrive } from "./drive";
import { StudioMarkdown } from "./markdown";
import { ChatDrawer, type DrawerConfig } from "./chat-drawer";

type Stage = "start" | "wizard" | "diagnosis" | "redesign";
type UploadStatus = "idle" | "reading" | "review" | "error";

const STEP_BY_ID = Object.fromEntries(
  STEPS.map((s) => [s.id, s]),
) as Record<StepId, StepConfig>;

interface StepData {
  choices: string[];
  selected: string[];
  loading: boolean;
  loaded: boolean;
  usedFallback: boolean;
}

interface Prototype {
  title: string;
  body: string;
}

function initData(): Record<StepId, StepData> {
  const out = {} as Record<StepId, StepData>;
  for (const s of STEPS) {
    out[s.id] = {
      choices: [],
      selected: [],
      loading: false,
      loaded: false,
      usedFallback: false,
    };
  }
  return out;
}

function parsePrototypes(text: string): { preamble: string; prototypes: Prototype[] } {
  const blocks = text.split(/\n(?=###\s)/);
  let preamble = "";
  const prototypes: Prototype[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith("###")) {
      const rest = block.replace(/^###\s*/, "");
      const nl = rest.indexOf("\n");
      const title = (nl === -1 ? rest : rest.slice(0, nl)).trim();
      const body = nl === -1 ? "" : rest.slice(nl + 1).trim();
      prototypes.push({ title, body });
    } else if (prototypes.length === 0) {
      preamble = block;
    }
  }
  return { preamble, prototypes };
}

function formatPrototype(p: Prototype): string {
  return `### ${p.title.trim()}\n\n${p.body.trim()}`.trim();
}

function replacePrototypeAt(text: string, index: number, replacement: Prototype): string {
  const parsed = parsePrototypes(text);
  if (index < 0 || index >= parsed.prototypes.length) return text;
  const prototypes = parsed.prototypes.map((prototype, i) =>
    i === index ? replacement : prototype,
  );
  return [parsed.preamble.trim(), ...prototypes.map(formatPrototype)].filter(Boolean).join("\n\n");
}

interface Beat {
  label: string;
  text: string;
}

interface Beats {
  before?: Beat;
  after?: Beat;
  soThat?: Beat;
  outcome?: Beat;
  goal?: Beat;
  constraint?: Beat;
  job?: Beat;
  habit?: Beat;
  swapMenu?: Beat;
}

interface SwapState {
  index: number;
  text: string;
  loading: boolean;
  error: string | null;
}

/**
 * Pull the four teacher-facing beats out of a prototype body by their bold
 * lead-ins (see SYSTEM_PROMPT), keeping each lead-in so the card can read as
 * full, warm sentences. Returns null when the body doesn't follow the shape —
 * e.g. a partial stream or an off-format reply — so callers can fall back to
 * plain markdown.
 */
function parseBeats(body: string): Beats | null {
  const re = /\*\*(.+?)\*\*\s*([\s\S]*?)(?=\n\s*\*\*|$)/g;
  const beats: Beats = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const label = m[1].trim();
    const key = label.toLowerCase();
    const text = m[2].trim().replace(/^[-—:]\s*/, "").replace(/\*\*/g, "");
    if (!text) continue;
    const beat: Beat = { label, text };
    if (key.includes("were asking") || key.includes("right now")) beats.before ??= beat;
    else if (key.includes("instead")) beats.after ??= beat;
    else if (key.includes("that way") || key.includes("they'll") || key.includes("they will"))
      beats.soThat ??= beat;
    else if (key.includes("you'll see") || key.includes("you will see")) beats.outcome ??= beat;
    else if (key === "goal") beats.goal ??= beat;
    else if (key.includes("constraint")) {
      if (key.includes("other")) beats.swapMenu ??= beat;
      else beats.constraint ??= beat;
    } else if (key.includes("what it does")) beats.job ??= beat;
    else if (key.includes("habit")) beats.habit ??= beat;
  }
  // The before → instead contrast is the whole point, so anchor on "before".
  return beats.before ? beats : null;
}

function splitSwapOptions(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .replace(/\n+/g, ";")
    .replace(/(^|;)\s*(?:[-*]|\d+[.)])\s*/g, "$1")
    .split(";")
    .map((option) => option.trim().replace(/\.$/, ""))
    .filter(Boolean)
    .slice(0, 3);
}

function PrototypeBody({
  body,
  streaming,
  swapping,
  onSwapConstraint,
}: {
  body: string;
  streaming: boolean;
  swapping?: boolean;
  onSwapConstraint?: (constraint: string) => void;
}) {
  const beats = parseBeats(body);

  if (!beats) {
    return (
      <div className="studio-prose mt-3 text-[0.97rem]">
        <StudioMarkdown>{body}</StudioMarkdown>
        {streaming && <span className="caret" aria-hidden />}
      </div>
    );
  }

  const order: (keyof Beats)[] = ["before", "after", "soThat", "outcome"];
  const lastKey = order.filter((k) => beats[k]).at(-1);
  const caret = (k: keyof Beats) =>
    streaming && lastKey === k ? <span className="caret" aria-hidden /> : null;
  const hasDetails = beats.goal || beats.constraint || beats.job || beats.habit || beats.swapMenu;
  const swapOptions = beats.swapMenu ? splitSwapOptions(beats.swapMenu.text) : [];

  return (
    <div className="mt-5 text-[0.98rem] leading-relaxed">
      {order
        .filter((k) => beats[k])
        .map((k, i, seq) => {
          const beat = beats[k]!;
          const isHero = k === "after";
          const last = i === seq.length - 1;
          return (
            <div key={k} className="relative flex gap-3.5 pb-4 last:pb-0">
              {!last && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-[6px] top-5 w-px bg-line"
                />
              )}
              <span
                aria-hidden
                className={
                  isHero
                    ? "relative z-10 mt-[0.5em] h-3 w-3 shrink-0 rotate-45 rounded-[3px] bg-mint shadow-[0_0_12px_-1px_var(--color-mint)]"
                    : "relative z-10 mt-[0.5em] h-3 w-3 shrink-0 rounded-full border-2 border-line-bright bg-card"
                }
              />
              {isHero ? (
                <p className="min-w-0 flex-1 rounded-xl border border-mint/25 bg-mint/[0.06] px-3.5 py-2.5">
                  <span className="text-mint">{beat.label}</span>{" "}
                  <span className="font-semibold text-ink">{beat.text}</span>
                  {caret(k)}
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-ink-soft">
                  {beat.label}{" "}
                  <span className="font-medium text-ink">{beat.text}</span>
                  {caret(k)}
                </p>
              )}
            </div>
          );
        })}

      {hasDetails && (
        <details className="group mt-5 rounded-xl border border-line bg-panel/60">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink-soft transition-colors hover:text-ink">
            <span>Goal and constraint</span>
            <span
              aria-hidden
              className="text-mint transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <div className="space-y-3 border-t border-line/70 px-4 py-4">
            {beats.goal && (
              <p className="text-sm text-ink-soft">
                <span className="font-medium text-ink">{beats.goal.label}: </span>
                {beats.goal.text}
              </p>
            )}
            {beats.constraint && (
              <p className="text-sm text-ink-soft">
                <span className="font-medium text-ink">{beats.constraint.label}: </span>
                {beats.constraint.text}
              </p>
            )}
            {beats.job && (
              <p className="text-sm text-ink-soft">
                <span className="font-medium text-ink">{beats.job.label}: </span>
                {beats.job.text}
              </p>
            )}
            {beats.habit && (
              <p className="text-sm text-ink-soft">
                <span className="font-medium text-ink">{beats.habit.label}: </span>
                {beats.habit.text}
              </p>
            )}
            {swapOptions.length > 0 && (
              <div>
                <p className="font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ink-faint">
                  Swap the constraint
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {swapOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={swapping}
                      onClick={() => onSwapConstraint?.(option)}
                      className="rounded-full border border-line px-3 py-1.5 text-left text-xs font-medium text-mint transition-colors hover:border-mint hover:bg-mint/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("start");
  const [stepIdx, setStepIdx] = useState(0);
  const [skip, setSkip] = useState<Set<StepId>>(new Set());
  const [data, setData] = useState<Record<StepId, StepData>>(initData);
  const [drawer, setDrawer] = useState<DrawerConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [customText, setCustomText] = useState("");
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [sourceDoc, setSourceDoc] = useState("");
  const [diagnosis, setDiagnosis] = useState<{
    draft: Diagnosis | null;
    loading: boolean;
    error: string | null;
  }>({ draft: null, loading: false, error: null });
  const [confirmedDiagnosis, setConfirmedDiagnosis] = useState<Diagnosis | null>(null);
  const [swapState, setSwapState] = useState<SwapState | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const uploadAbort = useRef<AbortController | null>(null);
  const [redesign, setRedesign] = useState<{
    text: string;
    loading: boolean;
    error: string | null;
  }>({ text: "", loading: false, error: null });

  const loadedRef = useRef<Set<StepId>>(new Set());
  const redesignStarted = useRef(false);
  const diagnosisStarted = useRef(false);
  const redesignAbort = useRef<AbortController | null>(null);
  const diagnosisAbort = useRef<AbortController | null>(null);
  const swapAbort = useRef<AbortController | null>(null);

  const step = STEPS[stepIdx];

  /* ---------- derived ---------- */
  function answerFor(id: StepId): string {
    const s = data[id];
    const cfg = STEP_BY_ID[id];
    return cfg.multi ? s.selected.join("; ") : s.selected[0] ?? "";
  }
  function currentAnswers(): Record<StepId, string> {
    return Object.fromEntries(STEPS.map((s) => [s.id, answerFor(s.id)])) as Record<
      StepId,
      string
    >;
  }
  function summary(exceptId?: StepId): string {
    const lines = STEPS.filter((s) => s.id !== exceptId && answerFor(s.id).trim()).map(
      (s) => `- ${s.label}: ${answerFor(s.id)}`,
    );
    return lines.length ? lines.join("\n") : "(nothing captured yet)";
  }

  const canContinue = step.optional || answerFor(step.id).trim() !== "";

  /* ---------- suggestions ---------- */
  function loadStep(cfg: StepConfig) {
    if (loadedRef.current.has(cfg.id)) return;
    loadedRef.current.add(cfg.id);
    if (cfg.textInput) {
      setData((d) => ({
        ...d,
        [cfg.id]: { ...d[cfg.id], loading: false, loaded: true, usedFallback: false },
      }));
      return;
    }
    if (cfg.staticChoices) {
      setData((d) => ({
        ...d,
        [cfg.id]: {
          ...d[cfg.id],
          choices: Array.from(new Set([...cfg.fallback, ...d[cfg.id].selected])),
          loading: false,
          loaded: true,
          usedFallback: false,
        },
      }));
      return;
    }
    setData((d) => ({ ...d, [cfg.id]: { ...d[cfg.id], loading: true } }));
    const controller = new AbortController();
    fetchSuggestions(cfg.id, currentAnswers(), controller.signal)
      .then((choices) =>
        setData((d) => ({
          ...d,
          [cfg.id]: {
            ...d[cfg.id],
            choices: Array.from(new Set([...choices, ...d[cfg.id].selected])),
            loading: false,
            loaded: true,
          },
        })),
      )
      .catch((err) => {
        if ((err as Error).name === "AbortError") {
          loadedRef.current.delete(cfg.id);
          return;
        }
        setData((d) => ({
          ...d,
          [cfg.id]: {
            ...d[cfg.id],
            choices: Array.from(new Set([...cfg.fallback, ...d[cfg.id].selected])),
            loading: false,
            loaded: true,
            usedFallback: true,
          },
        }));
      });
  }

  useEffect(() => {
    if (stage === "wizard") loadStep(STEPS[stepIdx]);
    setAdding(false);
    setCustomText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx, stage]);

  useEffect(
    () => () => {
      redesignAbort.current?.abort();
      diagnosisAbort.current?.abort();
      swapAbort.current?.abort();
    },
    [],
  );

  /* ---------- choice handlers ---------- */
  function toggleChoice(cfg: StepConfig, value: string) {
    setData((d) => {
      const s = d[cfg.id];
      const selected = cfg.multi
        ? s.selected.includes(value)
          ? s.selected.filter((v) => v !== value)
          : [...s.selected, value]
        : s.selected[0] === value
          ? []
          : [value];
      return { ...d, [cfg.id]: { ...s, selected } };
    });
  }

  function addCustom(id: StepId, raw: string) {
    const text = raw.trim();
    if (!text) return;
    const cfg = STEP_BY_ID[id];
    setData((d) => {
      const s = d[id];
      const choices = s.choices.includes(text) ? s.choices : [...s.choices, text];
      const selected = cfg.multi
        ? s.selected.includes(text)
          ? s.selected
          : [...s.selected, text]
        : [text];
      return { ...d, [id]: { ...s, choices, selected } };
    });
  }

  function setTextAnswer(id: StepId, value: string) {
    setData((d) => {
      const s = d[id];
      return { ...d, [id]: { ...s, selected: value ? [value] : [] } };
    });
  }

  /* ---------- navigation ---------- */
  function goNext() {
    let next = stepIdx + 1;
    while (next < STEPS.length && skip.has(STEPS[next].id)) next++;
    if (next < STEPS.length) {
      setStepIdx(next);
      return;
    }
    if (sourceDoc.trim()) {
      setStage("diagnosis");
      void startDiagnosis();
      return;
    }
    setStage("redesign");
    void startRedesign(null);
  }

  function goBack() {
    let prev = stepIdx - 1;
    while (prev >= 0 && skip.has(STEPS[prev].id)) prev--;
    setStepIdx(Math.max(0, prev));
  }

  async function startDiagnosis() {
    if (diagnosisStarted.current) return;
    diagnosisStarted.current = true;
    diagnosisAbort.current?.abort();
    const controller = new AbortController();
    diagnosisAbort.current = controller;
    setDiagnosis({ draft: null, loading: true, error: null });
    try {
      const draft = await diagnoseAssignment(sourceDoc, currentAnswers(), controller.signal);
      setDiagnosis({ draft, loading: false, error: null });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setDiagnosis({ draft: null, loading: false, error: (err as Error).message });
    }
  }

  function goBackFromDiagnosis() {
    diagnosisAbort.current?.abort();
    diagnosisStarted.current = false;
    setDiagnosis({ draft: null, loading: false, error: null });
    setStage("wizard");
  }

  function retryDiagnosis() {
    diagnosisStarted.current = false;
    void startDiagnosis();
  }

  async function confirmDiagnosis(draft: Diagnosis) {
    const confirmed = {
      ...draft,
      purpose: draft.purpose.trim(),
      constraints: draft.constraints.filter((constraint) => constraint.text.trim()),
      habits: draft.habits.filter((habit) => habit.text.trim()),
      note: draft.note?.trim(),
    };
    setConfirmedDiagnosis(confirmed);
    redesignStarted.current = false;
    setStage("redesign");
    await startRedesign(confirmed);
  }

  async function startRedesign(diagnosisOverride: Diagnosis | null = confirmedDiagnosis) {
    if (redesignStarted.current) return;
    redesignStarted.current = true;
    setClarificationAnswer("");
    setRedesign({ text: "", loading: true, error: null });
    setSwapState(null);
    const controller = new AbortController();
    redesignAbort.current = controller;
    try {
      await streamRedesign(
        [
          {
            role: "user",
            content: buildIntakeMessage(currentAnswers(), sourceDoc, diagnosisOverride),
          },
        ],
        (delta) => setRedesign((r) => ({ ...r, text: r.text + delta })),
        controller.signal,
      );
      setRedesign((r) => ({ ...r, loading: false }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setRedesign((r) => ({ ...r, loading: false, error: (err as Error).message }));
    }
  }

  async function answerClarification(raw: string) {
    const answer = raw.trim();
    if (redesign.loading) return;

    const clarificationQuestions = redesign.text;
    setClarificationAnswer("");
    setRedesign({ text: "", loading: true, error: null });
    const controller = new AbortController();
    redesignAbort.current = controller;

    try {
      await streamRedesign(
        [
          {
            role: "user",
            content: buildIntakeMessage(currentAnswers(), sourceDoc, confirmedDiagnosis),
          },
          { role: "assistant", content: clarificationQuestions },
          {
            role: "user",
            content: answer
              ? `Here are my answers to the clarifying questions:\n${answer}\n\nUse this context to generate 2-3 prototype redesigns in the required format.`
              : "I do not have more context right now. Generate 2-3 prototype redesigns in the required format using the intake you have.",
          },
        ],
        (delta) => setRedesign((r) => ({ ...r, text: r.text + delta })),
        controller.signal,
      );
      setRedesign((r) => ({ ...r, loading: false }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setRedesign((r) => ({ ...r, loading: false, error: (err as Error).message }));
    }
  }

  async function swapConstraint(index: number, prototype: Prototype, constraint: string) {
    if (redesign.loading || swapState?.loading) return;

    swapAbort.current?.abort();
    const controller = new AbortController();
    swapAbort.current = controller;
    let streamed = "";
    setSwapState({ index, text: "", loading: true, error: null });

    try {
      await streamRedesign(
        [
          {
            role: "user",
            content: buildIntakeMessage(currentAnswers(), sourceDoc, confirmedDiagnosis),
          },
          { role: "assistant", content: redesign.text },
          {
            role: "user",
            content: buildConstraintSwapMessage(prototype.title, prototype.body, constraint),
          },
        ],
        (delta) => {
          streamed += delta;
          setSwapState((state) =>
            state && state.index === index ? { ...state, text: state.text + delta } : state,
          );
        },
        controller.signal,
      );

      const parsed = parsePrototypes(streamed);
      const replacement = parsed.prototypes[0] ?? {
        title: prototype.title,
        body: streamed.trim(),
      };
      setRedesign((current) => ({
        ...current,
        text: replacePrototypeAt(current.text, index, replacement),
      }));
      setSwapState(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSwapState((state) =>
        state && state.index === index
          ? { ...state, loading: false, error: (err as Error).message }
          : state,
      );
    }
  }

  function resetAll() {
    redesignAbort.current?.abort();
    diagnosisAbort.current?.abort();
    swapAbort.current?.abort();
    uploadAbort.current?.abort();
    redesignStarted.current = false;
    diagnosisStarted.current = false;
    loadedRef.current = new Set();
    setData(initData());
    setClarificationAnswer("");
    setRedesign({ text: "", loading: false, error: null });
    setDiagnosis({ draft: null, loading: false, error: null });
    setConfirmedDiagnosis(null);
    setSwapState(null);
    setSourceDoc("");
    setUploadStatus("idle");
    setUploadError(null);
    setUploadName("");
    setSkip(new Set());
    setStepIdx(0);
    setStage("start");
    setDrawer(null);
  }

  /* ---------- upload / autofill ---------- */
  async function handleFile(file: File) {
    uploadAbort.current?.abort();
    diagnosisAbort.current?.abort();
    diagnosisStarted.current = false;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadName(file.name);
    setUploadError(null);
    setUploadStatus("reading");
    setDiagnosis({ draft: null, loading: false, error: null });
    setConfirmedDiagnosis(null);
    try {
      const result = await extractAssignment(file, controller.signal);
      setData((d) => ({
        ...d,
        assessment: {
          ...d.assessment,
          selected: result.assessment ? [result.assessment] : [],
          loaded: true,
        },
        parts: {
          ...d.parts,
          selected: result.parts ? [result.parts] : [],
          loaded: true,
        },
      }));
      setSourceDoc(result.rawText);
      setUploadStatus("review");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setUploadError((err as Error).message);
      setUploadStatus("error");
    }
  }

  async function handleDrive() {
    setUploadError(null);
    try {
      const file = await pickFromGoogleDrive();
      if (file) await handleFile(file);
    } catch (err) {
      setUploadError((err as Error).message);
      setUploadStatus("error");
    }
  }

  function handlePaste(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    void handleFile(
      new File([trimmed], "pasted-assignment.txt", { type: "text/plain" }),
    );
  }

  function startFromScratch() {
    setSourceDoc("");
    diagnosisAbort.current?.abort();
    diagnosisStarted.current = false;
    setDiagnosis({ draft: null, loading: false, error: null });
    setConfirmedDiagnosis(null);
    setUploadStatus("idle");
    setUploadName("");
    setUploadError(null);
    setSkip(new Set());
    setStepIdx(0);
    setStage("wizard");
  }

  function continueFromUpload() {
    loadedRef.current.add("assessment");
    loadedRef.current.add("parts");
    // assessment + parts are autofilled and reviewed on the upload card; ask
    // grade next, then step over those two on the way to the goals step.
    setSkip(new Set<StepId>(["assessment", "parts"]));
    setStepIdx(STEPS.findIndex((s) => s.id === "grade"));
    setStage("wizard");
  }

  function discardUpload() {
    setSourceDoc("");
    diagnosisAbort.current?.abort();
    diagnosisStarted.current = false;
    setDiagnosis({ draft: null, loading: false, error: null });
    setConfirmedDiagnosis(null);
    setUploadStatus("idle");
    setUploadName("");
    setUploadError(null);
    setData((d) => ({
      ...d,
      assessment: { ...d.assessment, selected: [] },
      parts: { ...d.parts, selected: [] },
    }));
  }

  /* ---------- drawer openers ---------- */
  function refineStep(cfg: StepConfig) {
    const ans = answerFor(cfg.id);
    setDrawer({
      eyebrow: `Refine · ${cfg.eyebrow}`,
      title: cfg.question,
      seed: [
        {
          role: "user",
          content: `I'm reworking an assessment. What I have so far:\n${summary(
            cfg.id,
          )}\n\nHelp me sharpen my answer to: "${cfg.question}"\nCurrent draft: ${
            ans || "(nothing yet)"
          }\n\nPropose one improved version I could use (a sentence or two), then we can refine it together.`,
        },
      ],
      onAdopt: (t) => addCustom(cfg.id, t),
      adoptLabel: "Use this answer",
    });
  }

  function refinePrototype(p: Prototype) {
    setDrawer({
      eyebrow: "Refine redesign",
      title: p.title,
      seed: [
        {
          role: "user",
          content: buildIntakeMessage(currentAnswers(), sourceDoc, confirmedDiagnosis),
        },
        { role: "assistant", content: redesign.text },
        {
          role: "user",
          content: `Let's develop "${p.title}" further — tighten it, make sure it fits the time students have, and spell out what the student would actually do, step by step.`,
        },
      ],
    });
  }

  function ownDirection() {
    setDrawer({
      eyebrow: "New direction",
      title: "Bring your own idea",
      seed: [
        {
          role: "user",
          content: buildIntakeMessage(currentAnswers(), sourceDoc, confirmedDiagnosis),
        },
        {
          role: "assistant",
          content:
            "Tell me the redesign idea you have in mind, and I'll help you sharpen it against your goal and constraints.",
        },
      ],
    });
  }

  function refineAll() {
    setDrawer({
      eyebrow: "Studio chat",
      title: "Refine these redesigns",
      seed: [
        {
          role: "user",
          content: buildIntakeMessage(currentAnswers(), sourceDoc, confirmedDiagnosis),
        },
        { role: "assistant", content: redesign.text },
      ],
    });
  }

  /* ================================================================ */
  return (
    <div className="flex flex-1 flex-col">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-line/70 bg-canvas/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3.5 sm:px-8">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid h-6 w-6 place-items-center rounded-md bg-mint/15 text-mint"
            >
              ◇
            </span>
            <span className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-ink-soft">
              Assessment Studio
            </span>
          </div>
          {stage === "wizard" ? (
            <span className="font-mono text-[0.66rem] uppercase tracking-[0.2em] text-ink-faint tabular-nums">
              {String(stepIdx + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
            </span>
          ) : stage === "diagnosis" ? (
            <span className="font-mono text-[0.66rem] uppercase tracking-[0.2em] text-ink-faint">
              Read-back
            </span>
          ) : stage === "redesign" ? (
            <button
              onClick={resetAll}
              className="rounded-full border border-line px-3.5 py-1.5 font-mono text-[0.62rem] uppercase tracking-widest text-ink-soft transition-colors hover:border-mint hover:text-mint"
            >
              Start over
            </button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 sm:px-8">
        {stage === "start" ? (
          <StartView
            status={uploadStatus}
            error={uploadError}
            fileName={uploadName}
            driveEnabled={isDriveConfigured()}
            assessmentValue={answerFor("assessment")}
            partsValue={answerFor("parts")}
            onEdit={setTextAnswer}
            onFile={handleFile}
            onDrive={handleDrive}
            onPaste={handlePaste}
            onStartScratch={startFromScratch}
            onContinue={continueFromUpload}
            onDiscard={discardUpload}
            onDismissError={() => {
              setUploadError(null);
              setUploadStatus("idle");
            }}
          />
        ) : stage === "wizard" ? (
          <WizardView
            key={step.id}
            step={step}
            stepIdx={stepIdx}
            skip={skip}
            d={data[step.id]}
            adding={adding}
            customText={customText}
            canContinue={canContinue}
            onSetAdding={setAdding}
            onCustomText={setCustomText}
            onToggle={toggleChoice}
            onAddCustom={addCustom}
            onSetTextAnswer={setTextAnswer}
            onBack={goBack}
            onNext={goNext}
            onRefine={refineStep}
          />
        ) : stage === "diagnosis" ? (
          <DiagnosisView
            diagnosis={diagnosis}
            onChange={(draft) => setDiagnosis((state) => ({ ...state, draft }))}
            onBack={goBackFromDiagnosis}
            onRetry={retryDiagnosis}
            onConfirm={confirmDiagnosis}
          />
        ) : (
          <RedesignView
            redesign={redesign}
            swapState={swapState}
            clarificationAnswer={clarificationAnswer}
            onClarificationAnswer={setClarificationAnswer}
            onSubmitClarification={answerClarification}
            onRefinePrototype={refinePrototype}
            onSwapConstraint={swapConstraint}
            onOwnDirection={ownDirection}
            onRefineAll={refineAll}
          />
        )}
      </main>

      {drawer && <ChatDrawer config={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Start screen — upload an assignment, or build from scratch
 * ------------------------------------------------------------------ */
const ACCEPTED = ".pdf,.docx,.txt,.md,.csv,image/*,application/pdf";

function StartView({
  status,
  error,
  fileName,
  driveEnabled,
  assessmentValue,
  partsValue,
  onEdit,
  onFile,
  onDrive,
  onPaste,
  onStartScratch,
  onContinue,
  onDiscard,
  onDismissError,
}: {
  status: UploadStatus;
  error: string | null;
  fileName: string;
  driveEnabled: boolean;
  assessmentValue: string;
  partsValue: string;
  onEdit: (id: StepId, value: string) => void;
  onFile: (file: File) => void;
  onDrive: () => void;
  onPaste: (text: string) => void;
  onStartScratch: () => void;
  onContinue: () => void;
  onDiscard: () => void;
  onDismissError: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  /* ---- review the extracted stages 1 & 2 ---- */
  if (status === "review") {
    const ready = assessmentValue.trim() !== "" && partsValue.trim() !== "";
    return (
      <div className="flex flex-1 flex-col py-10 sm:py-14">
        <div className="animate-fade-up">
          <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-mint">
            From your file
          </p>
          <h1 className="mt-3 font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
            Here&apos;s what we read.
          </h1>
          <p className="mt-3 max-w-xl text-[1.02rem] text-ink-soft">
            Check the two fields the studio pulled from{" "}
            <span className="text-ink">{fileName || "your upload"}</span>. Edit anything
            that&apos;s off, then jump straight to the learning goals.
          </p>
        </div>

        <div className="animate-fade-up mt-8 space-y-5" style={{ animationDelay: "80ms" }}>
          <div className="rounded-2xl border border-line bg-card p-5 sm:p-6">
            <label
              htmlFor="review-assessment"
              className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-mint"
            >
              Assignment type
            </label>
            <input
              id="review-assessment"
              type="text"
              value={assessmentValue}
              onChange={(e) => onEdit("assessment", e.target.value)}
              placeholder="e.g. DBQ essay"
              className="mt-2.5 w-full bg-transparent text-[1.05rem] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>

          <div className="rounded-2xl border border-line bg-card p-5 sm:p-6">
            <label
              htmlFor="review-parts"
              className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-mint"
            >
              What it asks students to do now
            </label>
            <textarea
              id="review-parts"
              rows={5}
              value={partsValue}
              onChange={(e) => onEdit("parts", e.target.value)}
              placeholder="Briefly describe the current prompt, components, or sequence."
              className="mt-2.5 max-h-60 min-h-28 w-full resize-y bg-transparent text-[1rem] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-3 pt-12 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={onDiscard}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
          >
            ← Use a different file
          </button>
          <button
            onClick={onContinue}
            disabled={!ready}
            className="group inline-flex items-center justify-center gap-2 rounded-full bg-mint px-7 py-3 font-semibold text-[#06231a] transition-all hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue to goals
            <span aria-hidden className="transition-transform group-hover:translate-x-1">
              →
            </span>
          </button>
        </div>
      </div>
    );
  }

  /* ---- reading / extracting ---- */
  if (status === "reading") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <div className="flex items-center gap-2 text-ink-soft">
          <span className="think-dot" style={{ animationDelay: "0ms" }} />
          <span className="think-dot" style={{ animationDelay: "150ms" }} />
          <span className="think-dot" style={{ animationDelay: "300ms" }} />
        </div>
        <p className="mt-5 font-display text-xl text-ink">Reading your assignment…</p>
        <p className="mt-2 text-sm text-ink-soft">
          {fileName ? `Pulling the details out of ${fileName}.` : "This only takes a moment."}
        </p>
      </div>
    );
  }

  /* ---- idle / error: the upload entry point ---- */
  return (
    <div className="flex flex-1 flex-col py-10 sm:py-14">
      <div className="animate-fade-up">
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-mint">
          Start here
        </p>
        <h1 className="mt-3 max-w-xl font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
          Upload an assignment to autofill the first steps.
        </h1>
        <p className="mt-3 max-w-xl text-[1.02rem] text-ink-soft">
          Drop in the assignment you already have — PDF, Word, an image, or text — and the
          studio fills in what it is and what it asks, so you can skip straight to the goals.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="animate-fade-up mt-6 flex items-start justify-between gap-3 rounded-xl border border-rose/40 bg-rose/10 px-4 py-3"
        >
          <p className="text-sm leading-relaxed text-ink">{error}</p>
          <button
            onClick={onDismissError}
            className="shrink-0 px-1 text-ink-faint transition-colors hover:text-ink"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="animate-fade-up mt-8" style={{ animationDelay: "100ms" }}>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center transition-colors ${
            dragOver
              ? "border-mint bg-mint/10"
              : "border-line-bright bg-card hover:border-mint hover:bg-card-2"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = "";
            }}
          />
          <span
            aria-hidden
            className="grid h-11 w-11 place-items-center rounded-full bg-mint/15 text-lg text-mint"
          >
            ↑
          </span>
          <span className="text-[1.02rem] font-medium text-ink">
            Drag a file here, or <span className="text-mint">browse</span>
          </span>
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
            PDF · Word · Image · Text · 15 MB max
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {driveEnabled && (
            <button
              onClick={onDrive}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:border-mint hover:text-ink"
            >
              <span aria-hidden className="text-mint">
                ▲
              </span>
              From Google Drive
            </button>
          )}
          <button
            onClick={() => setPasting((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:border-mint hover:text-ink"
          >
            <span aria-hidden className="text-mint">
              ¶
            </span>
            Paste text instead
          </button>
        </div>

        {pasting && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onPaste(pasteText);
            }}
            className="animate-fade-up mt-4 rounded-2xl border border-line bg-card p-4 sm:p-5"
          >
            <textarea
              autoFocus
              rows={6}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the assignment text here…"
              className="min-h-32 w-full resize-y rounded-xl border border-line bg-panel px-4 py-3 text-[0.98rem] leading-relaxed text-ink placeholder:text-ink-faint transition-colors focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint/15"
            />
            <button
              type="submit"
              disabled={!pasteText.trim()}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-semibold text-[#06231a] transition-colors hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              Read this text
              <span aria-hidden>→</span>
            </button>
          </form>
        )}
      </div>

      <div className="mt-auto pt-12">
        <button
          onClick={onStartScratch}
          className="inline-flex items-center gap-2 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
        >
          Or build from scratch
          <span aria-hidden className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Wizard step
 * ------------------------------------------------------------------ */
function WizardView({
  step,
  stepIdx,
  skip,
  d,
  adding,
  customText,
  canContinue,
  onSetAdding,
  onCustomText,
  onToggle,
  onAddCustom,
  onSetTextAnswer,
  onBack,
  onNext,
  onRefine,
}: {
  step: StepConfig;
  stepIdx: number;
  skip: Set<StepId>;
  d: StepData;
  adding: boolean;
  customText: string;
  canContinue: boolean;
  onSetAdding: (v: boolean) => void;
  onCustomText: (v: string) => void;
  onToggle: (cfg: StepConfig, value: string) => void;
  onAddCustom: (id: StepId, raw: string) => void;
  onSetTextAnswer: (id: StepId, value: string) => void;
  onBack: () => void;
  onNext: () => void;
  onRefine: (cfg: StepConfig) => void;
}) {
  const isLast = stepIdx === STEPS.length - 1;
  const isTextInput = step.textInput;
  const answerValue = d.selected[0] ?? "";

  function submitCustom(e: React.FormEvent) {
    e.preventDefault();
    onAddCustom(step.id, customText);
    onCustomText("");
    onSetAdding(false);
  }

  function submitTextAnswer(e: React.FormEvent) {
    e.preventDefault();
    if (canContinue) onNext();
  }

  return (
    <div className="flex flex-1 flex-col py-10 sm:py-14">
      {/* progress */}
      <div className="flex gap-1.5">
        {STEPS.map((s, i) => (
          <div
            key={s.id}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < stepIdx || skip.has(s.id)
                ? "bg-mint/70"
                : i === stepIdx
                  ? "bg-mint"
                  : "bg-line"
            }`}
          />
        ))}
      </div>

      <div className="animate-fade-up mt-9" style={{ animationDelay: "40ms" }}>
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-mint">
          {step.eyebrow}
        </p>
        <h1 className="mt-3 max-w-xl font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
          {step.question}
        </h1>
        <p className="mt-3 text-[1.02rem] text-ink-soft">{step.helper}</p>
      </div>

      {/* answer input / choices */}
      <div
        className="animate-fade-up mt-8 grid gap-2.5 sm:grid-cols-2"
        style={{ animationDelay: "120ms" }}
      >
        {isTextInput ? (
          <form
            onSubmit={submitTextAnswer}
            className="rounded-xl border border-line bg-card px-4 py-3.5 transition-colors focus-within:border-mint sm:col-span-2"
          >
            <label className="sr-only" htmlFor={`${step.id}-answer`}>
              {step.question}
            </label>
            {step.longInput ? (
              <textarea
                id={`${step.id}-answer`}
                autoFocus
                rows={4}
                value={answerValue}
                onChange={(e) => onSetTextAnswer(step.id, e.target.value)}
                placeholder={step.placeholder}
                className="max-h-48 min-h-28 w-full resize-y bg-transparent text-[1rem] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
              />
            ) : (
              <input
                id={`${step.id}-answer`}
                autoFocus
                type="text"
                value={answerValue}
                onChange={(e) => onSetTextAnswer(step.id, e.target.value)}
                placeholder={step.placeholder}
                className="w-full bg-transparent text-[1rem] text-ink placeholder:text-ink-faint focus:outline-none"
              />
            )}
          </form>
        ) : (
          <>
            {d.loading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-[58px] rounded-xl border border-line" />
                ))
              : d.choices.map((choice) => {
                  const selected = d.selected.includes(choice);
                  return (
                    <button
                      key={choice}
                      onClick={() => onToggle(step, choice)}
                      className={`group flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-all ${
                        selected
                          ? "border-mint bg-mint/10 shadow-[0_0_0_1px_var(--color-mint),0_0_28px_-12px_var(--color-mint)]"
                          : "border-line bg-card hover:border-line-bright hover:bg-card-2"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border text-[0.7rem] transition-colors ${
                          step.multi ? "rounded-[5px]" : "rounded-full"
                        } ${
                          selected
                            ? "border-mint bg-mint text-[#06231a]"
                            : "border-line-bright text-transparent group-hover:border-ink-faint"
                        }`}
                      >
                        ✓
                      </span>
                      <span
                        className={`text-[0.97rem] leading-snug ${
                          selected ? "text-ink" : "text-ink-soft"
                        }`}
                      >
                        {choice}
                      </span>
                    </button>
                  );
                })}

            {/* add your own */}
            {!d.loading &&
              (adding ? (
                <form
                  onSubmit={submitCustom}
                  className="flex items-center gap-2 rounded-xl border border-mint/60 bg-card px-3 py-2 sm:col-span-2"
                >
                  <input
                    autoFocus
                    value={customText}
                    onChange={(e) => onCustomText(e.target.value)}
                    placeholder="Write your own answer…"
                    className="flex-1 bg-transparent px-1 py-1.5 text-[0.97rem] text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!customText.trim()}
                    className="rounded-lg bg-mint px-3.5 py-1.5 text-sm font-semibold text-[#06231a] transition-colors hover:bg-mint-deep disabled:opacity-40"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSetAdding(false);
                      onCustomText("");
                    }}
                    className="px-2 py-1 text-ink-faint transition-colors hover:text-ink"
                    aria-label="Cancel"
                  >
                    ✕
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => onSetAdding(true)}
                  className="flex items-center gap-3 rounded-xl border border-dashed border-line-bright bg-transparent px-4 py-3.5 text-left text-ink-soft transition-colors hover:border-mint hover:text-ink"
                >
                  <span
                    aria-hidden
                    className="grid h-5 w-5 place-items-center rounded-full border border-line-bright text-sm"
                  >
                    +
                  </span>
                  <span className="text-[0.97rem]">Add your own</span>
                </button>
              ))}
          </>
        )}
      </div>

      {!isTextInput && d.usedFallback && (
        <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-ink-faint">
          Example starting points · connect the studio for tailored suggestions
        </p>
      )}

      {/* actions */}
      <div className="mt-auto flex flex-col gap-3 pt-12 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            disabled={stepIdx === 0}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            ← Back
          </button>
          <button
            onClick={() => onRefine(step)}
            className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2.5 text-sm font-medium text-amber transition-colors hover:border-amber/60 hover:bg-amber/5"
          >
            <span aria-hidden>◈</span> Refine with chat
          </button>
        </div>
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="group inline-flex items-center justify-center gap-2 rounded-full bg-mint px-7 py-3 font-semibold text-[#06231a] transition-all hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLast ? "Generate redesigns" : "Continue"}
          <span aria-hidden className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Diagnosis read-back
 * ------------------------------------------------------------------ */
function DiagnosisView({
  diagnosis,
  onChange,
  onBack,
  onRetry,
  onConfirm,
}: {
  diagnosis: { draft: Diagnosis | null; loading: boolean; error: string | null };
  onChange: (draft: Diagnosis) => void;
  onBack: () => void;
  onRetry: () => void;
  onConfirm: (draft: Diagnosis) => void;
}) {
  const draft = diagnosis.draft;

  function update(next: Partial<Diagnosis>) {
    if (!draft) return;
    onChange({ ...draft, ...next });
  }

  function updateConstraint(index: number, patch: Partial<DiagnosisConstraint>) {
    if (!draft) return;
    update({
      constraints: draft.constraints.map((constraint, i) =>
        i === index ? { ...constraint, ...patch } : constraint,
      ),
    });
  }

  function removeConstraint(index: number) {
    if (!draft) return;
    update({ constraints: draft.constraints.filter((_, i) => i !== index) });
  }

  function addConstraint() {
    if (!draft) return;
    update({
      constraints: [...draft.constraints, { text: "", kind: "hurts", note: "" }],
    });
  }

  function updateHabit(index: number, patch: Partial<DiagnosisHabit>) {
    if (!draft) return;
    update({
      habits: draft.habits.map((habit, i) => (i === index ? { ...habit, ...patch } : habit)),
    });
  }

  function removeHabit(index: number) {
    if (!draft) return;
    update({ habits: draft.habits.filter((_, i) => i !== index) });
  }

  function addHabit() {
    if (!draft) return;
    update({
      habits: [...draft.habits, { text: "", status: "reinforces" }],
    });
  }

  if (diagnosis.loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <div className="flex items-center gap-2 text-ink-soft">
          <span className="think-dot" style={{ animationDelay: "0ms" }} />
          <span className="think-dot" style={{ animationDelay: "150ms" }} />
          <span className="think-dot" style={{ animationDelay: "300ms" }} />
        </div>
        <p className="mt-5 font-display text-xl text-ink">Reading the assignment back…</p>
        <p className="mt-2 max-w-md text-sm text-ink-soft">
          Naming the constraints it actually creates and the habits it leaves alone.
        </p>
      </div>
    );
  }

  if (diagnosis.error || !draft) {
    return (
      <div className="flex flex-1 flex-col py-10 sm:py-14">
        <div className="animate-fade-up">
          <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-rose">
            Read-back failed
          </p>
          <h1 className="mt-3 font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
            The studio could not diagnose this yet.
          </h1>
          <p className="mt-3 max-w-xl text-[1.02rem] text-ink-soft">
            {diagnosis.error ?? "Try again, or go back and adjust the assignment details."}
          </p>
        </div>
        <div className="mt-auto flex flex-col gap-3 pt-12 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={onBack}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
          >
            ← Back to answers
          </button>
          <button
            onClick={onRetry}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-mint px-7 py-3 font-semibold text-[#06231a] transition-colors hover:bg-mint-deep"
          >
            Try again
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    );
  }

  const canConfirm = draft.purpose.trim().length > 0;

  return (
    <div className="flex flex-1 flex-col py-10 sm:py-14">
      <div className="animate-fade-up">
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-mint">
          Read-back
        </p>
        <h1 className="mt-3 font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
          Confirm what this assignment is really doing.
        </h1>
        <p className="mt-3 max-w-xl text-[1.02rem] text-ink-soft">
          Edit the chips before generating. The redesigns will use this as their starting
          point.
        </p>
      </div>

      <div className="animate-fade-up mt-8 space-y-6" style={{ animationDelay: "80ms" }}>
        <section className="rounded-2xl border border-line bg-card p-5 sm:p-6">
          <label
            htmlFor="diagnosis-purpose"
            className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-mint"
          >
            Purpose read
          </label>
          <textarea
            id="diagnosis-purpose"
            rows={2}
            value={draft.purpose}
            onChange={(e) => update({ purpose: e.target.value })}
            className="mt-3 min-h-20 w-full resize-y rounded-xl border border-line bg-panel px-4 py-3 text-[0.98rem] leading-relaxed text-ink placeholder:text-ink-faint transition-colors focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint/15"
          />
        </section>

        <section className="rounded-2xl border border-line bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-mint">
                Current constraints
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                Mark what bites and what is just format.
              </p>
            </div>
            <button
              type="button"
              onClick={addConstraint}
              className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-mint transition-colors hover:border-mint hover:bg-mint/10"
            >
              + Add
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {draft.constraints.map((constraint, index) => (
              <div
                key={index}
                className="rounded-xl border border-line bg-panel px-3 py-3 transition-colors focus-within:border-mint"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select
                    value={constraint.kind}
                    onChange={(e) =>
                      updateConstraint(index, {
                        kind: e.target.value === "hurts" ? "hurts" : "inert",
                      })
                    }
                    className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink focus:border-mint focus:outline-none"
                    aria-label="Constraint kind"
                  >
                    <option value="hurts">hurts</option>
                    <option value="inert">inert</option>
                  </select>
                  <input
                    value={constraint.text}
                    onChange={(e) => updateConstraint(index, { text: e.target.value })}
                    placeholder="Name the constraint"
                    className="min-w-0 flex-1 bg-transparent px-1 py-2 text-[0.97rem] text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeConstraint(index)}
                    className="self-start rounded-full px-2 py-1 text-ink-faint transition-colors hover:text-ink sm:self-auto"
                    aria-label="Remove constraint"
                  >
                    ✕
                  </button>
                </div>
                <input
                  value={constraint.note}
                  onChange={(e) => updateConstraint(index, { note: e.target.value })}
                  placeholder="Why this does or doesn't force better thinking"
                  className="mt-1 w-full bg-transparent px-1 py-1.5 text-sm text-ink-soft placeholder:text-ink-faint focus:outline-none"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-mint">
                Student habits
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                Name what students can do on autopilot here.
              </p>
            </div>
            <button
              type="button"
              onClick={addHabit}
              className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-mint transition-colors hover:border-mint hover:bg-mint/10"
            >
              + Add
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {draft.habits.map((habit, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-3 transition-colors focus-within:border-mint sm:flex-row sm:items-center"
              >
                <select
                  value={habit.status}
                  onChange={(e) => {
                    const value = e.target.value;
                    updateHabit(index, {
                      status:
                        value === "breaks" || value === "reinforces" ? value : "untouched",
                    });
                  }}
                  className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink focus:border-mint focus:outline-none"
                  aria-label="Habit status"
                >
                  <option value="breaks">breaks</option>
                  <option value="reinforces">reinforces</option>
                  <option value="untouched">untouched</option>
                </select>
                <input
                  value={habit.text}
                  onChange={(e) => updateHabit(index, { text: e.target.value })}
                  placeholder="Name the habit"
                  className="min-w-0 flex-1 bg-transparent px-1 py-2 text-[0.97rem] text-ink placeholder:text-ink-faint focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeHabit(index)}
                  className="self-start rounded-full px-2 py-1 text-ink-faint transition-colors hover:text-ink sm:self-auto"
                  aria-label="Remove habit"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-card p-5 sm:p-6">
          <label
            htmlFor="diagnosis-note"
            className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-amber"
          >
            Your note
          </label>
          <textarea
            id="diagnosis-note"
            rows={4}
            value={draft.note ?? ""}
            onChange={(e) => update({ note: e.target.value })}
            placeholder="What do students do on autopilot with this kind of assignment?"
            className="mt-3 min-h-28 w-full resize-y rounded-xl border border-line bg-panel px-4 py-3 text-[0.98rem] leading-relaxed text-ink placeholder:text-ink-faint transition-colors focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint/15"
          />
        </section>
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-12 sm:flex-row sm:items-center sm:justify-between">
        <button
          onClick={onBack}
          className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
        >
          ← Back to answers
        </button>
        <button
          onClick={() => onConfirm(draft)}
          disabled={!canConfirm}
          className="group inline-flex items-center justify-center gap-2 rounded-full bg-mint px-7 py-3 font-semibold text-[#06231a] transition-colors hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate redesigns
          <span aria-hidden className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Redesign results
 * ------------------------------------------------------------------ */
function RedesignView({
  redesign,
  swapState,
  clarificationAnswer,
  onClarificationAnswer,
  onSubmitClarification,
  onRefinePrototype,
  onSwapConstraint,
  onOwnDirection,
  onRefineAll,
}: {
  redesign: { text: string; loading: boolean; error: string | null };
  swapState: SwapState | null;
  clarificationAnswer: string;
  onClarificationAnswer: (value: string) => void;
  onSubmitClarification: (value: string) => void;
  onRefinePrototype: (p: Prototype) => void;
  onSwapConstraint: (index: number, p: Prototype, constraint: string) => void;
  onOwnDirection: () => void;
  onRefineAll: () => void;
}) {
  const { preamble, prototypes } = parsePrototypes(redesign.text);
  const empty = redesign.loading && redesign.text.trim() === "";
  const awaitingClarification =
    !redesign.loading &&
    !redesign.error &&
    redesign.text.trim() !== "" &&
    prototypes.length === 0;

  function submitClarification(e: React.FormEvent) {
    e.preventDefault();
    if (!clarificationAnswer.trim()) return;
    onSubmitClarification(clarificationAnswer);
  }

  return (
    <div className="flex flex-1 flex-col py-10 sm:py-14">
      <div className="animate-fade-up">
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.28em] text-mint">
          {awaitingClarification ? "A couple of questions" : "Your redesigns"}
        </p>
        <h1 className="mt-3 font-display text-[2.1rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[2.7rem]">
          {awaitingClarification
            ? "Just a little more context."
            : "Pick a direction to build on."}
        </h1>
        <p className="mt-3 max-w-xl text-[1.02rem] text-ink-soft">
          {awaitingClarification
            ? "Answer what you can below — even a rough detail helps the studio suggest directions you'll actually want to use."
            : "Here are a few ways to rework the assignment. Each one shows what students do now, what to try instead, and what it changes in their work. Like one? Refine it in chat, or bring your own idea."}
        </p>
      </div>

      {empty && (
        <div className="mt-10 flex items-center gap-2 text-ink-soft">
          <span className="think-dot" style={{ animationDelay: "0ms" }} />
          <span className="think-dot" style={{ animationDelay: "150ms" }} />
          <span className="think-dot" style={{ animationDelay: "300ms" }} />
          <span className="ml-2 text-sm">Thinking through the brief…</span>
        </div>
      )}

      {preamble && !empty && (
        <div className="studio-prose mt-8 text-[0.98rem] text-ink-soft">
          <StudioMarkdown>{preamble}</StudioMarkdown>
        </div>
      )}

      {awaitingClarification && (
        <form
          onSubmit={submitClarification}
          className="mt-6 rounded-2xl border border-line bg-card p-5 sm:p-6"
        >
          <label
            htmlFor="clarification-answer"
            className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-amber"
          >
            Additional context
          </label>
          <textarea
            id="clarification-answer"
            value={clarificationAnswer}
            onChange={(e) => onClarificationAnswer(e.target.value)}
            rows={5}
            placeholder="Answer any questions you can. If something is unknown, say that."
            className="mt-3 min-h-32 w-full resize-y rounded-xl border border-line bg-panel px-4 py-3 text-[0.98rem] leading-relaxed text-ink placeholder:text-ink-faint transition-colors focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint/15"
          />
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="submit"
              disabled={!clarificationAnswer.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-semibold text-[#06231a] transition-colors hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              Generate directions
              <span aria-hidden>→</span>
            </button>
            <button
              type="button"
              onClick={() => onSubmitClarification("")}
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:border-line-bright hover:text-ink"
            >
              Generate with current info
            </button>
          </div>
        </form>
      )}

      <div className="mt-6 space-y-4">
        {prototypes.map((p, i) => {
          const isLast = i === prototypes.length - 1;
          const activeSwap = swapState?.index === i ? swapState : null;
          const swappedPrototype = activeSwap?.text
            ? parsePrototypes(activeSwap.text).prototypes[0]
            : null;
          const displayed = swappedPrototype ?? p;
          const isSwapping = Boolean(activeSwap?.loading);
          return (
            <article
              key={i}
              className="animate-fade-in rounded-2xl border border-line bg-card p-5 transition-colors hover:border-line-bright sm:p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <h2 className="flex items-baseline gap-2.5 font-display text-[1.35rem] font-semibold leading-tight text-ink">
                  <span aria-hidden className="text-mint">
                    ◇
                  </span>
                  <span>{displayed.title}</span>
                </h2>
                <span className="mt-1 shrink-0 font-mono text-[0.62rem] uppercase tracking-widest text-ink-faint tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              {isSwapping && !activeSwap?.text && (
                <div className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
                  <span className="think-dot" style={{ animationDelay: "0ms" }} />
                  <span className="think-dot" style={{ animationDelay: "150ms" }} />
                  <span className="think-dot" style={{ animationDelay: "300ms" }} />
                  <span className="ml-2">Rebuilding this constraint…</span>
                </div>
              )}
              {displayed.body && (
                <PrototypeBody
                  body={displayed.body}
                  streaming={(redesign.loading && isLast) || isSwapping}
                  swapping={isSwapping}
                  onSwapConstraint={(constraint) => onSwapConstraint(i, displayed, constraint)}
                />
              )}
              {activeSwap?.error && (
                <div
                  role="alert"
                  className="mt-4 rounded-xl border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-ink"
                >
                  {activeSwap.error}
                </div>
              )}
              <div className="mt-4 border-t border-line/70 pt-4">
                <button
                  onClick={() => onRefinePrototype(displayed)}
                  disabled={isSwapping}
                  className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-medium text-mint transition-colors hover:border-mint hover:bg-mint/10"
                >
                  <span aria-hidden>◈</span> Refine this one
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {redesign.error && (
        <div
          role="alert"
          className="mt-8 rounded-xl border border-rose/40 bg-rose/10 px-5 py-4"
        >
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-rose">
            Couldn&apos;t reach the studio
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink">{redesign.error}</p>
        </div>
      )}

      {prototypes.length > 0 && !redesign.loading && (
        <div className="mt-10 rounded-2xl border border-dashed border-line-bright p-5 sm:p-6">
          <p className="font-display text-lg text-ink">None of these quite fit?</p>
          <p className="mt-1 text-sm text-ink-soft">
            Bring your own idea, or talk through the whole set with the studio.
          </p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              onClick={onOwnDirection}
              className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-semibold text-[#06231a] transition-colors hover:bg-mint-deep"
            >
              <span aria-hidden>+</span> Bring your own idea
            </button>
            <button
              onClick={onRefineAll}
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-amber transition-colors hover:border-amber/60 hover:bg-amber/5"
            >
              <span aria-hidden>◈</span> Talk it through
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
