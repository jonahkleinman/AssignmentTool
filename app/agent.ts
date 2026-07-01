/* ------------------------------------------------------------------ *
 *  Shared client-side contract for the Assessment Studio wizard.
 *  Talks to three backend routes:
 *    POST /api/suggest  → { choices: string[] }      (per-step choices)
 *    POST /api/diagnose → structured diagnosis        (uploaded assignments)
 *    POST /api/redesign → streamed text/markdown      (chat + redesigns)
 * ------------------------------------------------------------------ */

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export type ConstraintKind = "hurts" | "inert";
export type HabitStatus = "breaks" | "reinforces" | "untouched";

export interface DiagnosisConstraint {
  text: string;
  kind: ConstraintKind;
  note: string;
}

export interface DiagnosisHabit {
  text: string;
  status: HabitStatus;
}

export interface Diagnosis {
  purpose: string;
  constraints: DiagnosisConstraint[];
  habits: DiagnosisHabit[];
  note?: string;
}

export type StepId = "grade" | "assessment" | "parts" | "goal" | "time";

export interface StepConfig {
  id: StepId;
  label: string; // short label used in intake message + progress
  eyebrow: string; // framework framing (ingredient / recipe / function)
  question: string;
  helper: string;
  placeholder?: string;
  textInput?: boolean;
  longInput?: boolean;
  multi: boolean;
  optional: boolean;
  /** Render the fallback list as the choices directly, skipping /api/suggest. */
  staticChoices?: boolean;
  /** Offline fallback choices, used only if /api/suggest is unavailable. */
  fallback: string[];
}

export const STEPS: StepConfig[] = [
  {
    id: "grade",
    label: "Grade level",
    eyebrow: "The students",
    question: "What grade are your students in?",
    helper:
      "This levels every suggestion and redesign to your students. Pick one or more grades, or add a specific grade or age of your own.",
    multi: true,
    optional: false,
    staticChoices: true,
    fallback: [
      "5th grade",
      "6th grade",
      "7th grade",
      "8th grade",
      "9th grade",
      "10th grade",
      "11th grade",
      "12th grade",
    ],
  },
  {
    id: "assessment",
    label: "Assignment type",
    eyebrow: "The assignment",
    question: "What type of assignment are we reworking?",
    helper: "A short answer is enough. Name the format or genre students currently complete.",
    placeholder: "e.g. short-answer quiz, DBQ essay, lab report, oral presentation",
    textInput: true,
    multi: false,
    optional: false,
    fallback: [],
  },
  {
    id: "parts",
    label: "Assignment components / description",
    eyebrow: "The recipe",
    question: "What does the assignment ask students to do now?",
    helper: "Briefly describe the current prompt, components, or sequence.",
    placeholder:
      "e.g. Students read two sources, answer three short questions, then write a paragraph defending a claim.",
    textInput: true,
    longInput: true,
    multi: false,
    optional: false,
    fallback: [],
  },
  {
    id: "goal",
    label: "Learning goals",
    eyebrow: "The function",
    question: "Which learning goals should it reveal?",
    helper: "Select every goal that matters. These give the redesign its target.",
    multi: true,
    optional: false,
    fallback: [
      "Build and defend an original argument",
      "Synthesize several sources into one view",
      "Apply a concept to an unfamiliar situation",
      "Show a clear, repeatable method",
      "Communicate ideas to a real audience",
    ],
  },
  {
    id: "time",
    label: "Time budget",
    eyebrow: "The real constraint",
    question: "How much time do students get?",
    helper:
      "The one boundary worth pinning down — every redesign has to fit it. The studio reads the rest of the constraints off the assignment itself.",
    multi: false,
    optional: false,
    staticChoices: true,
    fallback: [
      "One class period",
      "Two class periods",
      "One class period plus homework",
      "About a week, take-home",
      "A multi-week project",
    ],
  },
];

/** Formats the wizard answers into the first user message (Markdown). */
export function buildIntakeMessage(
  answers: Record<StepId, string>,
  sourceDoc?: string,
  diagnosis?: Diagnosis | null,
): string {
  const lines: string[] = [];
  for (const step of STEPS) {
    const value = answers[step.id]?.trim();
    if (value) lines.push(`**${step.label}:** ${value}`);
  }
  const diagnosisBlock = buildDiagnosisBlock(diagnosis);
  if (diagnosisBlock) lines.push(diagnosisBlock);
  const source = sourceDoc?.trim();
  if (source) {
    lines.push(
      `**Source assignment (verbatim, for grounding):**\n\n${source}`,
    );
  }
  return lines.join("\n\n");
}

