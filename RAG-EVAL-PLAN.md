# RAG Retrieval Evaluation — Implementation Plan

**Audience:** a developer picking this up without prior context.
**Goal:** build a labeled evaluation set and a measurement harness for the knowledge-retrieval system, so we can quantify retrieval quality and iterate on it (threshold, `k`, query construction, lexical boost) with numbers instead of guesses.

This plan is self-contained. Read it top to bottom before writing code. Section 10 lists gotchas that will bite you if you skip them.

---

## 1. Background: how retrieval works today

The app is an OpenAI-based Next.js tool that helps teachers redesign assessments. Several routes retrieve passages from a fixed reference library and inject them into the model prompt as *background inspiration* — the passages are never quoted or cited, they only shape the model's instincts.

Key code:

- **`lib/knowledge.ts`**
  - `loadIndex()` reads `knowledge/index.json` (built by `scripts/build-knowledge.ts`) into memory and caches it. Shape: `{ model, builtAt, count, chunks[] }` where each chunk is `{ id, source, page, text, embedding }`. Currently ~**374 chunks** across ~**26 source documents**; embedding model is `text-embedding-3-small`.
  - `buildFocusedKnowledgeQuery(input)` (`lib/knowledge.ts:118`) turns a structured intake into a retrieval query string.
  - `retrieve(client, query, k, signal)` (`lib/knowledge.ts:136`) embeds the query, scores **every** chunk by `cosineSimilarity + lexicalBoost`, sorts, and slices to `k`. **There is no score threshold** — it always returns `k` chunks, even bad ones.
  - `lexicalBoost(query, chunk)` (`lib/knowledge.ts:68`) is a hardcoded regex bump for habit/attention/"habituation" vocabulary. It is a thumb on the scale toward one theme and must be treated as a tunable, not a constant.
  - `formatKnowledgeBlock(passages)` wraps passages in a "Background thinking … never quote" system block.

- **Routes that retrieve:** `app/api/diagnose/route.ts` (`k=10`), `app/api/lens/route.ts` (`k=10`), `app/api/redesign/route.ts` (`k=5`). Retrieval is best-effort: wrapped in `try/catch`, degrades to prompt-only on any failure. The redesign route currently rebuilds its query by regex-extracting fields back out of an already-formatted markdown message (`buildRedesignKnowledgeQuery`, `app/api/redesign/route.ts:94`) — brittle; see §9 (point 4).

- **Intake shape:** `lib/prompt.ts` defines `Answers = Record<StepId, string>` with `StepId = "grade" | "assessment" | "parts" | "goal" | "time"`.

---

## 2. What we are building (scope)

1. A **labeled evaluation set**: ~8–10 representative assignment intakes, plus human relevance labels for each.
2. A **retrieval eval harness**: runs intakes through retrieval and computes Recall@k, Precision@k, MRR, nDCG.
3. A **labeling UI**: an internal page where a human scores each source document's relevance to each intake.
4. An **inter-annotator agreement** check between two labelers.
5. **Experiments** driven by the harness (threshold, `k`, lexical boost, query construction) and a **recommendation** to apply to the routes.

Out of scope for now: swapping the flat-file index for a real vector store (fine at this corpus size), and any change to the generation prompts.

---

## 3. Design decisions (and why) — do not silently change these

