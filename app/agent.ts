/* ------------------------------------------------------------------ *
 *  Shared client-side contract for the Assessment Studio wizard.
 *  Talks to two backend routes (see plan):
 *    POST /api/suggest  → { choices: string[] }      (per-step choices)
 *    POST /api/redesign → streamed text/markdown      (chat + redesigns)
 * ------------------------------------------------------------------ */

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export type StepId = "assessment" | "parts" | "goal" | "constraints";

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
  /** Offline fallback choices, used only if /api/suggest is unavailable. */
  fallback: string[];
}

export const STEPS: StepConfig[] = [
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
    id: "constraints",
    label: "Current constraints",
    eyebrow: "The boundaries",
    question: "Any constraints we should respect?",
    helper: "Optional — time, length, format, sources.",
    multi: true,
    optional: true,
    fallback: [
      "Must fit one class period",
      "No outside sources allowed",
      "Completed individually",
      "Handwritten and in-class",
      "Nothing fixed — open to anything",
    ],
  },
];

/** Formats the wizard answers into the first user message (Markdown). */
export function buildIntakeMessage(
  answers: Record<StepId, string>,
  sourceDoc?: string,
): string {
  const lines: string[] = [];
  for (const step of STEPS) {
    const value = answers[step.id]?.trim();
    if (value) lines.push(`**${step.label}:** ${value}`);
  }
  const source = sourceDoc?.trim();
  if (source) {
    lines.push(
      `**Source assignment (verbatim, for grounding):**\n\n${source}`,
    );
  }
  return lines.join("\n\n");
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
