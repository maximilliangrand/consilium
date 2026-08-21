import type { Schema } from "./types.js";
import { SchemaError } from "./errors.js";

/** Wrap a plain validator function (and optional JSON Schema) into a Schema. */
export function schema<T>(
  name: string,
  parse: (raw: unknown) => T,
  jsonSchema?: unknown,
): Schema<T> {
  return { name, jsonSchema, parse };
}

/** Adapt anything with a `.parse` (e.g. a zod schema) into a Schema. */
export function fromParse<T>(
  parser: { parse(raw: unknown): T },
  jsonSchema?: unknown,
  name?: string,
): Schema<T> {
  return { name, jsonSchema, parse: (raw) => parser.parse(raw) };
}

/** Coerce raw model output (object, or a JSON string) into a plain object. */
export function asObject(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new SchemaError("expected a JSON object, got an unparseable string", raw);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError("expected an object", raw);
  }
  return value as Record<string, unknown>;
}

/** The verdict of one adversarial voter. */
export interface Verdict {
  readonly refuted: boolean;
  readonly reason?: string;
}

export const VerdictSchema: Schema<Verdict> = {
  name: "Verdict",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["refuted"],
    properties: {
      refuted: {
        type: "boolean",
        description: "true if you refuted the claim, or if you are not sure",
      },
      reason: { type: "string" },
    },
  },
  parse(raw) {
    const o = asObject(raw);
    if (typeof o.refuted !== "boolean") {
      throw new SchemaError("Verdict.refuted must be a boolean", raw);
    }
    return typeof o.reason === "string"
      ? { refuted: o.refuted, reason: o.reason }
      : { refuted: o.refuted };
  },
};
