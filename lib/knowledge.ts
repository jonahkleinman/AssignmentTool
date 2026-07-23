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

export interface KnowledgeIndex {
  model: string;
  builtAt: string;
  count: number;
  chunks: KnowledgeChunk[];
}

let cached: KnowledgeIndex | null | undefined;

export function loadKnowledgeIndex(): KnowledgeIndex | null {
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
  return loadKnowledgeIndex() !== null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

export function knowledgeLexicalBoost(query: string, chunk: KnowledgeChunk): number {
  const q = query.toLowerCase();
  if (!/(habit|autopilot|stale|routine|familiar|(?:dis)?habituat)/.test(q)) return 0;

  const haystack = `${chunk.source}\n${chunk.text}`.toLowerCase();
  let boost = 0;
  if (/(?:dis)?habituat/.test(haystack)) boost += 0.08;
  if (/\bhabit|autopilot|familiar|surprise|attention|status quo/.test(haystack)) {
    boost += 0.025;
  }
  return boost;
}

export interface RetrievedPassage {
  source: string;
  page: string;
  text: string;
  score: number;
}

export interface ScoredKnowledgeChunk extends RetrievedPassage {
  id: string;
  cosineScore: number;
  lexicalBoost: number;
}

export interface FocusedKnowledgeQueryInput {
  assignmentType?: string;
  parts?: string;
  goal?: string;
  time?: string;
  purpose?: string;
  constraints?: string[];
  habits?: string[];
  sourceDoc?: string;
  raw?: string;
}

function compact(value: string | undefined, max = 700): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactList(values: string[] | undefined, maxItems = 6): string {
  return (values ?? [])
    .map((value) => compact(value, 240))
    .filter(Boolean)
    .slice(0, maxItems)
    .join("; ");
}

/**
 * Builds a retrieval query from the pedagogically useful parts of an intake.
 * This keeps embeddings focused on habits, attention, and live constraints
 * instead of diluting the query with a full assignment handout.
 */
export function buildFocusedKnowledgeQuery(input: FocusedKnowledgeQueryInput): string {
  const lines = [
    "assessment redesign constraints habits autopilot attention stale familiar routines novelty habituation dishabituation dishabituate",
    input.assignmentType ? `Assignment type: ${compact(input.assignmentType, 220)}` : "",
    input.parts ? `Current task: ${compact(input.parts)}` : "",
    input.goal ? `Learning goal: ${compact(input.goal, 320)}` : "",
    input.time ? `Time budget: ${compact(input.time, 180)}` : "",
    input.purpose ? `Purpose: ${compact(input.purpose, 320)}` : "",
    input.constraints?.length ? `Constraints: ${compactList(input.constraints)}` : "",
    input.habits?.length ? `Student habits: ${compactList(input.habits)}` : "",
    input.sourceDoc ? `Source excerpt: ${compact(input.sourceDoc, 900)}` : "",
    input.raw ? `Teacher context: ${compact(input.raw, 900)}` : "",
  ];

  return lines.filter(Boolean).join("\n");
}

export function scoreKnowledgeChunks(
  index: KnowledgeIndex,
  query: string,
  queryEmbedding: number[],
  useLexicalBoost = true,
): ScoredKnowledgeChunk[] {
  return index.chunks
    .map((chunk) => {
      const cosineScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const boost = useLexicalBoost ? knowledgeLexicalBoost(query, chunk) : 0;
      return {
        id: chunk.id,
        source: chunk.source,
        page: chunk.page,
        text: chunk.text,
        cosineScore,
        lexicalBoost: boost,
        score: cosineScore + boost,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Embeds `query` and returns the top-k most similar knowledge chunks. */
export async function retrieve(
  client: OpenAI,
  query: string,
  k = 5,
  signal?: AbortSignal,
): Promise<RetrievedPassage[]> {
  const index = loadKnowledgeIndex();
  if (!index || index.chunks.length === 0 || !query.trim()) return [];

  const res = await client.embeddings.create(
    { model: index.model ?? DEFAULT_EMBED_MODEL, input: query },
    { signal },
  );
  const queryEmbedding = res.data[0]?.embedding;
  if (!queryEmbedding) return [];

  return scoreKnowledgeChunks(index, query, queryEmbedding)
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
