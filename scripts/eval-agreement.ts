import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { computeAgreement } from "../lib/eval/agreement";
import {
  parseIntakes,
  parseLabelsFile,
  parseSourceCatalog,
  reconcileLabels,
  type RelevanceScore,
} from "../lib/eval/types";
import { loadKnowledgeIndex } from "../lib/knowledge";

const ROOT = process.cwd();

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function selectIntakes<T extends { id: string }>(intakes: T[]): T[] {
  const raw = argument("intakes");
  if (!raw) return intakes;
  const requested = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = intakes.filter((intake) => requested.delete(intake.id));
  if (requested.size) throw new Error(`Unknown intake ids: ${[...requested].join(", ")}.`);
  if (!selected.length) throw new Error("--intakes did not select any intakes.");
  return selected;
}

function main(): void {
  const firstPath = argument("a");
  const secondPath = argument("b");
  if (!firstPath || !secondPath) {
    throw new Error("Usage: npm run eval:agreement -- --a=eval/labels/expert.json --b=eval/labels/dev.json");
  }
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");
  const allIntakes = parseIntakes(
    JSON.parse(readFileSync(join(ROOT, "eval", "intakes.json"), "utf8")),
  );
  const intakes = selectIntakes(allIntakes);
  const sources = parseSourceCatalog(
    JSON.parse(readFileSync(join(ROOT, "eval", "sources.json"), "utf8")),
  );
  const firstRaw = parseLabelsFile(
    JSON.parse(readFileSync(resolve(ROOT, firstPath), "utf8")),
  );
  const secondRaw = parseLabelsFile(
    JSON.parse(readFileSync(resolve(ROOT, secondPath), "utf8")),
  );
  const overlap = intakes.filter(
    (intake) => intake.id in firstRaw.labels && intake.id in secondRaw.labels,
  );
  if (overlap.length === 0) throw new Error("The label files have no overlapping intakes.");
  const first = reconcileLabels(firstRaw, firstRaw.labeler, index.builtAt, allIntakes, sources);
  const second = reconcileLabels(secondRaw, secondRaw.labeler, index.builtAt, allIntakes, sources);
  for (const file of [firstRaw, secondRaw]) {
    if (file.corpusBuiltAt !== index.builtAt) {
      console.warn(
        `Warning: ${file.labeler}'s labels use corpus ${file.corpusBuiltAt}; current corpus is ${index.builtAt}.`,
      );
    }
  }

  const pairs: Array<readonly [RelevanceScore, RelevanceScore]> = [];
  const disagreements: Array<{
    intake: string;
    source: string;
    first: RelevanceScore;
    second: RelevanceScore;
    difference: number;
  }> = [];
  let misleadingDisagreements = 0;
  const bySource = new Map<string, { totalDifference: number; disagreements: number; ratings: number }>();

  for (const intake of overlap) {
    for (const { source } of sources) {
      const firstLabel = first.labels[intake.id][source];
      const secondLabel = second.labels[intake.id][source];
      pairs.push([firstLabel.score, secondLabel.score]);
      const difference = Math.abs(firstLabel.score - secondLabel.score);
      const aggregate = bySource.get(source) ?? {
        totalDifference: 0,
        disagreements: 0,
        ratings: 0,
      };
      aggregate.totalDifference += difference;
      aggregate.ratings += 1;
      if (difference > 0) aggregate.disagreements += 1;
      bySource.set(source, aggregate);
      if (difference > 0) {
        disagreements.push({
          intake: intake.id,
          source,
          first: firstLabel.score,
          second: secondLabel.score,
          difference,
        });
      }
      if (firstLabel.misleading !== secondLabel.misleading) misleadingDisagreements += 1;
    }
  }

  const stats = computeAgreement(pairs);
  console.log(`\n${first.labeler} (${basename(firstPath)}) vs ${second.labeler} (${basename(secondPath)})`);
  console.log(`${overlap.length} overlapping intakes · ${stats.count} paired source ratings`);
  console.log(`Exact agreement: ${percent(stats.exactAgreement)}`);
  console.log(`Within ±1: ${percent(stats.withinOneAgreement)}`);
  console.log(`Quadratic-weighted Cohen's kappa: ${stats.quadraticWeightedKappa.toFixed(3)}`);
  console.log(`Misleading-flag disagreements: ${misleadingDisagreements}`);

  console.log("\nSources with the most disagreement:");
  console.table(
    [...bySource]
      .map(([source, value]) => ({
        source,
        disagreements: value.disagreements,
        meanAbsoluteDifference: (value.totalDifference / value.ratings).toFixed(2),
      }))
      .filter((item) => item.disagreements > 0)
      .sort(
        (a, b) =>
          b.disagreements - a.disagreements ||
          Number(b.meanAbsoluteDifference) - Number(a.meanAbsoluteDifference),
      )
      .slice(0, 10),
  );

  if (disagreements.length) {
    console.log("\nLargest individual disagreements:");
    console.table(
      disagreements
        .sort((a, b) => b.difference - a.difference || a.source.localeCompare(b.source))
        .slice(0, 20),
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
