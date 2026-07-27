import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "dotenv";

config({ path: ".env.local" });
config();

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const { loadLabels, normalizeLabeler } = await import("../lib/eval/storage");
  const labeler = normalizeLabeler(argument("labeler"), "");
  if (!labeler) {
    throw new Error("Usage: npm run eval:export-labels -- --labeler=jonah [--output=eval/labels/jonah.json]");
  }
  const labels = await loadLabels(labeler);
  if (!labels) throw new Error(`No stored labels found for ${labeler}.`);
  const output = resolve(process.cwd(), argument("output") ?? `eval/labels/${labeler}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(labels, null, 2)}\n`, "utf8");
  console.log(`Exported ${labeler} labels to ${output}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
