import type {
  AgentRequest,
  CouncilEvent,
  CouncilOptions,
  Runner,
  Threshold,
  Usage,
} from "./types.js";
import { BudgetExceededError } from "./errors.js";
import { Semaphore, delay } from "./concurrency.js";
import { VerdictSchema, type Verdict } from "./schema.js";

export interface RefuteRequest<C = undefined> {
  /** The claim to attack. */
  readonly claim: string;
  readonly context?: C;
  /** Independent skeptics. Default 3. */
  readonly voters?: number;
  /** How many refutals kill the claim. Default "majority". */
  readonly threshold?: Threshold;
  readonly system?: string;
  /** Build the refutation prompt for voter `i`. Overrides the default. */
  readonly prompt?: (claim: string, context: C | undefined, voter: number) => string;
  readonly model?: string;
  readonly effort?: string;
}

export interface RefuteResult<C = undefined> {
  readonly claim: string;
  readonly context?: C;
  /** True when fewer than the threshold of voters refuted it. */
  readonly survives: boolean;
  readonly refuted: number;
  readonly total: number;
  readonly votes: readonly Verdict[];
}

export interface PanelRequest<I, S> {
  readonly item: I;
  /** Distinct perspectives, each judged independently. */
  readonly lenses: readonly string[];
  readonly judge: (lens: string, item: I) => Promise<S>;
  readonly aggregate?: (scores: ReadonlyArray<{ lens: string; score: S }>) => unknown;
}

export interface PanelResult<S> {
  readonly scores: ReadonlyArray<{ lens: string; score: S }>;
  readonly aggregate: unknown;
}

export interface LoopRequest<T> {
  /** Produce this round's findings, given everything found so far. */
  readonly round: (soFar: readonly T[]) => Promise<T[]>;
  /** Stable identity, used to drop findings already seen. */
  readonly key: (item: T) => string;
  /** Consecutive rounds with nothing new before stopping. Default 2. */
  readonly dryRounds?: number;
  readonly maxRounds?: number;
  readonly onProgress?: (total: number, round: number) => void;
}

export type PipelineStage = (prev: unknown, original: unknown, index: number) => unknown | Promise<unknown>;

const DEFAULT_REFUTE_SYSTEM =
  "You are a rigorous skeptic. Your job is to REFUTE the claim, not to agree with it. " +
  "Look for the concrete case where it is wrong. If you cannot be confident it holds, set refuted=true. " +
  "Default to refuted=true when uncertain.";

function defaultRefutePrompt(claim: string, context: unknown, voter: number): string {
  const ctx = context === undefined ? "" : `\n\nContext:\n${stringify(context)}`;
  return (
    `Try to refute this claim. Find a specific reason it is false or unreliable.` +
    `\n\nClaim: ${claim}${ctx}\n\n` +
    `Return { "refuted": boolean, "reason"?: string }. (skeptic #${voter + 1})`
  );
}

function stringify(x: unknown): string {
  return typeof x === "string" ? x : JSON.stringify(x, null, 1);
}

function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

/**
 * Resolve a Threshold into "how many refutals it takes to kill the claim".
 * A claim survives when the actual refutal count is strictly below this.
 */
function refutalsToKill(threshold: Threshold, total: number): number {
  if (typeof threshold === "number") return threshold;
  if (threshold === "any") return 1;
  if (threshold === "all") return Math.max(1, total);
  return Math.floor(total / 2) + 1; // majority
}

/**
 * A council of agents. Construct it with a runner (your model call), then
 * compose the primitives. The control flow is ordinary, deterministic code; the
 * runner is the only stochastic part, which is what makes every pattern here
 * unit-testable with a mock.
 */
export class Consilium {
  private readonly runner: Runner;
  private readonly sem: Semaphore;
  private readonly retries: number;
  private readonly shouldRetry: (error: unknown) => boolean;
  private readonly backoffMs: (attempt: number) => number;
  private readonly onEvent: (event: CouncilEvent) => void;
  private readonly opts: CouncilOptions;
  private counter = 0;
  private readonly spent = { calls: 0, cost: 0 };

