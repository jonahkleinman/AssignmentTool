# Knowledge base

The teacher's reference library, turned into a searchable index that grounds the
agent's redesign suggestions in `/api/redesign`.

## Layout

| Path | Committed? | What it is |
| --- | --- | --- |
| `source/` | no | Drop the PDFs here. Many are copyrighted books, so they stay local. |
| `text/` | no | Cached extracted/OCR'd text, one `.txt` per PDF. Safe to delete. |
| `index.json` | no | The built embedding index that the app reads at request time. |

Everything except this README is git-ignored — the corpus and its derivatives
never leave your machine. Only chunk text is sent to the embeddings API at build
time, and only the top matches are sent to the chat model at request time.

## Building / rebuilding

```bash
npm run build:knowledge              # extract → chunk → embed → index.json
npm run build:knowledge -- --force-ocr   # re-OCR everything from scratch
```

Requires `OPENAI_API_KEY` in `.env.local`.

- **Text PDFs** are read directly via `unpdf`.
- **Scanned PDFs** (no text layer) are OCR'd on-device with Apple's Vision
  framework via `scripts/ocr.swift` (compiled to `.cache/ocr` on first run).
  This needs macOS + `swiftc`.

Add or remove PDFs in `source/`, then re-run. Extracted text is cached in
`text/`, so re-runs only embed; pass `--force-ocr` to redo OCR.
