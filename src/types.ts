/**
 * A Schema validates and coerces raw model output into a typed value.
 *
 * It is intentionally structural so a zod schema (which has `.parse`) satisfies
 * it directly, and so does any hand-written validator. `jsonSchema`, when
 * present, is handed to the runner so it can request structured output from the
 * model (a tool call, response_format, etc.).
 */
export interface Schema<T> {
  readonly name?: string;
  readonly jsonSchema?: unknown;
  parse(raw: unknown): T;
}

/** Token / cost usage a runner may report so the council can budget. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

/**
 * The one model-specific seam. A runner turns a prompt into raw output. It may
 * return a string, or a parsed object when it used `jsonSchema` to get
 * structured output. The council validates the result with the request's schema
 * and retries on a validation failure, so a runner never has to be perfect.
 */
export type Runner = (req: RunnerRequest) => Promise<unknown>;

export interface RunnerRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly jsonSchema?: unknown;
  readonly model?: string;
  readonly effort?: string;
  readonly label?: string;
  readonly signal?: AbortSignal;
  /** The runner calls this to report usage for budgeting. */
  readonly report?: (usage: Usage) => void;
}

/** One agent call. Without a schema it resolves to a string. */
export interface AgentRequest<T = string> {
  readonly prompt: string;
  readonly system?: string;
  readonly label?: string;
  readonly schema?: Schema<T>;
  readonly model?: string;
  readonly effort?: string;
  /** Max retries for this call (overrides the council default). */
  readonly retries?: number;
  readonly signal?: AbortSignal;
}

/** Majority means "more than half"; a number is an absolute count. */
export type Threshold = "any" | "majority" | "all" | number;

export type CouncilEvent =
  | { type: "agent:start"; id: number; label?: string; attempt: number }
  | { type: "agent:end"; id: number; label?: string; ms: number }
  | { type: "agent:retry"; id: number; label?: string; attempt: number; error: unknown }
  | { type: "agent:error"; id: number; label?: string; error: unknown }
  | { type: "charge"; calls: number; cost: number };

export interface CouncilOptions {
  readonly runner: Runner;
  /** Max concurrent agent calls. Default 8. */
  readonly concurrency?: number;
  /** Default retries per agent call. Default 2. */
  readonly retries?: number;
  /**
   * Stop dispatching at maxCalls runner attempts, including failures and retries.
   * maxCost uses runner-reported cost only; in-flight attempts can overshoot it.
   */
  readonly budget?: { maxCalls?: number; maxCost?: number };
  /** Decide whether a thrown error is worth retrying. Default: retry anything. */
  readonly shouldRetry?: (error: unknown) => boolean;
  /** Backoff before retry attempt N (0-indexed). Default: 150ms * 2^N. */
  readonly backoffMs?: (attempt: number) => number;
  readonly onEvent?: (event: CouncilEvent) => void;
  readonly model?: string;
  readonly effort?: string;
}
