import { DEFAULT_MODEL } from "./prompt";

/* ------------------------------------------------------------------ *
 *  Model selection for the reasoning-heavy routes (redesign, diagnose).
 *
 *  Two arms:
 *    - fast     : OPENAI_MODEL / DEFAULT_MODEL, no reasoning tokens.
 *    - thinking : OPENAI_REASONING_MODEL + reasoning_effort.
 *
 *  reasoningModel() picks the arm for the live app. Which arm is live is
 *  controlled by OPENAI_USE_REASONING so you can A/B without clearing the
 *  configured model id:
 *    - unset            -> thinking if OPENAI_REASONING_MODEL is set, else fast
 *    - false/0/off/no   -> forced fast, even with a reasoning model configured
 *    - true/1/on/yes    -> thinking (falls back to fast if no id configured)
 *
 *  suggest/extract never call this: they stay on the fast model, where
 *  reasoning would only add latency and cost.
 * ------------------------------------------------------------------ */

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value ?? "");
}

export interface ModelConfig {
  model: string;
  /** Only set on the thinking arm; omitted for the fast model. */
  reasoning_effort?: ReasoningEffort;
}

/** The fast (non-reasoning) arm. */
export function fastModel(): ModelConfig {
  return { model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL };
}

/** The thinking arm — the reasoning model if one is configured, else fast. */
export function thinkingModel(): ModelConfig {
  const model = process.env.OPENAI_REASONING_MODEL?.trim();
  if (!model) return fastModel();
  const effort = process.env.OPENAI_REASONING_EFFORT?.trim();
  return { model, reasoning_effort: isReasoningEffort(effort) ? effort : "medium" };
}

/** Whether the thinking arm is live, honouring the OPENAI_USE_REASONING toggle. */
export function reasoningEnabled(): boolean {
  const toggle = process.env.OPENAI_USE_REASONING?.trim().toLowerCase();
  if (toggle === "false" || toggle === "0" || toggle === "off" || toggle === "no") {
    return false;
  }
  if (toggle === "true" || toggle === "1" || toggle === "on" || toggle === "yes") {
    return true;
  }
  // Unset: on when a reasoning model is configured.
  return Boolean(process.env.OPENAI_REASONING_MODEL?.trim());
}

/** Model + effort for redesign/diagnose in the live app. Spread into `create`. */
export function reasoningModel(): ModelConfig {
  return reasoningEnabled() ? thinkingModel() : fastModel();
}
