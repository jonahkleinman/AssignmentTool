# AI judge calibration — 2026-08-03

## Purpose

Tune the source-level LLM relevance judge toward the existing human standard without changing the human labels. The judge received assignment fields and the same source-catalog summaries shown in the labeling UI. It did not receive retrieval scores, retrieval ranks, or human labels.

## Split

- Calibration: `austen-friendship`, `austen-letters-form`, `neuroscience-ethics-case` (78 ratings)
- Held-out validation: `infinite-monkey-program`, `algebra-exp-log-test` (52 ratings)

The prompt was selected using only the calibration assignments. After selecting `query-specific-v5`, it was run once on the held-out assignments. No prompt was tuned against the revealed validation results.

## Calibration results

| Prompt | Exact agreement | Within ±1 | Quadratic-weighted Cohen's kappa |
|---|---:|---:|---:|
| `source-usefulness-v1` | 25.6% | 78.2% | -0.071 |
| `query-specific-v2` | 50.0% | 85.9% | 0.152 |
| `query-specific-v3` | 38.5% | 87.2% | 0.077 |
| `query-specific-v4` | 39.7% | 87.2% | 0.303 |
| `query-specific-v5` | 53.8% | 93.6% | 0.354 |

## Held-out result

| Prompt | Exact agreement | Within ±1 | Quadratic-weighted Cohen's kappa |
|---|---:|---:|---:|
| `query-specific-v5` | 59.6% | 94.2% | 0.170 |

The prompt did not reach the target kappa of approximately 0.4 on calibration and fell substantially on held-out validation. Exact agreement is comparatively high because both labelers assign many zeroes; kappa exposes continued disagreement about the uncommon relevant documents.

On `infinite-monkey-program`, the judge over-credited `DeeperLearning.7.2` and missed human-relevant `Inside the Box — Chapter 2` and `Look Again — 5.Creativity`. Five misleading-flag disagreements also appeared on validation, while the human set marked none.

## Decision

- Do not use the AI judge to fill or replace ground-truth labels yet.
- Keep the existing human judgments unchanged and finish the evaluation set with human labels.
- Before another calibration round, add more human-labeled cases and consider judging neutral excerpts or full documents rather than generated one-sentence summaries whose wording often advertises broad educational usefulness.
