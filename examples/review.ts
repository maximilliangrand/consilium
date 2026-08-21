/**
 * Example: a self-verifying code review.
 *
 * The shape is the whole point of the framework:
 *   fan out reviewers across dimensions  ->  adversarially refute each finding
 *   ->  keep only the findings that survive.
 *
 * It runs as-is against a MOCK runner (no API key, deterministic). To use a real
 * model, swap `mockRunner` for the `anthropicRunner` sketch at the bottom.
 *
 *   npx tsx examples/review.ts
 */
import { Consilium, schema, type Runner, type Schema } from "../src/index.js";

interface Finding {
  title: string;
  file: string;
  severity: "high" | "medium" | "low";
}

const FindingsSchema: Schema<{ findings: Finding[] }> = schema(
  "Findings",
  (raw) => raw as { findings: Finding[] },
  {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "file", "severity"],
          properties: {
            title: { type: "string" },
            file: { type: "string" },
            severity: { enum: ["high", "medium", "low"] },
          },
        },
      },
    },
  },
);

// ---- a deterministic mock model so the example runs with no API key ----------
const mockRunner: Runner = async (req) => {
  if (req.label?.startsWith("review:")) {
    const dim = req.label.split(":")[1];
    return {
      findings: [
        { title: `${dim}: real off-by-one in the retry loop`, file: "src/retry.ts", severity: "high" },
        { title: `${dim}: hallucinated race that cannot happen`, file: "src/x.ts", severity: "medium" },
      ],
    };
  }
  if (req.label?.startsWith("refute:")) {
    // Skeptics refute anything whose title says "hallucinated".
    const refuted = /hallucinated/.test(req.prompt);
    return { refuted };
  }
  return "ok";
};

async function main(): Promise<void> {
  const council = new Consilium({ runner: mockRunner, concurrency: 6 });

  const dimensions = ["correctness", "security", "performance"];

  // Fan out a reviewer per dimension, then run each finding straight into an
  // adversarial refutation, with no barrier between the two stages.
  const perDimension = await council.pipeline<Finding[]>(
    dimensions,
    (dim) =>
      council
        .agent({ label: `review:${dim}`, prompt: `Review the diff for ${dim} issues.`, schema: FindingsSchema })
        .then((r) => r.findings),
    async (findings) => {
      const checked = await council.parallel(
        (findings as Finding[]).map((f) => async () => {
          const verdict = await council.refute({
            claim: `This is a real bug: ${f.title}`,
            context: f,
            voters: 3,
            threshold: "majority",
          });
          return verdict.survives ? f : null;
        }),
      );
      return checked.flat().filter((f): f is Finding => f != null);
    },
  );

  const confirmed = perDimension.flat().filter((f): f is Finding => f != null);

  console.log(`\nConfirmed findings (survived adversarial verification):`);
  for (const f of confirmed) console.log(`  [${f.severity}] ${f.file}  ${f.title}`);
  console.log(`\n${confirmed.length} confirmed. Model calls: ${council.usage().calls}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/*
// ---- a real model runner (Anthropic) ----------------------------------------
// npm i @anthropic-ai/sdk
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();

export const anthropicRunner: Runner = async (req) => {
  const res = await client.messages.create({
    model: req.model ?? "claude-sonnet-5",
    max_tokens: 4096,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
    // When a jsonSchema is present, force a tool call so output is structured:
    ...(req.jsonSchema
      ? {
          tools: [{ name: "out", description: "structured output", input_schema: req.jsonSchema as object }],
          tool_choice: { type: "tool", name: "out" },
        }
      : {}),
  });
  req.report?.({ inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  const block = res.content.find((b) => b.type === "tool_use");
  return block ? (block as { input: unknown }).input : res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};
*/
