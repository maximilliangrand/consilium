export class BudgetExceededError extends Error {
  constructor(
    readonly spent: { calls: number; cost: number },
    readonly limit: { maxCalls?: number; maxCost?: number },
  ) {
    super(
      `Council budget exhausted (calls ${spent.calls}, cost ${spent.cost}; ` +
        `limit calls ${limit.maxCalls ?? "inf"}, cost ${limit.maxCost ?? "inf"})`,
    );
    this.name = "BudgetExceededError";
  }
}

export class SchemaError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SchemaError";
  }
}
