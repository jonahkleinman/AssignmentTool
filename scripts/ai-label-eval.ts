import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import "dotenv/config";
import OpenAI from "openai";

import { reasoningModel } from "../lib/model";
import {
  isRelevanceScore,
  parseIntakes,
  parseSourceCatalog,
  type EvalIntake,
  type LabelsFile,
  type RelevanceLabel,
  type SourceCatalogEntry,
} from "../lib/eval/types";
import { loadKnowledgeIndex } from "../lib/knowledge";

const ROOT = process.cwd();

const PROMPTS = {
  "source-usefulness-v1": `You are an independent evaluator of source-document usefulness for assignment redesign.

Judge every source using only the assignment and source summary supplied. You do not know and must not infer the retrieval system's scores or ranking.

Use this rubric:
3 = directly supplies a strong, concrete redesign idea for this exact assignment.
2 = clearly useful and on-target; a concrete application to this assignment is identifiable.
1 = only generally educational, weakly transferable, or tangential; no clear concrete change follows.
0 = no useful contribution to redesigning this assignment.

Use "misleading" only when applying the source would probably push the redesign in a wrong direction, not merely when it is irrelevant. Do not force scores to vary, but do not award 2 or 3 merely because a source contains generally good educational advice. In each rationale, name the concrete connection or explain why none exists. Return one label for every source.`,
  "query-specific-v2": `You are an independent evaluator of which source documents should be retrieved to help redesign one specific assignment. The retrieval budget is scarce: only about 3–5 documents can ultimately surface. Judge query-specific usefulness, not whether a source contains good educational advice in general.

First make a binary decision: SHOULD RETRIEVE or SHOULD NOT RETRIEVE.
- SHOULD RETRIEVE only when the source contributes a distinctive concept, mechanism, or method that maps concretely to this assignment's stated student work, learning goal, or constraint.
- SHOULD NOT RETRIEVE when the connection is generic, requires inventing a substantially different activity, or would apply equally to almost any assignment.

Then encode that decision on this scale:
3 = exceptional fit; one of the strongest sources for this exact assignment and immediately yields a specific redesign.
2 = should retrieve; a distinctive source idea has a clear, concrete application to this exact assignment.
1 = should not retrieve; there is a plausible but generic, weak, or indirect transfer.
0 = should not retrieve; no defensible source-specific contribution.

Calibration rules:
- Default to 0 when the rationale would amount only to “this could improve engagement, creativity, reflection, assessment, or learning.”
- Broad assessment, tutoring, systems, workflow, or goal-setting advice is not relevant merely because the item is an assignment. It must address a specific need visible in this assignment.
- Subject-matter overlap alone is insufficient, but a tightly matched conceptual lens can be relevant when it changes how students engage the exact learning goal.
- A concrete-sounding activity invented by you does not make a generic source relevant. The useful mechanism must actually appear in the supplied summary.
- Scores 2 and 3 should be uncommon. Never use a quota and do not force variation, but most sources in a broad library will normally be 0 or 1 for a particular query.

You do not know and must not infer the retrieval system's scores or ranking. Use "misleading" only when applying a source would probably push the redesign in a wrong direction, not merely when irrelevant. In each rationale, state the source-specific mechanism and exact assignment connection, or state why that test fails. Return one label for every source.`,
  "query-specific-v3": `You are grading source-document relevance for a RAG retrieval benchmark. Human ground truth uses a narrow, query-specific standard. Your task is not to brainstorm how every source might conceivably help; it is to identify the few sources that deserve to displace other documents in a top-3-to-5 retrieval result.

For each source, silently apply all three gates:
1. SOURCE GATE: identify a specific concept or method actually stated in the summary.
2. QUERY GATE: connect that concept directly to the assignment's stated student work, learning goal, or explicit constraint.
3. SELECTIVITY GATE: ask whether the connection is substantially more useful here than generic advice applicable to most assignments.

Score only after applying the gates:
3 = passes all gates exceptionally; immediate and unusually strong redesign value for this exact assignment.
2 = passes all gates; this document should be retrieved for the assignment.
1 = has a real but indirect or broadly transferable connection; do not retrieve it in a limited top-k.
0 = fails the source or query gate; no useful contribution for this assignment.

Important calibration:
- “This could inspire engagement/creativity/reflection” is not enough for 2.
- A document about AI tutoring is 2+ only when document-grounded tutoring directly serves a stated task or goal.
- A document about organizational systems, constraints, leverage points, or goals is 2+ only when the assignment exposes a matching process bottleneck or goal misalignment.
- A general assessment-redesign document is not automatically relevant to every assessment; require a specific method in its summary that answers a visible need.
- A conceptual lens may qualify when it directly changes the intellectual work students must do, even without subject-matter overlap.
- If you have to invent most of the redesign yourself to explain the connection, assign 0 or 1.
- Use 0 freely. Scores 2 and 3 should be rare and discriminative, although there is no quota.

You do not know and must not infer retrieval scores or rankings. "Misleading" means likely to push the redesign in a wrong direction, not merely irrelevant. Make each rationale identify which gates passed or failed. Return exactly one label for every source.`,
  "query-specific-v4": `You are an independent evaluator of which source documents should be retrieved to help redesign one specific assignment. The retrieval budget is scarce: only about 3–5 documents can ultimately surface. Judge query-specific usefulness for redesign, not topical similarity and not whether a source contains good educational advice in general.

First make a binary decision: SHOULD RETRIEVE or SHOULD NOT RETRIEVE.
- SHOULD RETRIEVE only when the source contributes a distinctive concept, pedagogical mechanism, or redesign method that maps concretely to this assignment's stated student work, learning goal, or constraint.
- SHOULD NOT RETRIEVE when the connection is generic, merely shares the assignment's topic, requires inventing a substantially different activity, or would apply equally to almost any assignment.

Then encode that decision:
3 = exceptional fit; one of the strongest sources for this exact assignment and immediately yields a specific redesign.
2 = should retrieve; a distinctive source idea has a clear, concrete application to this exact assignment.
1 = should not retrieve; a plausible but generic, weak, or indirect transfer.
0 = should not retrieve; no defensible source-specific contribution.

Calibration examples that define the standard:
- A source about building a document-grounded AI tutor is 0 unless tutoring, practice, feedback, or interaction with source documents directly addresses a stated need. The mere possibility of adding a tutor is not relevance.
- A chapter that shares an ethics or literature topic is still 0 if it supplies subject-matter background but no way to redesign how students demonstrate the learning goal.
- A creativity method can be 2 when its actual mechanism—such as defamiliarization, changing routine, subtraction, or division—directly changes how students perform the stated intellectual task. It may be 3 when that mechanism is central and immediately actionable.
- General organizational advice about systems, constraints, leverage points, or goals is 0 unless the assignment description exposes a matching workflow bottleneck, structural constraint, or goal misalignment. Do not invent one.
- General deeper-learning philosophy is usually 0 or 1. A specific pedagogy such as inquiry, autonomy, apprenticeship, collaboration, or critique can be 2 when that mechanism directly fits the assigned student work.
- A broad menu of alternative assessment formats is not automatically relevant to every assessment. Use 2 only when a method named in the summary directly resolves a visible need; otherwise use 0 or 1.

Default to 0 when the rationale would amount only to “this could improve engagement, creativity, reflection, assessment, or learning.” A concrete-sounding activity invented by you does not make a generic source relevant. Scores 2 and 3 should be uncommon. Never use a quota and do not force variation, but most sources in a broad library will normally be 0 or 1 for a particular query.

You do not know and must not infer retrieval scores or rankings. Use "misleading" only when applying a source would probably push the redesign in a wrong direction, not merely when irrelevant. In each rationale, state the source-specific redesign mechanism and exact assignment connection, or state why that test fails. Return one label for every source.`,
  "query-specific-v5": `You are calibrating a RAG relevance judge to independently produced human labels. Decide which source documents should occupy scarce top-3-to-5 retrieval slots for redesigning one exact assignment. Judge query-specific redesign usefulness—not topical similarity, not general educational merit, and not whether you can invent a hypothetical use.

The source summaries were generated to describe educational usefulness and often end with promotional phrases such as “valuable resource,” “fosters deeper learning,” or “can improve decision-making.” Ignore those generic claims. Judge only the substantive concept or method described.

Apply this rubric:
3 = exceptional fit; the source's own distinctive method immediately produces a strong redesign serving the stated student work or learning goal.
2 = retrieve; a distinctive method or conceptual lens from the source has a clear, specific application to the exact assignment.
1 = do not retrieve in a limited top-k; a real but indirect, generic, or weak transfer exists.
0 = do not retrieve; no source-specific redesign contribution is established.

Human-calibration examples:
- A conventional essay, case analysis, program, lab, or test paired with a document-grounded AI-tutor guide is 0 unless tutoring, practice, feedback, or document interaction is an explicit need. Do not invent a tutor merely because one is possible.
- A general assessment-redesign source is 0 or 1 when no problem with the assessment format is stated. It becomes 2 only when a particular method in the summary resolves a visible need.
- General organizational systems, constraints, leverage-point, workflow, or goal-setting sources are 0 unless the assignment exposes the matching operational problem. Do not reinterpret every assignment component as a “system.”
- A topical chapter about ethics, discrimination, lying, literature, science, or technology is 0 if it adds subject-matter content but no way to redesign how students perform or demonstrate the learning goal.
- A creativity mechanism such as defamiliarization, changing routine, subtraction, or division can be 2 when that actual mechanism changes students' intellectual work; it can be 3 when exceptionally direct. Merely praising creativity is at most 1.
- General deeper-learning philosophy is usually 0. A specific pedagogy such as inquiry, autonomy, apprenticeship, collaboration, or critique can be 2 when it directly matches the student work.

For every proposed 2 or 3, complete this sentence using only supplied facts: “This source should displace another document because its [named mechanism] directly helps these students [perform a stated task or goal] by [specific change].” If any blank requires an invented need or activity, lower the score to 0 or 1.

Use 0 freely; most library documents should be 0 for a particular query. Scores 2 and 3 should be rare and discriminative, without imposing a quota. You do not know and must not infer retrieval scores or rankings. “Misleading” means likely to push redesign in a wrong direction, not merely irrelevant. Return exactly one label for every source and make each rationale justify the assigned score under this standard.`,
} as const;

