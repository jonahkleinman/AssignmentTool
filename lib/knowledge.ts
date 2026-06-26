/* ------------------------------------------------------------------ *
 *  Request-time retrieval over the assessment knowledge base.
 *
 *  Loads knowledge/index.json (built by scripts/build-knowledge.ts),
 *  embeds the teacher's query, and returns the most relevant source
 *  passages so /api/redesign can let them quietly inform its suggestions.
 *
 *  Degrades gracefully: if the index is missing, retrieve() returns []
 *  and the agent simply runs prompt-only, exactly as before.
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import OpenAI from "openai";

const INDEX_PATH = join(process.cwd(), "knowledge", "index.json");
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

export interface KnowledgeChunk {
  id: string;
  source: string;
  page: string;
  text: string;
  embedding: number[];
}

interface KnowledgeIndex {
  model: string;
  builtAt: string;
  count: number;
  chunks: KnowledgeChunk[];
}

let cached: KnowledgeIndex | null | undefined;

function loadIndex(): KnowledgeIndex | null {
  if (cached !== undefined) return cached;
  try {
    if (!existsSync(INDEX_PATH)) {
      cached = null;
      return cached;
    }
    cached = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as KnowledgeIndex;
  } catch {
    cached = null;
  }
  return cached;
}

export function knowledgeAvailable(): boolean {
  return loadIndex() !== null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RetrievedPassage {
  source: string;
  page: string;
  text: string;
  score: number;
}

/** Embeds `query` and returns the top-k most similar knowledge chunks. */
export async function retrieve(
  client: OpenAI,
  query: string,
  k = 5,
  signal?: AbortSignal,
): Promise<RetrievedPassage[]> {
  const index = loadIndex();
  if (!index || index.chunks.length === 0 || !query.trim()) return [];

  const res = await client.embeddings.create(
    { model: index.model ?? DEFAULT_EMBED_MODEL, input: query },
    { signal },
  );
  const queryEmbedding = res.data[0]?.embedding;
  if (!queryEmbedding) return [];

  return index.chunks
    .map((chunk) => ({
      source: chunk.source,
      page: chunk.page,
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Formats retrieved passages into background context the model interprets — never quotes or names. */
export function formatKnowledgeBlock(passages: RetrievedPassage[]): string {
  if (passages.length === 0) return "";
  const body = passages
    .map((p) => p.text)
    .join("\n\n---\n\n");

  return [
    "## Background thinking (for your reasoning only — never shown to the teacher)",
    "The notes below sketch the design thinking behind good assessment. They are raw source",
    "material, not a script. Absorb the underlying ideas and let them shape your redesigns,",
    "then express everything in your own plain classroom language.",
    "",
    "Hard rules:",
    "- Never quote these notes.",
    "- Never name, title, or cite a book, author, chapter, or page.",
    "- Never say things like \"per ...\", \"research shows\", or \"the literature says\".",
    "- The teacher should feel a thoughtful colleague's instinct, not a reading assignment.",
    "",
    body,
  ].join("\n");
}
