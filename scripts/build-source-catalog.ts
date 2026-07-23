import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import "dotenv/config";
import OpenAI from "openai";

import { loadKnowledgeIndex } from "../lib/knowledge";
import { parseSourceCatalog, type SourceCatalogEntry } from "../lib/eval/types";

const OUTPUT_PATH = join(process.cwd(), "eval", "sources.json");
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL ?? "gpt-4o-mini";
const FORCE = process.argv.includes("--force");

function cleanSummary(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const matchingQuotes: Array<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
  ];
  const wrapper = matchingQuotes.find(
    ([open, close]) => compact.startsWith(open) && compact.endsWith(close),
  );
  return wrapper ? compact.slice(wrapper[0].length, -wrapper[1].length).trim() : compact;
}

async function summarizeSource(client: OpenAI, source: string, text: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Summarize the supplied source in one plain, factual sentence for a relevance-labeling interface. Name its central ideas and educational usefulness. Return only the sentence, with no title or citation.",
      },
      {
        role: "user",
        content: `Source title: ${source}\n\n${text.slice(0, 80_000)}`,
      },
    ],
  });
  const summary = cleanSummary(response.choices[0]?.message.content ?? "");
  if (!summary) throw new Error(`The summary model returned no text for ${source}.`);
  return summary;
}

async function main(): Promise<void> {
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");

  const previous = new Map<string, SourceCatalogEntry>();
  if (existsSync(OUTPUT_PATH)) {
    for (const entry of parseSourceCatalog(JSON.parse(readFileSync(OUTPUT_PATH, "utf8")))) {
      previous.set(entry.source, entry);
    }
  }

  const groups = new Map<string, string[]>();
  for (const chunk of index.chunks) {
    const chunks = groups.get(chunk.source) ?? [];
    chunks.push(chunk.text);
    groups.set(chunk.source, chunks);
  }

  const needsSummary = [...groups].some(([source, chunks]) => {
    const entry = previous.get(source);
    return FORCE || !entry || entry.chunkCount !== chunks.length;
  });
  if (needsSummary && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to summarize new or changed sources.");
  }

  const client = needsSummary ? new OpenAI() : null;
  const catalog: SourceCatalogEntry[] = [];
  for (const [source, chunks] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const old = previous.get(source);
    const unchanged = !FORCE && old?.chunkCount === chunks.length;
    const summary = unchanged
      ? old.summary
      : await summarizeSource(client!, source, chunks.join("\n\n---\n\n"));
    catalog.push({ source, chunkCount: chunks.length, summary });
    console.log(`${unchanged ? "reused" : "summarized"} · ${source}`);
  }

  const validated = parseSourceCatalog(catalog);
  if (validated.length !== groups.size) {
    throw new Error(`Catalog has ${validated.length} entries for ${groups.size} distinct sources.`);
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${validated.length} sources to ${OUTPUT_PATH}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