type PromptVersion = keyof typeof PROMPTS;

interface AiJudgment extends RelevanceLabel {
  source: string;
  rationale: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedIntakes(intakes: EvalIntake[]): EvalIntake[] {
  const raw = argument("intakes");
  if (!raw) return intakes;
  const requested = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = intakes.filter((intake) => requested.delete(intake.id));
  if (requested.size) throw new Error(`Unknown intake ids: ${[...requested].join(", ")}.`);
  if (!selected.length) throw new Error("--intakes did not select any intakes.");
  return selected;
}

function requestedPrompt(): PromptVersion {
  const value = argument("prompt") ?? "source-usefulness-v1";
  if (!(value in PROMPTS)) {
    throw new Error(`--prompt must be one of: ${Object.keys(PROMPTS).join(", ")}.`);
  }
  return value as PromptVersion;
}

function responseSchema(sources: SourceCatalogEntry[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      labels: {
        type: "array",
        minItems: sources.length,
        maxItems: sources.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string", enum: sources.map(({ source }) => source) },
            score: { type: "integer", enum: [0, 1, 2, 3] },
            misleading: { type: "boolean" },
            rationale: { type: "string" },
          },
          required: ["source", "score", "misleading", "rationale"],
        },
      },
    },
    required: ["labels"],
  } as const;
}

