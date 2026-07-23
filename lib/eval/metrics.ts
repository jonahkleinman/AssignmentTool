import type { RelevanceLabel } from "./types";

export interface RankedSource {
  source: string;
  score: number;
  cosineScore: number;
}

export interface RetrievalMetrics {
  recallAtK: number | null;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  relevantCount: number;
  retrievedCount: number;
  aboveThresholdCount: number;
  misleadingAtK: number;
}

function gain(score: number): number {
  return 2 ** score - 1;
}

function dcg(scores: number[]): number {
  return scores.reduce((total, score, index) => total + gain(score) / Math.log2(index + 2), 0);
}

export function computeRetrievalMetrics(
  ranked: RankedSource[],
  labels: Record<string, RelevanceLabel>,
  k: number,
): RetrievalMetrics {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer.");
  const relevant = new Set(
    Object.entries(labels)
      .filter(([, label]) => label.score >= 2)
      .map(([source]) => source),
  );
  const top = ranked.slice(0, k);
  const hits = top.filter((item) => relevant.has(item.source)).length;
  const firstRelevant = ranked.findIndex((item) => relevant.has(item.source));
  const actualScores = top.map((item) => labels[item.source]?.score ?? 0);
  const idealScores = Object.values(labels)
    .map((label) => label.score)
    .sort((a, b) => b - a)
    .slice(0, k);
  const ideal = dcg(idealScores);

  return {
    recallAtK: relevant.size === 0 ? null : hits / relevant.size,
    precisionAtK: hits / k,
    mrr: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
    ndcgAtK: ideal === 0 ? 0 : dcg(actualScores) / ideal,
    relevantCount: relevant.size,
    retrievedCount: top.length,
    aboveThresholdCount: ranked.length,
    misleadingAtK: top.filter((item) => labels[item.source]?.misleading).length,
  };
}

export function mean(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0) / defined.length;
}