| Decision | Rationale |
|---|---|
| **Label at the SOURCE-DOCUMENT level, not the chunk level.** | Chunk `id`s are unstable: every `npm run build:knowledge` re-chunks (greedy ~3000-char windows, 400-char overlap) and re-embeds, so chunk IDs shift whenever a doc is added, chunk size changes, or the embed model changes — invalidating any chunk-keyed labels. The `source` string is stable. **Bonus:** there are only ~26 sources, small enough to label *all of them* per intake exhaustively → we get true recall with **no pooling**. Accepted tradeoff: coarser than chunk-level (a source is "relevant" even if only one paragraph is). |
| **Graded relevance, 0–3** (0 = not relevant, 3 = highly relevant), plus an optional `misleading` flag. | nDCG uses the grades; binary throws away information the labeler is already forming. The `misleading` flag separates harmless off-topic noise from actively wrong nudges. |
| **Two labelers: the domain expert (primary) + the developer/owner (overlap).** | The expert's labels are the authoritative answer key and are independent of whoever built the system (avoids the author-grades-own-homework bias). The overlap subset lets us measure agreement and validate the cheaper labeler. |
| **Hide similarity scores from the labeler; randomize source order.** | Prevents anchoring on the model's confidence and position bias — otherwise labels just rubber-stamp the current ranking and can't catch it being wrong. |
| **Eval calls `retrieve()` / `buildFocusedKnowledgeQuery()` directly, not through the HTTP routes.** | Retrieval is a pure function; testing it directly avoids route error-swallowing and network flakiness. Build the query from **structured intake fields** (not by reparsing markdown) — this is also the target state for the redesign route (§9, point 4). |
| **Relevance question the labeler answers:** *"Would the ideas in this source help someone redesign THIS assignment?"* | Retrieval here is inspiration, not fact-lookup. Relevance ≠ topical similarity; it's usefulness for redesign. |

---

## 4. Data artifacts and formats

Create an `eval/` directory at the repo root.

### 4.1 `eval/intakes.json`
Array of intakes. Fields mirror `Answers` (`lib/prompt.ts`) plus the raw assignment text.

```jsonc
[
  {
    "id": "austen-friendship",           // stable slug, never reuse
    "grade": "10th grade",
    "assessment": "Literary analysis essay",
    "parts": "Students write a thesis-driven essay analyzing how Austen values friendship in Pride and Prejudice...",
    "goal": "Build an interpretation from textual evidence, not summarize plot.",
    "time": "One 50-min class to draft; homework to revise",
    "sourceDoc": "Full assignment handout text (optional but preferred)",
    "expectedProfile": "on-corpus"       // free-form note: on-corpus | mixed | off-corpus. For sanity-checking only.
  }
]
```

**Coverage requirement.** The set must span the axis from *open-ended* (where the corpus should fire) to *rote/computational* (where it should stay quiet). Source assignments are already collected — see §5. Include the two rote-math ones as **negative controls**: a correct system should return **nothing above threshold** for them.

### 4.2 `eval/sources.json` (generated once, regenerate when the corpus changes)
The catalog the labeling UI shows. One entry per distinct `source` in `knowledge/index.json`.

```jsonc
[
  { "source": "Look Again — 5.Creativity", "chunkCount": 18, "summary": "One-line, human-readable gist of this source, generated from its chunks." }
]
```

Build it with a script (`scripts/build-source-catalog.ts`): read the index, group chunks by `source`, and generate a one-sentence summary per source via one LLM call over that source's concatenated text. **Do not hardcode the source list or the count** — always derive from the index.

### 4.3 `eval/labels/<labeler>.json`
One file per labeler. Every source is scored for every intake; default 0 so the labeler only bumps up the relevant few.

```jsonc
{
  "labeler": "drboynton",
  "labeledAt": "2026-07-30T...",
  "corpusBuiltAt": "<index.builtAt at label time>",   // detect stale labels after a corpus rebuild
  "labels": {
    "austen-friendship": {
      "Look Again — 5.Creativity": { "score": 3, "misleading": false },
      "Reset — Chapter 1": { "score": 0, "misleading": false }
      // ... every source in sources.json
    }
  }
}
```

### 4.4 `eval/results/<timestamp>.json`
Harness output: per-intake and aggregate metrics for a given config, plus the config itself. Keep every run so experiments are diffable.

---

## 5. The collected assignments (input for §4.1)

