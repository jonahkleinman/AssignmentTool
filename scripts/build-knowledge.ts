/* ------------------------------------------------------------------ *
 *  Offline build step for the assessment knowledge base.
 *
 *  Pipeline:  PDF  ->  text (unpdf, or Apple-Vision OCR for scans)
 *                  ->  page-aware chunks
 *                  ->  OpenAI embeddings
 *                  ->  knowledge/index.json  (loaded at request time)
 *
 *  Run with:  npm run build:knowledge        (re-uses cached OCR text)
 *             npm run build:knowledge -- --force-ocr   (re-OCR everything)
 *
 *  Everything runs locally; only chunk text is sent to the embeddings API.
 * ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import "dotenv/config";
import OpenAI from "openai";
import { extractText, getDocumentProxy } from "unpdf";

const ROOT = process.cwd();
const SOURCE_DIR = join(ROOT, "knowledge", "source");
const TEXT_DIR = join(ROOT, "knowledge", "text");
const INDEX_PATH = join(ROOT, "knowledge", "index.json");
const OCR_BIN = join(ROOT, ".cache", "ocr");
const OCR_SRC = join(ROOT, "scripts", "ocr.swift");

const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const MIN_CHARS_PER_PAGE = 100; // below this, treat a PDF as scanned and OCR it
const MAX_CHUNK_CHARS = 3000; // ~700 tokens
const OVERLAP_CHARS = 400;
const FORCE_OCR = process.argv.includes("--force-ocr");

const PAGE_BREAK = "\f";

interface Chunk {
  id: string;
  source: string;
  page: string; // "p. 12" or "pp. 12–14"
  text: string;
  embedding: number[];
}

/** "Copy of Look Again - 10. Progress.pdf" -> "Look Again — 10. Progress" */
function titleFor(file: string): string {
  return basename(file, ".pdf")
    .replace(/^Copy of\s+/i, "")
    .replace(/\s*-\s*/g, " — ")
    .trim();
}

function slugFor(file: string): string {
  return basename(file, ".pdf").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function ensureOcrBinary(): void {
  if (existsSync(OCR_BIN)) return;
  console.log("· compiling Apple Vision OCR helper…");
  mkdirSync(join(ROOT, ".cache"), { recursive: true });
  execFileSync("swiftc", ["-O", OCR_SRC, "-o", OCR_BIN], { stdio: "inherit" });
}

async function textForPdf(file: string): Promise<string> {
  const fullPath = join(SOURCE_DIR, file);
  const cachePath = join(TEXT_DIR, `${slugFor(file)}.txt`);

  if (!FORCE_OCR && existsSync(cachePath)) {
    return readFileSync(cachePath, "utf8");
  }

  // First try the embedded text layer.
  const buf = new Uint8Array(readFileSync(fullPath));
  const pdf = await getDocumentProxy(buf);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const charCount = pages.join("").replace(/\s+/g, "").length;

  let result: string;
  if (charCount / Math.max(totalPages, 1) >= MIN_CHARS_PER_PAGE) {
    console.log(`  text layer  (${totalPages}pp)`);
    result = pages.join(PAGE_BREAK);
  } else {
    console.log(`  scanned → Apple Vision OCR (${totalPages}pp)…`);
    ensureOcrBinary();
    result = execFileSync(OCR_BIN, [fullPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  mkdirSync(TEXT_DIR, { recursive: true });
  writeFileSync(cachePath, result, "utf8");
  return result;
}

function pageLabel(start: number, end: number): string {
  return start === end ? `p. ${start}` : `pp. ${start}–${end}`;
}

/** Page-aware greedy chunking with a small overlap, so citations keep page numbers. */
function chunkDocument(rawText: string, source: string): Omit<Chunk, "embedding">[] {
  const pages = rawText.split(PAGE_BREAK);
  const chunks: Omit<Chunk, "embedding">[] = [];

  let buffer = "";
  let startPage = 1;
  let currentPage = 1;
  let index = 0;

  const flush = (endPage: number) => {
    const text = buffer.trim();
    if (text.length < 40) return; // skip near-empty fragments
    chunks.push({
      id: `${slugFor(source)}-${index++}`,
      source,
      page: pageLabel(startPage, endPage),
      text,
    });
  };

  pages.forEach((rawPage, pageIdx) => {
    currentPage = pageIdx + 1;
    const paragraphs = rawPage
      .split(/\n{2,}|\r\n{2,}/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const para of paragraphs) {
      if (buffer && buffer.length + para.length + 1 > MAX_CHUNK_CHARS) {
        flush(currentPage);
        buffer = buffer.slice(-OVERLAP_CHARS);
        startPage = currentPage;
      }
      buffer += (buffer ? " " : "") + para;
    }
  });
  flush(currentPage);

  return chunks;
}

async function embedAll(client: OpenAI, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const BATCH = 96;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await client.embeddings.create({ model: EMBED_MODEL, input: slice });
    for (const item of res.data) out.push(item.embedding);
    console.log(`  embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  return out;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env.local.");
  }
  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`No knowledge/source folder. Drop PDFs into ${SOURCE_DIR}.`);
  }

  const files = readdirSync(SOURCE_DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (files.length === 0) throw new Error("No PDFs found in knowledge/source.");

  console.log(`Found ${files.length} PDFs.\n`);

  const pending: Omit<Chunk, "embedding">[] = [];
  for (const file of files) {
    console.log(titleFor(file));
    const text = await textForPdf(file);
    const docChunks = chunkDocument(text, titleFor(file));
    console.log(`  → ${docChunks.length} chunks\n`);
    pending.push(...docChunks);
  }

  console.log(`\nEmbedding ${pending.length} chunks with ${EMBED_MODEL}…`);
  const client = new OpenAI();
  const embeddings = await embedAll(client, pending.map((c) => c.text));

  const chunks: Chunk[] = pending.map((c, i) => ({ ...c, embedding: embeddings[i] }));
  const index = {
    model: EMBED_MODEL,
    builtAt: new Date().toISOString(),
    count: chunks.length,
    chunks,
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index));
  console.log(`\n✓ Wrote ${chunks.length} chunks → ${INDEX_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
