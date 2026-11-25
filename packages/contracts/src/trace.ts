import { z } from "zod";
import {
  REDACTION_REASONS,
  redactJson,
  redactText,
  type JsonObject,
  type JsonValue,
  type Redaction,
} from "./redaction.js";
import {
  idPattern,
  StepIdSchema,
  StepKindSchema,
  StepStatusSchema,
  type ContractIssue,
  type RunBudget,
} from "./run.js";

/**
 * Trace events (v1): what happened inside a run, step by step.
 *
 * A worker reports each step attempt as a `step_started` event (with the
 * step's input) and a `step_finished` event (with its output or error).
 * Events are numbered per run from 0 and are append-only. Event and step IDs
 * are chosen by the reporter, so replaying the same fixture always produces
 * the same IDs. Inputs, outputs and errors are redacted before storage; a
 * stored event lists what was removed in `redactions`.
 */
export const TRACE_CONTRACT_VERSION = 1;

export const TraceEventIdSchema = idPattern("evt");

/** Payload limits keep one trace event small enough to render and diff. */
export const MAX_TRACE_PAYLOAD_BYTES = 16 * 1024;
export const MAX_TRACE_PAYLOAD_DEPTH = 12;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const utf8 = new TextEncoder();

function depthOf(value: JsonValue): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === "object") return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  return 0;
}

export const TracePayloadSchema = z
  .record(JsonValueSchema)
  .superRefine((payload, ctx) => {
    if (utf8.encode(JSON.stringify(payload)).length > MAX_TRACE_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be at most ${MAX_TRACE_PAYLOAD_BYTES} bytes of JSON`,
      });
    }
    if (depthOf(payload) > MAX_TRACE_PAYLOAD_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be nested at most ${MAX_TRACE_PAYLOAD_DEPTH} levels deep`,
      });
    }
  }) as z.ZodType<JsonObject>;

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case");

const eventBase = {
  id: TraceEventIdSchema,
  sequence: z.number().int().min(0),
  stepId: StepIdSchema,
  attempt: z.number().int().min(1),
  /** Milliseconds since the run started. */
  offsetMs: z.number().int().min(0),
};

const stepStartedFields = {
  ...eventBase,
  type: z.literal("step_started"),
  index: z.number().int().min(0),
  kind: StepKindSchema,
  name: z.string().trim().min(1).max(120),
  /** The tool called by a `tool` step; only tool steps have one. */
  tool: ToolNameSchema.optional(),
  input: TracePayloadSchema,
};

const stepFinishedFields = {
  ...eventBase,
  type: z.literal("step_finished"),
  status: StepStatusSchema,
  output: TracePayloadSchema.optional(),
  error: z.string().trim().min(1).max(500).optional(),
};

export const RedactionSchema = z
  .object({ path: z.string().max(500), reason: z.enum(REDACTION_REASONS) })
  .strict();

const redactionsField = { redactions: z.array(RedactionSchema) };

function refineEvent(
  event: { type: "step_started"; kind: string; tool?: string } | { type: "step_finished"; status: string; error?: string },
  ctx: z.RefinementCtx,
): void {
  if (event.type === "step_started") {
    if ((event.kind === "tool") !== (event.tool !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: event.kind === "tool" ? "a tool step must name its tool" : "only tool steps name a tool",
      });
    }
    return;
  }
  if ((event.status === "error") !== (event.error !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: event.status === "error" ? "a failed step must explain the error" : "only failed steps carry an error",
    });
  }
}

/** A trace event as reported by a worker, before redaction. */
export const TraceEventInputSchema = z
  .discriminatedUnion("type", [z.object(stepStartedFields).strict(), z.object(stepFinishedFields).strict()])
  .superRefine(refineEvent);
export type TraceEventInput = z.infer<typeof TraceEventInputSchema>;

/** A stored trace event: redacted, with the list of what was removed. */
export const TraceEventSchema = z
  .discriminatedUnion("type", [
    z.object({ ...stepStartedFields, ...redactionsField }).strict(),
    z.object({ ...stepFinishedFields, ...redactionsField }).strict(),
  ])
  .superRefine(refineEvent);
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type StepStartedEvent = Extract<TraceEvent, { type: "step_started" }>;
export type StepFinishedEvent = Extract<TraceEvent, { type: "step_finished" }>;

/**
 * Redacts an event's input, output and error. Everything else (IDs, names,
 * timings) is structural and kept. Redacting a redacted event changes nothing.
 */
