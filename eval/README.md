# Retrieval evaluation data

- `intakes.json` contains the ten assignment cases used for labeling and retrieval tests.
- `sources.json` is generated from `knowledge/index.json` with `npm run build:source-catalog`.
- `labels/<labeler>.json` contains human source-level relevance judgments.
- `results/` contains timestamped retrieval runs from `npm run eval:retrieval`.

`labels/toy.json` is synthetic smoke-test data for the harness. It is not an answer key and must not be used to choose a production retrieval configuration.

Open `/eval/label?labeler=<name>` while the local app is running to create or resume real labels. The page deliberately hides retrieval scores and randomizes source order independently for each intake.
