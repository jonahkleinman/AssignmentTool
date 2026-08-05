# Retrieval evaluation data

- `intakes.json` contains the fifteen assignment cases used for labeling and retrieval tests.
- `sources.json` is generated from `knowledge/index.json` with `npm run build:source-catalog`.
- `labels/<labeler>.json` contains human source-level relevance judgments.
- `results/` contains timestamped retrieval runs from `npm run eval:retrieval`.

`labels/toy.json` is synthetic smoke-test data for the harness. It is not an answer key and must not be used to choose a production retrieval configuration.

Open `/eval/label?labeler=<name>` while the local app is running to create or resume real labels. The page deliberately hides retrieval scores and randomizes source order independently for each intake.

## Hybrid labeling workflow

1. Generate an independent AI baseline for all intakes with `npm run eval:ai-labels`. The judge sees assignment fields and source summaries, but never retrieval scores or ranks. Its rationales are retained in `eval/ai/ai-labels.audit.json`.
2. Have people label a smaller shared subset independently in the existing UI. Do not show them the AI labels first.
3. Export a hosted human label set with `npm run eval:export-labels -- --labeler=jonah`.
4. Compare only the completed subset, for example:
   `npm run eval:agreement -- --a=eval/labels/ai.json --b=eval/labels/jonah.json --intakes=austen-friendship,austen-letters-form,neuroscience-ethics-case,infinite-monkey-program,algebra-exp-log-test`
5. Review the largest disagreements with a domain expert. Treat the AI set as a scalable baseline, not unquestioned ground truth.

Both `eval:agreement` and `eval:retrieval` accept `--intakes=<comma-separated ids>`. Use this whenever a human has labeled only a subset; otherwise untouched default zeroes would be incorrectly treated as judgments.