Already gathered and extracted (scanned ones OCR'd on-device via `scripts/ocr.swift`). Turn each into one intake; for the Austen set pick ~3 varied prompts, not all 18.

| Source assignment | Type | Expected profile |
|---|---|---|
| Austen *Pride & Prejudice* essays (pick ~3: a close-reading, a thematic, a form/structure prompt) | Literary analysis essay | on-corpus |
| Behavioral-Neuroscience Ethics Case Presentation (Belmont Report) | Analysis + group presentation | mixed |
| Soil Texture Lab | Data + Claim-Evidence-Reasoning | mixed |
| Lactase Enzyme Activity | Simulation + data + CER + slides | mixed |
| Infinite Monkey Theorem | Build-a-program (probability) | mixed |
| Tic-Tac-Toe | Java program (methods, arrays) | mixed |
| Algebra II Exp/Log Test | Solve/evaluate, no calculator | **off-corpus (negative control)** |
| Trig Quiz | Graph & solve trig equations | **off-corpus (negative control)** |

---

## 6. Milestones (build in this order)

### M1 — Data foundation
- Write `eval/intakes.json` (§4.1) from the §5 assignments.
- Write `scripts/build-source-catalog.ts` → `eval/sources.json` (§4.2).
- **Acceptance:** both files validate against a shared TS type; `sources.json` count matches distinct `source` values in the index.

### M2 — Retrieval eval harness
`scripts/eval-retrieval.ts` (Node, run via `tsx`/`ts-node`, no dev server):
1. Load intakes, a labels file, and the index.
2. For each intake: build the query with `buildFocusedKnowledgeQuery` from structured fields → embed → score all chunks → rank.
3. **Collapse chunks to sources:** each source's rank = the rank of its highest-scoring chunk; produce a deduped, source-level ranked list.
4. Compute doc-level metrics (§7) against the labels.
5. Accept a **config** object: `{ k, threshold, lexicalBoost: bool, queryVariant }`. Cache query embeddings by query string so config sweeps don't re-embed.
6. Write `eval/results/<timestamp>.json` and print a summary table.
- **Acceptance:** runs end-to-end on a hand-made toy labels file and prints per-intake + mean metrics. Negative-control intakes report how many sources exceed `threshold` (target: 0).

### M3 — Labeling UI
An internal page + a write API. **Before writing any Next.js page/route code, read the relevant guide under `node_modules/next/dist/docs/`** — this repo pins a modified Next.js whose conventions differ from upstream (see `AGENTS.md`). Do not assume App-Router-as-you-know-it.
- **Page** (e.g. `/eval/label?labeler=drboynton`): iterate intakes; per intake show the intake summary, then the sources from `sources.json` in **randomized order** (seed by intake id so a reload is stable), each with its one-line summary and a 0–3 selector defaulting to 0 and a `misleading` checkbox. **Never render similarity scores.** Show progress ("Assignment 3 of 9") and autosave.
- **API route** (Node runtime): `POST /api/eval/label` appends/updates `eval/labels/<labeler>.json`. Put storage behind a tiny interface (`saveLabels`/`loadLabels`) so the filesystem impl can be swapped for a hosted store later.
- **Labeler guidance** (show it in the UI): the relevance question from §3; rubric — **3** directly sparks a redesign idea for this assignment; **2** useful/on-target; **1** tangential; **0** off-topic/useless; `misleading` = would push the redesign in a *wrong* direction.
- **Acceptance:** a labeler can complete all intakes locally; refreshing resumes; the labels file matches §4.3. For remote use v1 assumes local/screen-share; hosted persistence is a follow-up.

### M4 — Real labeling + agreement
- Expert labels the full set; developer labels an **overlap subset** (e.g. the same ~5 intakes).
- `scripts/eval-agreement.ts`: over overlapping intakes, compute exact-agreement %, ±1-agreement %, and quadratic-weighted Cohen's kappa; list the sources with the most disagreement.
- **Acceptance:** prints agreement stats; if agreement is high, the developer's labels can extend coverage; if low, reconcile the rubric before trusting anything.

### M5 — Experiments
Using M2, sweep and record:
- **Threshold** (Max's point 2): add an optional min-cosine floor to a copy of the scoring path; sweep e.g. 0.0–0.5. Pick the value that keeps Recall high on on-corpus intakes while driving above-threshold sources to **0** on the negative controls.
- **k** (point 3): compare metrics (and eyeball output quality) at k = 3, 4, 5, 10.
- **Lexical boost:** on vs off — confirm it isn't overfitting retrieval to the habit/attention theme.
- **Query construction** (point 4): structured-fields query vs the current markdown-reparse query.
- **Acceptance:** a short results write-up with a recommended config (`k`, threshold, boost on/off, query source).

### M6 — Apply to production
- Implement the min-score threshold in `retrieve()` (`lib/knowledge.ts`) behind a param with the chosen default.
- Update route `k` values per M5.
- Fix redesign query construction to pass structured intake fields into `buildFocusedKnowledgeQuery` instead of reparsing markdown (point 4). (Retrieval logging on the redesign route — point 6 — is already present in the working tree.)
- **Acceptance:** routes use the recommended config; eval metrics on the labeled set are recorded before/after.

---

## 7. Metric definitions (document-level)

For an intake, let **Relevant** = sources whose label `score ≥ 2`. Let the **ranked source list** be sources ordered by their best chunk's score (§6.M2 step 3).

- **Recall@k** = |Relevant ∩ top-k sources| / |Relevant|. (Undefined when |Relevant| = 0 → exclude from the recall mean; negative controls have no relevant sources by design.)
- **Precision@k** = |Relevant ∩ top-k sources| / k.
- **MRR** = 1 / (rank of the first relevant source); 0 if none in the list.
- **nDCG@k** = DCG@k / IDCG@k, with gain = the graded label (`score`, 0–3) — or `2^score − 1` if you prefer sharper weighting; pick one and document it. IDCG uses the labels sorted descending.

Report per-intake and the mean across intakes. For **negative-control** intakes, the headline number is **above-threshold source count** (want 0) rather than recall.

---

## 8. Suggested file layout

```
eval/
  intakes.json
  sources.json
  labels/
    drboynton.json
    <dev>.json
  results/
    2026-07-30T....json
scripts/
  build-source-catalog.ts     # M1
  eval-retrieval.ts           # M2
  eval-agreement.ts           # M4
app/
  eval/label/…                # M3 page  (confirm routing against node_modules/next/dist/docs/)
  api/eval/label/…            # M3 write API (Node runtime)
lib/
  eval/metrics.ts             # shared metric fns + TS types for the artifacts
```

---

## 9. Relationship to the advisor's 7 points

1. **Eval set** → this whole plan (M1–M4).
2. **Min similarity threshold** → M5 + M6 (`retrieve()`).
3. **Reduce k** → M5 + M6.
4. **Clean up query construction** → M2 (eval uses structured fields) + M6 (redesign route).
5. **Vector store** → out of scope; fine at ~374 chunks.
6. **Redesign retrieval logging** → already done in the working tree; just verify it's committed.
7. **Systematic experiments** → M5 (the harness makes retrieval a pure function you can sweep).

---

## 10. Gotchas (read before coding)

- **Modified Next.js.** `AGENTS.md` / `CLAUDE.md`: this is not upstream Next. Read `node_modules/next/dist/docs/` for the routing/route-handler guide before writing the page or API route. Heed deprecation notices.
- **Never key labels on chunk `id`.** Use the `source` string. Store `index.builtAt` in the labels file and warn if the current index is newer (a rebuild may have changed the source set). If a source is renamed/removed, reconcile labels against `sources.json` rather than crashing.
- **Keep the embedding model in sync.** Embed queries with `index.model` (currently `text-embedding-3-small`), not a hardcoded model.
- **Don't go through the HTTP routes.** They swallow retrieval errors by design; call `retrieve()`/`buildFocusedKnowledgeQuery()` directly.
- **Chunk embeddings are already in the index** — only query embeddings need API calls. Cache them by query string across config sweeps to save cost/latency.
- **`lexicalBoost` is a tunable**, not a fixed part of "correct" retrieval — make sure the harness can turn it off and include it in experiments.
- **Negative controls are the point, not filler.** If the rote-math intakes retrieve confident sources, that's the exact failure the threshold is meant to fix; don't "fix" it by loosening the labels.
- **Storage for the labeling UI** writes local files in v1 (Node runtime API route). If Dr. Boynton must label remotely, either screen-share/run locally or implement a hosted storage adapter behind the `saveLabels` interface — don't hardcode `fs` calls all over the page.
```
