# consilium

**Typed, model-agnostic orchestration for LLM agent councils.**

Model calls can be wrong. A structured process can help evaluate them: fan out independent hypotheses, adversarially refute each one, converge on the survivors. `consilium` makes that process a few lines of typed, deterministic, model-agnostic code.

The orchestration is ordinary code you can step through. The model is the only stochastic part, so every pattern here is unit-testable with a mock, no API key required.

```
npm install consilium
```

## The idea in one screen

```ts
import { Consilium } from "consilium";

const council = new Consilium({ runner: myModel, concurrency: 8 });

// Supply a Runner implementation; see "Bring your own model" below.
const verdicts = await council.fanout(
  ["Every retry is counted toward the call budget", "Queued calls recheck the budget"],
  (claim) => council.refute({ claim, voters: 3 }),
);
// Failed items are null; surviving claims still need task-specific validation.
const survivingClaims = verdicts.flatMap((v) => v?.survives ? [v.claim] : []);
```

Each finding gets three separately invoked skeptics trying to refute it. Surviving this vote is a workflow result, not proof that a finding is correct; models can share the same mistakes.

## Primitives

Every primitive is deterministic control flow around your `runner`. Concurrency, retries, schema validation and budget are handled once, for all of them.

| Primitive | What it does |
| --- | --- |
| `agent(req)` | One call: concurrency-capped, retried, schema-validated, budgeted. |
| `fanout(items, fn)` | Map items to concurrent work. A failure becomes `null`. |
| `parallel(thunks)` | Run thunks concurrently and wait for all. A thrown thunk becomes `null`. |
| `pipeline(items, ...stages)` | Push every item through all stages independently, **no barrier** between stages. |
| `refute({ claim, voters, threshold })` | Adversarial verification: N skeptics try to refute; survives if fewer than the threshold do. |
| `panel({ item, lenses, judge })` | Judge one item from several distinct perspectives at once. |
| `loopUntilDry({ round, key, dryRounds })` | Keep discovering until K consecutive rounds find nothing new. |

### refute: kill the plausible-but-wrong

```ts
const verdict = await council.refute({
  claim: "startOf('day') is timezone-safe here",
  context: theCode,
  voters: 3,
  threshold: "majority", // "any" | "all" | number also work
});
if (!verdict.survives) drop(finding); // a majority of skeptics broke it
```

Each voter is prompted to *refute*, not to agree, and defaults to `refuted` when unsure. Whether this improves accuracy depends on the model, prompts, and task and requires evaluation on real examples.

### panel: score through several lenses

```ts
const scored = await council.panel({
  item: candidate,
  lenses: ["correctness", "security", "simplicity"],
  judge: (lens, item) => council.agent({ prompt: `Judge via the ${lens} lens: ${item}`, schema: Score }),
  aggregate: (s) => Math.min(...s.map((x) => x.score)), // gate on the weakest lens
});
```

### loopUntilDry: reach the long tail

```ts
const bugs = await council.loopUntilDry({
  round: () => council.agent({ prompt: "Find bugs not already listed.", schema: Bugs }).then((r) => r.bugs),
  key: (b) => b.id,     // dedupe across rounds
  dryRounds: 2,         // stop after 2 empty rounds in a row
});
```

## Bring your own model

The one model-specific seam is a `Runner`: a function from a request to raw output. Any provider, local model, or your own gateway works.

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Runner } from "consilium";

const client = new Anthropic();

const runner: Runner = async (req) => {
  const res = await client.messages.create({
    model: req.model ?? "claude-sonnet-5",
    max_tokens: 4096,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
    ...(req.jsonSchema && {
      tools: [{ name: "out", description: "structured output", input_schema: req.jsonSchema }],
      tool_choice: { type: "tool", name: "out" },
    }),
  });
  req.report?.({ inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  const tool = res.content.find((b) => b.type === "tool_use");
  return tool ? tool.input : res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};
```

When a request carries a `schema`, its JSON Schema is handed to the runner (use it for a tool call or `response_format`) and the result is validated back with `schema.parse`, retrying on a mismatch. A `schema` is anything with a `.parse`, so a zod schema drops in directly.

## Testable by design

Because the runner is injected, you test orchestration with a plain function and zero network:

```ts
import { Consilium } from "consilium";

const council = new Consilium({
  runner: async (req) => (/hallucinated/.test(req.prompt) ? { refuted: true } : { refuted: false }),
});

const v = await council.refute({ claim: "hallucinated race condition", voters: 3 });
expect(v.survives).toBe(false); // the skeptics killed it, no API involved
```

The test suite drives every pattern this way. These mocked tests verify deterministic control flow; they do not measure model accuracy or prove that a council outperforms a single call.

## Execution behavior

- **Concurrency cap.** Hand a pipeline 500 items; only `concurrency` ever touch the model at once.
- **Retries with backoff.** Transient errors and schema-validation failures are retried, configurably.
- **Budget.** `maxCalls` caps runner attempts, including failures and retries. Every attempt checks the budget after acquiring the concurrency slot and reserves its call before invoking the runner. `usage().calls` includes in-flight attempts. `loopUntilDry` stops itself when the budget is spent.
- **Observability.** Subscribe to `onEvent` for start / end / retry / error / charge, and read `council.usage()`.
- **Failure isolation.** A thrown agent becomes `null` inside `parallel` / `fanout` / `pipeline`; one bad item never sinks the batch.

Budgets apply to work routed through `council.agent()` (including `refute` voters), not arbitrary callbacks or SDK retries inside a runner. For example:

```ts
const council = new Consilium({
  runner,
  concurrency: 3,
  budget: { maxCalls: 20, maxCost: 1 },
});
```

`maxCost` checks accumulated `report({ cost })` values before each attempt. It cannot reserve unknown future costs or cancel attempts already in flight, so reported cost can overshoot the limit. Token counts alone do not charge cost; the runner example above must also report a cost in the same units as `maxCost` to enforce that limit. Budget rejection throws `BudgetExceededError`; failure-isolating primitives turn it into `null`.

## Design principles

1. **Control flow is code, not a model.** Loops, fan-out and conditionals are deterministic and steppable. The model decides content, never orchestration.
2. **One model seam.** Everything model-specific lives in the `Runner`. Swap providers without touching a pattern.
3. **Structure buys reliability.** The reusable win is not a cleverer prompt; it is refute-and-converge applied consistently.
4. **Zero runtime dependencies.** Small, typed, isomorphic (Node and the browser).

## License

MIT