function userPrompt(intake: EvalIntake, sources: SourceCatalogEntry[]): string {
  const sourceList = sources
    .map(({ source, summary }) => `SOURCE: ${source}\nSUMMARY: ${summary}`)
    .join("\n\n");
  return `ASSIGNMENT
Grade: ${intake.grade}
Type: ${intake.assessment}
What students do: ${intake.parts}
Learning goal: ${intake.goal}
Time: ${intake.time}
${intake.sourceDoc ? `Original assignment excerpt: ${intake.sourceDoc}` : ""}

SOURCES TO JUDGE
${sourceList}`;
}

function validateJudgments(value: unknown, sources: SourceCatalogEntry[]): AiJudgment[] {
  if (typeof value !== "object" || value === null || !("labels" in value)) {
    throw new Error("The judge response has no labels array.");
  }
  const labels = (value as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) throw new Error("The judge response labels value is not an array.");
  const expected = new Set(sources.map(({ source }) => source));
  const result = labels.map((item, index): AiJudgment => {
    if (typeof item !== "object" || item === null) throw new Error(`Label ${index} is invalid.`);
    const label = item as Record<string, unknown>;
    if (typeof label.source !== "string" || !expected.delete(label.source)) {
      throw new Error(`Label ${index} has a duplicate or unknown source.`);
    }
    if (!isRelevanceScore(label.score)) throw new Error(`Label ${index} has an invalid score.`);
    if (typeof label.misleading !== "boolean") {
      throw new Error(`Label ${index} has an invalid misleading flag.`);
    }
    if (typeof label.rationale !== "string" || !label.rationale.trim()) {
      throw new Error(`Label ${index} has no rationale.`);
    }
    return {
      source: label.source,
      score: label.score,
      misleading: label.misleading,
      rationale: label.rationale.trim(),
    };
  });
  if (expected.size) throw new Error(`The judge omitted sources: ${[...expected].join(", ")}.`);
  return result;
}

