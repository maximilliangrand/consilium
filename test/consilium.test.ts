import { describe, it, expect } from "vitest";
import { Consilium, schema, BudgetExceededError, type Runner, type RunnerRequest } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Build a council whose model is a plain function. No network, fully deterministic. */
function council(handler: (req: RunnerRequest) => unknown | Promise<unknown>, opts = {}) {
  const runner: Runner = async (req) => handler(req);
  return new Consilium({ runner, ...opts });
}

describe("agent", () => {
  it("returns the runner output for a plain call", async () => {
    const c = council(() => "hello");
    expect(await c.agent({ prompt: "hi" })).toBe("hello");
  });

  it("validates against a schema", async () => {
    const NumSchema = schema<number>("Num", (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error("not a number");
      return n;
    });
    const c = council(() => "42");
    expect(await c.agent({ prompt: "x", schema: NumSchema })).toBe(42);
  });

  it("retries a failing call, then succeeds", async () => {
    let attempts = 0;
    const c = council(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      { backoffMs: () => 0 },
    );
    expect(await c.agent({ prompt: "x", retries: 5 })).toBe("ok");
    expect(attempts).toBe(3);
    expect(c.usage().calls).toBe(3);
  });

  it("retries on a schema validation failure", async () => {
    let attempts = 0;
    const Strict = schema<{ ok: true }>("Strict", (raw) => {
      if ((raw as { ok?: boolean }).ok !== true) throw new Error("bad");
      return { ok: true };
    });
    const c = council(
      () => {
        attempts++;
        return attempts < 2 ? { ok: false } : { ok: true };
      },
      { backoffMs: () => 0 },
    );
    expect(await c.agent({ prompt: "x", schema: Strict })).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("gives up after the retry budget and throws", async () => {
    const c = council(() => {
      throw new Error("always");
    }, { backoffMs: () => 0 });
    await expect(c.agent({ prompt: "x", retries: 2 })).rejects.toThrow("always");
  });
});

describe("concurrency", () => {
  it("never runs more than the cap at once", async () => {
    let active = 0;
    let peak = 0;
    const c = council(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
      return "ok";
    }, { concurrency: 3 });
    await c.fanout(range(12), () => c.agent({ prompt: "x" }));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("parallel and pipeline", () => {
  it("turns a thrown thunk into null, keeping the rest", async () => {
    const c = council(() => "ok");
    const out = await c.parallel([
      async () => 1,
      async () => {
        throw new Error("boom");
      },
      async () => 3,
    ]);
    expect(out).toEqual([1, null, 3]);
  });

  it("runs each item through all stages, dropping a failed item to null", async () => {
    const c = council(() => "ok");
    const out = await c.pipeline<number>(
      [1, 2, 3],
      (n) => (n as number) * 2,
      (n) => {
        if (n === 4) throw new Error("skip the second item");
        return (n as number) + 1;
      },
    );
    expect(out).toEqual([3, null, 7]);
  });
});

describe("refute (adversarial verification)", () => {
  const verdictFor = (req: RunnerRequest, refuters: Set<number>) => {
    const voter = Number(req.label?.split(":")[1] ?? 0);
    return { refuted: refuters.has(voter) };
  };

  it("kills a claim a majority refutes", async () => {
    const c = council((req) => verdictFor(req, new Set([0, 1]))); // 2 of 3
    const r = await c.refute({ claim: "x", voters: 3 });
    expect(r.refuted).toBe(2);
    expect(r.survives).toBe(false);
  });

  it("keeps a claim a minority refutes", async () => {
    const c = council((req) => verdictFor(req, new Set([0]))); // 1 of 3
    const r = await c.refute({ claim: "x", voters: 3 });
    expect(r.refuted).toBe(1);
    expect(r.survives).toBe(true);
  });

  it("threshold 'any' means one refutal kills it", async () => {
    const c = council((req) => verdictFor(req, new Set([2])));
    const r = await c.refute({ claim: "x", voters: 3, threshold: "any" });
    expect(r.survives).toBe(false);
  });

  it("threshold 'all' survives unless every voter refutes", async () => {
    const c = council((req) => verdictFor(req, new Set([0, 1]))); // not all
    const r = await c.refute({ claim: "x", voters: 3, threshold: "all" });
    expect(r.survives).toBe(true);
  });
});

describe("panel", () => {
  it("judges an item across lenses and aggregates", async () => {
    const c = council(() => "ok");
    const scores: Record<string, number> = { correctness: 8, security: 4, simplicity: 9 };
    const r = await c.panel<string, number>({
      item: "candidate",
      lenses: ["correctness", "security", "simplicity"],
      judge: async (lens) => scores[lens] ?? 0,
      aggregate: (s) => Math.min(...s.map((x) => x.score)),
    });
    expect(r.scores.map((s) => s.lens).sort()).toEqual(["correctness", "security", "simplicity"]);
    expect(r.aggregate).toBe(4); // weakest lens
  });
});

describe("loopUntilDry", () => {
  it("accumulates unique findings and stops after dry rounds", async () => {
    // Round r yields ids [r, r+1]; overlap by one each round, then dry.
    let r = 0;
    const c = council(() => "ok");
    const found = await c.loopUntilDry<{ id: number }>({
      round: async () => {
        r++;
        if (r <= 3) return [{ id: r }, { id: r + 1 }];
        return []; // dry
      },
      key: (x) => String(x.id),
      dryRounds: 2,
    });
    // rounds 1..3 contribute ids 1,2,3,4 (deduped), then 2 dry rounds stop it.
    expect(found.map((x) => x.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});

describe("budget", () => {
  it("throws once the call budget is spent", async () => {
    const c = council(() => "ok", { budget: { maxCalls: 2 } });
    await c.agent({ prompt: "1" });
    await c.agent({ prompt: "2" });
    await expect(c.agent({ prompt: "3" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(c.usage().calls).toBe(2);
  });

  it.each([1, 3, 8])("caps queued and in-flight calls at concurrency %i", async (concurrency) => {
    let attempts = 0;
    const c = council(async () => {
      attempts++;
      await Promise.resolve();
      return "ok";
    }, { concurrency, budget: { maxCalls: 2 } });
    const results = await c.fanout(range(10), () => c.agent({ prompt: "x" }));
    expect(attempts).toBe(2);
    expect(results.filter((x) => x === "ok")).toHaveLength(2);
    expect(c.usage().calls).toBe(2);
  });

  it.each([false, true])("counts failures and caps retries (schema failure: %s)", async (schemaFailure) => {
    let attempts = 0;
    const c = council(() => {
      attempts++;
      if (!schemaFailure) throw new Error("runner failed");
      return "invalid";
    }, { budget: { maxCalls: 2 }, backoffMs: () => 0 });
    const reject = schema("Reject", () => { throw new Error("invalid output"); });
    await expect(c.agent({ prompt: "x", retries: 5, ...(schemaFailure && { schema: reject }) }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(attempts).toBe(2);
    expect(c.usage().calls).toBe(2);
    await expect(c.agent({ prompt: "queued" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(attempts).toBe(2);
  });

  it("counts a terminal failure against subsequent calls", async () => {
    const c = council(() => { throw new Error("failed"); }, { retries: 0, budget: { maxCalls: 1 } });
    await expect(c.agent({ prompt: "x" })).rejects.toThrow("failed");
    expect(c.usage().calls).toBe(1);
    await expect(c.agent({ prompt: "next" })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rechecks reported cost before queued calls and retries", async () => {
    let attempts = 0;
    const c = council((req) => {
      attempts++;
      req.report?.({ cost: 2 });
      throw new Error("failed after reporting");
    }, { concurrency: 1, budget: { maxCost: 1 }, backoffMs: () => 0 });
    expect(await c.fanout(range(3), () => c.agent({ prompt: "x" }))).toEqual([null, null, null]);
    expect(attempts).toBe(1);
    expect(c.usage()).toEqual({ calls: 1, cost: 2 });
  });

  it("allows already in-flight cost to overshoot but blocks queued attempts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const c = council(async (req) => {
      attempts++;
      if (attempts === 2) release();
      await gate;
      req.report?.({ cost: 1 });
      return "ok";
    }, { concurrency: 2, budget: { maxCost: 1 } });
    expect(await c.fanout(range(4), () => c.agent({ prompt: "x" })))
      .toEqual(["ok", "ok", null, null]);
    expect(attempts).toBe(2);
    expect(c.usage()).toEqual({ calls: 2, cost: 2 });
  });

  it("charges reported cost and stops loops when exhausted", async () => {
    const c = council((req) => {
      req.report?.({ cost: 1 });
      return "ok";
    }, { budget: { maxCost: 3 } });
    const rounds: number[] = [];
    let n = 0;
    await c.loopUntilDry<{ id: number }>({
      round: async (soFar) => {
        rounds.push(soFar.length);
        await c.agent({ prompt: "find" }); // costs 1 via report()
        return [{ id: n++ }];
      },
      key: (x) => String(x.id),
      dryRounds: 5,
      maxRounds: 100,
    });
    // Each round makes 1 agent call costing 1; the loop halts near the cost cap.
    expect(c.usage().cost).toBeGreaterThanOrEqual(3);
    expect(rounds.length).toBeLessThan(10);
  });
});
