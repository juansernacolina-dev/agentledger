import { z } from "zod";
import type { JsonObject } from "./redaction.js";
import { RunBudgetSchema, type ContractIssue, type RunBudget } from "./run.js";
import {
  checkTrace,
  redactTraceEvent,
  TRACE_CONTRACT_VERSION,
  TraceEventInputSchema,
  TracePayloadSchema,
  type TraceEvent,
} from "./trace.js";

/**
 * Trace fixtures: a recorded run, stored as JSON next to the contracts, that
 * can be replayed without a model key. A fixture names its own event and step
 * IDs, so loading it twice, or into two runs, always gives the same events.
 *
 * Fixture events are written as a worker would report them, raw values
 * included; `parseTraceFixture` returns them redacted, which is the only form
 * that may be stored.
 */
export const MAX_TRACE_FIXTURE_EVENTS = 400;

export const TraceFixtureNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens");

export const TraceFixtureSchema = z
  .object({
    contractVersion: z.literal(TRACE_CONTRACT_VERSION),
    name: TraceFixtureNameSchema,
    description: z.string().trim().min(1).max(1000),
    /** The smallest budget the recorded run fits in. */
    budget: RunBudgetSchema,
    /** The run input that produced the trace. */
    input: TracePayloadSchema,
    /** Ordered by sequence, starting at 0. */
    events: z.array(TraceEventInputSchema).min(1).max(MAX_TRACE_FIXTURE_EVENTS),
  })
  .strict();

export interface TraceFixture {
  name: string;
  description: string;
  budget: RunBudget;
  input: JsonObject;
  /** Redacted, ready to store. */
  events: TraceEvent[];
  /** Step IDs in step-index order. */
  stepIds: string[];
}

export type ParseTraceFixtureResult =
  | { ok: true; fixture: TraceFixture }
  | { ok: false; issues: ContractIssue[] };

/**
 * Validates a fixture without throwing: the envelope and every event against
 * the trace contract, then the redacted events as a whole with `checkTrace`
 * against the fixture's own budget.
 */
export function parseTraceFixture(input: unknown): ParseTraceFixtureResult {
  const parsed = TraceFixtureSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    };
  }

  const { name, description, budget, input: runInput } = parsed.data;
  const events = parsed.data.events.map(redactTraceEvent);
  const issues = checkTrace(events, budget);
  if (issues.length > 0) return { ok: false, issues };

  const stepIds = events.flatMap((event) => (event.type === "step_started" && event.attempt === 1 ? [event.stepId] : []));
  return { ok: true, fixture: { name, description, budget, input: runInput, events, stepIds } };
}