export function buildDiagnosisBlock(diagnosis?: Diagnosis | null): string {
  if (!diagnosis) return "";
  const lines = [
    "**Confirmed diagnosis (teacher-reviewed; use this to anchor redesigns):**",
    `Purpose read: ${diagnosis.purpose.trim() || "(not supplied)"}`,
    "Constraints:",
    ...diagnosis.constraints
      .filter((constraint) => constraint.text.trim())
      .map((constraint) => {
        const note = constraint.note.trim() ? ` — ${constraint.note.trim()}` : "";
        return `- [${constraint.kind}] ${constraint.text.trim()}${note}`;
      }),
    "Habits:",
    ...diagnosis.habits
      .filter((habit) => habit.text.trim())
      .map((habit) => `- [${habit.status}] ${habit.text.trim()}`),
  ];
  const note = diagnosis.note?.trim();
  if (note) lines.push(`Teacher note: ${note}`);
  return lines.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeConstraintKind(value: unknown): ConstraintKind {
  return value === "hurts" || value === "inert" ? value : "inert";
}

function normalizeHabitStatus(value: unknown): HabitStatus {
  return value === "breaks" || value === "reinforces" || value === "untouched"
    ? value
    : "untouched";
}

function normalizeDiagnosis(value: unknown): Diagnosis {
  const source = isObject(value) ? value : {};
  return {
    purpose: typeof source.purpose === "string" ? source.purpose : "",
    constraints: Array.isArray(source.constraints)
      ? source.constraints
          .filter(isObject)
          .map((item) => ({
            text: typeof item.text === "string" ? item.text : "",
            kind: normalizeConstraintKind(item.kind),
            note: typeof item.note === "string" ? item.note : "",
          }))
          .filter((item) => item.text.trim())
      : [],
    habits: Array.isArray(source.habits)
      ? source.habits
          .filter(isObject)
          .map((item) => ({
            text: typeof item.text === "string" ? item.text : "",
            status: normalizeHabitStatus(item.status),
          }))
          .filter((item) => item.text.trim())
      : [],
    note: typeof source.note === "string" ? source.note : "",
  };
}

export interface ExtractionResult {
  assessment: string;
  parts: string;
  rawText: string;
}

/**
 * Uploads an assignment file to /api/extract and returns the distilled
 * assignment type, current-task description, and the raw source text.
 */
export async function extractAssignment(
  file: File,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const body = new FormData();
  body.append("file", file);

  const res = await fetch("/api/extract", { method: "POST", body, signal });
  if (!res.ok) {
    let message = "Couldn't read that file.";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* non-JSON error body — keep default */
    }
    throw new Error(message);
  }

  const data = (await res.json()) as Partial<ExtractionResult>;
  return {
    assessment: typeof data.assessment === "string" ? data.assessment : "",
    parts: typeof data.parts === "string" ? data.parts : "",
    rawText: typeof data.rawText === "string" ? data.rawText : "",
  };
}

/** Fetches AI-suggested answer choices for a step, given prior answers. */
export async function fetchSuggestions(
  step: StepId,
  answers: Record<StepId, string>,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, answers }),
    signal,
  });
  if (!res.ok) throw new Error("suggest unavailable");
  const data = (await res.json()) as { choices?: unknown };
  if (!Array.isArray(data.choices)) throw new Error("bad suggest response");
  return data.choices
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .slice(0, 6);
}

export async function diagnoseAssignment(
  sourceDoc: string,
  answers: Record<StepId, string>,
  signal?: AbortSignal,
): Promise<Diagnosis> {
  const res = await fetch("/api/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceDoc, answers }),
    signal,
  });

  if (!res.ok) {
    let message = "The studio could not read the assignment back yet.";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* non-JSON error body — keep default */
    }
    throw new Error(message);
  }

  return normalizeDiagnosis((await res.json()) as Partial<Diagnosis>);
}

export function buildConstraintSwapMessage(
  title: string,
  currentBody: string,
  constraint: string,
): string {
  return [
    `Rebuild only the "${title}" redesign around this replacement constraint: ${constraint}`,
    "",
    "Return exactly one prototype in the required Markdown shape, with the same heading style and all required fields.",
    "A different constraint should change what students do, what thinking it forces, and what the teacher sees.",
    "Keep the confirmed diagnosis and time budget in force. Do not rewrite the other redesigns.",
    "",
    "Current prototype:",
    `### ${title}`,
    currentBody,
  ].join("\n");
}

/** Streams the assistant reply for `messages`, calling onDelta per chunk. */
export async function streamRedesign(
  messages: Message[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const payloadMessages = messages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);

  if (!payloadMessages.some((message) => message.role === "user")) {
    throw new Error("Add a message before asking the studio to respond.");
  }

  const res = await fetch("/api/redesign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: payloadMessages }),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = "The studio is unavailable right now.";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* non-JSON error body — keep default */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onDelta(decoder.decode(value, { stream: true }));
  }
}