export function redactTraceEvent(event: TraceEventInput): TraceEvent {
  if (event.type === "step_started") {
    const input = redactJson(event.input, "input");
    return { ...event, input: input.value, redactions: input.redactions };
  }
  const redactions: Redaction[] = [];
  const { output, error, ...rest } = event;
  const result: StepFinishedEvent = { ...rest, redactions };
  if (output !== undefined) {
    const redacted = redactJson(output, "output");
    result.output = redacted.value;
    redactions.push(...redacted.redactions);
  }
  if (error !== undefined) {
    const redacted = redactText(error);
    result.error = redacted.text;
    redactions.push(...redacted.reasons.map((reason) => ({ path: "error", reason })));
  }
  return result;
}

/**
 * Checks that a run's full, ordered event list tells a consistent story:
 *
 * - sequences run 0, 1, 2, … and event IDs are unique
 * - offsets never go backwards and stay within the duration budget
 * - a new step takes the next index and starts at attempt 1
 * - a step attempt starts once, finishes once, and finishes after it started
 * - a step is only retried after its previous attempt failed, as the next
 *   attempt, under the same index, kind, name and tool
 * - steps and attempts stay within the run budget
 */
export function checkTrace(events: readonly TraceEvent[], budget: RunBudget): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const issue = (position: number, field: string, message: string) =>
    issues.push({ path: `events.${position}${field === "" ? "" : `.${field}`}`, message });

  interface StepState {
    index: number;
    kind: string;
    name: string;
    tool: string | undefined;
    attempt: number;
    open: boolean;
    startedAt: number;
    lastStatus: string | null;
  }
  const steps = new Map<string, StepState>();
  const ids = new Set<string>();
  let lastOffset = 0;

  events.forEach((event, position) => {
    if (event.sequence !== position) issue(position, "sequence", `expected sequence ${position}, got ${event.sequence}`);
    if (ids.has(event.id)) issue(position, "id", `duplicate event id ${event.id}`);
    ids.add(event.id);
    if (event.offsetMs < lastOffset) issue(position, "offsetMs", `offset ${event.offsetMs} is before the previous event (${lastOffset})`);
    lastOffset = Math.max(lastOffset, event.offsetMs);
    if (event.offsetMs > budget.maxDurationMs) {
      issue(position, "offsetMs", `offset ${event.offsetMs} is past the run's duration budget of ${budget.maxDurationMs}`);
    }
    if (event.attempt > budget.maxRetries + 1) {
      issue(position, "attempt", `attempt ${event.attempt} exceeds the retry budget of ${budget.maxRetries}`);
    }

    const step = steps.get(event.stepId);
    if (event.type === "step_started") {
      if (step === undefined) {
        if (event.index !== steps.size) issue(position, "index", `expected step index ${steps.size}, got ${event.index}`);
        if (event.attempt !== 1) issue(position, "attempt", "a new step starts at attempt 1");
        if (steps.size >= budget.maxSteps) issue(position, "", `step ${event.stepId} exceeds the budget of ${budget.maxSteps} steps`);
        steps.set(event.stepId, {
          index: event.index,
          kind: event.kind,
          name: event.name,
          tool: event.tool,
          attempt: event.attempt,
          open: true,
          startedAt: event.offsetMs,
          lastStatus: null,
        });
        return;
      }
      if (step.open) {
        issue(position, "", `step ${event.stepId} started again before attempt ${step.attempt} finished`);
        return;
      }
      if (step.lastStatus !== "error") issue(position, "", `step ${event.stepId} is only retried after a failed attempt`);
      if (event.attempt !== step.attempt + 1) issue(position, "attempt", `expected attempt ${step.attempt + 1}, got ${event.attempt}`);
      if (event.index !== step.index || event.kind !== step.kind || event.name !== step.name || event.tool !== step.tool) {
        issue(position, "", `a retry of step ${event.stepId} must keep its index, kind, name and tool`);
      }
      Object.assign(step, { attempt: event.attempt, open: true, startedAt: event.offsetMs, lastStatus: null });
      return;
    }

    if (step === undefined || !step.open) {
      issue(position, "stepId", `step ${event.stepId} finished without being started`);
      return;
    }
    if (event.attempt !== step.attempt) issue(position, "attempt", `step ${event.stepId} is on attempt ${step.attempt}, not ${event.attempt}`);
    if (event.offsetMs < step.startedAt) issue(position, "offsetMs", `step ${event.stepId} finished before it started`);
    step.open = false;
    step.lastStatus = event.status;
  });

  return issues;
}