async function judgeIntake(
  client: OpenAI,
  intake: EvalIntake,
  sources: SourceCatalogEntry[],
  promptVersion: PromptVersion,
): Promise<AiJudgment[]> {
  const completion = await client.chat.completions.create({
    ...reasoningModel(),
    messages: [
      {
        role: "system",
        content: PROMPTS[promptVersion],
      },
      { role: "user", content: userPrompt(intake, sources) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "source_relevance_labels",
        strict: true,
        schema: responseSchema(sources),
      },
    },
    max_completion_tokens: 12_000,
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error(`The judge returned no content for ${intake.id}.`);
  return validateJudgments(JSON.parse(content), sources);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  const index = loadKnowledgeIndex();
  if (!index) throw new Error("knowledge/index.json is missing or invalid.");
  const intakes = requestedIntakes(
    parseIntakes(JSON.parse(readFileSync(join(ROOT, "eval", "intakes.json"), "utf8"))),
  );
  const sources = parseSourceCatalog(
    JSON.parse(readFileSync(join(ROOT, "eval", "sources.json"), "utf8")),
  );
  const promptVersion = requestedPrompt();
  const labelsPath = resolve(ROOT, argument("output") ?? "eval/labels/ai.json");
  const auditPath = resolve(ROOT, argument("audit") ?? "eval/ai/ai-labels.audit.json");
  const client = new OpenAI();
  const judgments: Record<string, AiJudgment[]> = {};

  for (const [index, intake] of intakes.entries()) {
    process.stdout.write(`Judging ${index + 1}/${intakes.length}: ${intake.id}... `);
    judgments[intake.id] = await judgeIntake(client, intake, sources, promptVersion);
    console.log("done");
  }

  const generatedAt = new Date().toISOString();
  const labels: LabelsFile = {
    labeler: `ai-${promptVersion}`,
    labeledAt: generatedAt,
    corpusBuiltAt: index.builtAt,
    labels: Object.fromEntries(
      intakes.map((intake) => [
        intake.id,
        Object.fromEntries(
          judgments[intake.id].map(({ source, score, misleading }) => [
            source,
            { score, misleading },
          ]),
        ),
      ]),
    ),
  };
  const audit = {
    generatedAt,
    corpusBuiltAt: index.builtAt,
    model: reasoningModel(),
    promptVersion,
    inputs: "assignment fields plus source-catalog summaries; no retrieval scores or ranks",
    judgments,
  };

  mkdirSync(dirname(labelsPath), { recursive: true });
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(labelsPath, `${JSON.stringify(labels, null, 2)}\n`, "utf8");
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(`Wrote ${labelsPath}.`);
  console.log(`Wrote ${auditPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