  constructor(options: CouncilOptions) {
    this.opts = options;
    this.runner = options.runner;
    this.sem = new Semaphore(options.concurrency ?? 8);
    this.retries = options.retries ?? 2;
    this.shouldRetry = options.shouldRetry ?? (() => true);
    this.backoffMs = options.backoffMs ?? ((attempt) => 150 * 2 ** attempt);
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Calls made and cost reported so far. */
  usage(): { calls: number; cost: number } {
    return { ...this.spent };
  }

  /** One agent call: concurrency-capped, retried, schema-validated, budgeted. */
  async agent<T = string>(req: AgentRequest<T>): Promise<T> {
    this.assertBudget();
    const id = ++this.counter;
    const maxRetries = req.retries ?? this.retries;
    const release = await this.sem.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        this.onEvent({ type: "agent:start", id, label: req.label, attempt });
        const started = Date.now();
        try {
          const raw = await this.runner({
            prompt: req.prompt,
            system: req.system,
            jsonSchema: req.schema?.jsonSchema,
            model: req.model ?? this.opts.model,
            effort: req.effort ?? this.opts.effort,
            label: req.label,
            signal: req.signal,
            report: (u) => this.chargeUsage(u),
          });
          const value = req.schema ? req.schema.parse(raw) : (raw as T);
          this.spent.calls++;
          this.onEvent({ type: "charge", calls: this.spent.calls, cost: this.spent.cost });
          this.onEvent({ type: "agent:end", id, label: req.label, ms: Date.now() - started });
          return value;
        } catch (err) {
          if (attempt < maxRetries && this.shouldRetry(err)) {
            this.onEvent({ type: "agent:retry", id, label: req.label, attempt, error: err });
            await delay(this.backoffMs(attempt), req.signal);
            continue;
          }
          this.onEvent({ type: "agent:error", id, label: req.label, error: err });
          throw err;
        }
      }
    } finally {
      release();
    }
  }

  /** Run thunks concurrently and wait for all. A thrown thunk resolves to null. */
  async parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> {
    return Promise.all(thunks.map((t) => this.safe(t)));
  }

  /** Map items to concurrent agent work. Failures become null. */
  async fanout<A, B>(
    items: readonly A[],
    fn: (item: A, index: number) => Promise<B>,
  ): Promise<Array<B | null>> {
    return this.parallel(items.map((item, i) => () => fn(item, i)));
  }

  /**
   * Run every item through all stages independently, with NO barrier between
   * stages: item A can be in stage 3 while item B is still in stage 1. A stage
   * that throws drops that item to null and skips its remaining stages.
   */
  async pipeline<T = unknown>(
    items: readonly unknown[],
    ...stages: PipelineStage[]
  ): Promise<Array<T | null>> {
    return Promise.all(
      items.map(async (item, i) => {
        let cur: unknown = item;
        try {
          for (const stage of stages) cur = await stage(cur, item, i);
          return cur as T;
        } catch {
          return null;
        }
      }),
    );
  }

  /**
   * Adversarial verification. Spawn N independent skeptics, each prompted to
   * REFUTE the claim; it survives only if fewer than the threshold refute it.
   * This is how a plausible-but-wrong finding gets killed before you trust it.
   */
  async refute<C = undefined>(req: RefuteRequest<C>): Promise<RefuteResult<C>> {
    const voters = req.voters ?? 3;
    const build = req.prompt ?? defaultRefutePrompt;
    const system = req.system ?? DEFAULT_REFUTE_SYSTEM;
    const votes = await this.parallel(
      range(voters).map((i) => () =>
        this.agent<Verdict>({
          label: `refute:${i}`,
          system,
          prompt: build(req.claim, req.context, i),
          schema: VerdictSchema,
          model: req.model,
          effort: req.effort,
        }),
      ),
    );
    const valid = votes.filter((v): v is Verdict => v !== null);
    const refuted = valid.filter((v) => v.refuted).length;
    const need = refutalsToKill(req.threshold ?? "majority", valid.length || voters);
    const result: RefuteResult<C> = {
      claim: req.claim,
      survives: valid.length > 0 && refuted < need,
      refuted,
      total: valid.length,
      votes: valid,
    };
    return req.context === undefined ? result : { ...result, context: req.context };
  }

  /**
   * Judge one item from several distinct perspectives at once. Diversity of
   * lens catches failure modes that N identical judges would all miss.
   */
  async panel<I, S>(req: PanelRequest<I, S>): Promise<PanelResult<S>> {
    const results = await this.parallel<{ lens: string; score: S }>(
      req.lenses.map(
        (lens) => async (): Promise<{ lens: string; score: S }> => ({
          lens,
          score: await req.judge(lens, req.item),
        }),
      ),
    );
    const scores = results.filter(
      (r): r is { lens: string; score: S } => r !== null,
    );
    return { scores, aggregate: req.aggregate ? req.aggregate(scores) : undefined };
  }

  /**
   * Keep running rounds of discovery until `dryRounds` consecutive rounds turn
   * up nothing new. For unknown-size work (find all the bugs, all the edge
   * cases) this reaches the long tail that a fixed loop count misses.
   */
  async loopUntilDry<T>(req: LoopRequest<T>): Promise<T[]> {
    const seen = new Set<string>();
    const all: T[] = [];
    const dryTarget = req.dryRounds ?? 2;
    const maxRounds = req.maxRounds ?? Number.POSITIVE_INFINITY;
    let dry = 0;
    let round = 0;
    while (dry < dryTarget && round < maxRounds && !this.budgetExhausted()) {
      round++;
      const found = await req.round(all.slice());
      const fresh = found.filter((x) => !seen.has(req.key(x)));
      if (fresh.length === 0) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(req.key(x));
        all.push(x);
      }
      req.onProgress?.(all.length, round);
    }
    return all;
  }

  private async safe<T>(t: () => Promise<T>): Promise<T | null> {
    try {
      return await t();
    } catch {
      return null;
    }
  }

  private chargeUsage(u: Usage): void {
    if (typeof u.cost === "number") this.spent.cost += u.cost;
  }

  private assertBudget(): void {
    const b = this.opts.budget;
    if (!b) return;
    if (this.budgetExhausted()) throw new BudgetExceededError({ ...this.spent }, b);
  }

  private budgetExhausted(): boolean {
    const b = this.opts.budget;
    if (!b) return false;
    if (b.maxCalls !== undefined && this.spent.calls >= b.maxCalls) return true;
    if (b.maxCost !== undefined && this.spent.cost >= b.maxCost) return true;
    return false;
  }
}
