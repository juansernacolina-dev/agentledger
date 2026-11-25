import { describe, expect, it } from "vitest";
import {
  checkTrace,
  MAX_TRACE_PAYLOAD_BYTES,
  redactTraceEvent,
  TraceEventInputSchema,
  TraceEventSchema,
  type RunBudget,
  type TraceEvent,
  type TraceEventInput,
} from "../src/index.js";

const budget: RunBudget = { maxSteps: 4, maxDurationMs: 10_000, maxRetries: 1 };

const started = (sequence: number, stepId: string, index: number, offsetMs: number, extra: Partial<TraceEventInput> = {}) =>
  ({
    id: `evt_${String(sequence).padStart(6, "0")}`,
    sequence,
    type: "step_started",
    stepId,
    attempt: 1,
    offsetMs,
    index,
    kind: "model",
    name: "Plan reply",
    input: {},
    ...extra,
  }) as TraceEventInput;

const finished = (sequence: number, stepId: string, offsetMs: number, extra: Partial<TraceEventInput> = {}) =>
  ({
    id: `evt_${String(sequence).padStart(6, "0")}`,
    sequence,
    type: "step_finished",
    stepId,
    attempt: 1,
    offsetMs,
    status: "ok",
    ...extra,
  }) as TraceEventInput;

const stored = (events: TraceEventInput[]): TraceEvent[] => events.map(redactTraceEvent);

describe("trace event schema", () => {
  it("accepts started and finished events", () => {
    expect(TraceEventInputSchema.safeParse(started(0, "step_lookup", 0, 0, { kind: "tool", tool: "lookup_order" })).success).toBe(true);
    expect(TraceEventInputSchema.safeParse(finished(1, "step_lookup", 40, { output: { found: true } })).success).toBe(true);
  });

  it("requires a tool name exactly on tool steps", () => {
    expect(TraceEventInputSchema.safeParse(started(0, "step_lookup", 0, 0, { kind: "tool" })).success).toBe(false);
    expect(TraceEventInputSchema.safeParse(started(0, "step_planner", 0, 0, { tool: "lookup_order" })).success).toBe(false);
  });

  it("requires an error exactly on failed steps", () => {
    expect(TraceEventInputSchema.safeParse(finished(1, "step_planner", 5, { status: "error" })).success).toBe(false);
    expect(TraceEventInputSchema.safeParse(finished(1, "step_planner", 5, { error: "boom" })).success).toBe(false);
    expect(TraceEventInputSchema.safeParse(finished(1, "step_planner", 5, { status: "error", error: "boom" })).success).toBe(true);
  });

  it("rejects unknown fields, bad IDs and oversized payloads", () => {
    expect(TraceEventInputSchema.safeParse({ ...started(0, "step_planner", 0, 0), prompt: "raw" }).success).toBe(false);
    expect(TraceEventInputSchema.safeParse(started(0, "plan", 0, 0)).success).toBe(false);
    expect(TraceEventInputSchema.safeParse({ ...started(0, "step_planner", 0, 0), id: "event-1" }).success).toBe(false);
    const big = { text: "x".repeat(MAX_TRACE_PAYLOAD_BYTES) };
    expect(TraceEventInputSchema.safeParse(started(0, "step_planner", 0, 0, { input: big })).success).toBe(false);
  });

  it("rejects deeply nested payloads", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) nested = { nested };
    expect(TraceEventInputSchema.safeParse(started(0, "step_planner", 0, 0, { input: nested as never })).success).toBe(false);
  });
});

describe("redactTraceEvent", () => {
  it("redacts input, output and error and records the paths", () => {
    const start = redactTraceEvent(started(0, "step_planner", 0, 0, { input: { customerEmail: "kim@example.test", orderNumber: "A-7" } }));
    expect(start).toMatchObject({ input: { customerEmail: "[REDACTED:email]", orderNumber: "A-7" } });
    expect(start.redactions).toEqual([{ path: "input.customerEmail", reason: "email" }]);

    const end = redactTraceEvent(
      finished(1, "step_planner", 9, {
        status: "error",
        error: "Lookup failed for kim@example.test",
        output: { apiKey: "sk-test-0123456789abcdefABCD" },
      }),
    );
    expect(end).toMatchObject({ error: "Lookup failed for [REDACTED:email]", output: { apiKey: "[REDACTED:secret]" } });
    expect(end.redactions).toEqual([
      { path: "output.apiKey", reason: "secret" },
      { path: "error", reason: "email" },
    ]);
    expect(TraceEventSchema.safeParse(end).success).toBe(true);
  });

  it("gives the same result when run twice", () => {
    const once = redactTraceEvent(started(0, "step_planner", 0, 0, { input: { note: "card 4111-1111-1111-1111" } }));
    const input: Partial<TraceEvent> = { ...once };
    delete input.redactions;
    expect(redactTraceEvent(input as TraceEventInput)).toEqual({ ...once, redactions: [] });
  });
});

describe("checkTrace", () => {
  it("accepts a consistent trace with a retried step", () => {
    const events = stored([
      started(0, "step_planner", 0, 0),
      finished(1, "step_planner", 120),
      started(2, "step_lookup", 1, 120, { kind: "tool", tool: "lookup_order" }),
      finished(3, "step_lookup", 300, { status: "error", error: "timeout" }),
      started(4, "step_lookup", 1, 310, { kind: "tool", tool: "lookup_order", attempt: 2 }),
      finished(5, "step_lookup", 420, { attempt: 2 }),
    ]);
    expect(checkTrace(events, budget)).toEqual([]);
  });

  it("reports gaps, duplicate IDs and offsets that go backwards", () => {
    const events = stored([started(0, "step_planner", 0, 50), { ...finished(2, "step_planner", 40), id: "evt_000000" }]);
    expect(checkTrace(events, budget).map((i) => i.message)).toEqual([
      "expected sequence 1, got 2",
      "duplicate event id evt_000000",
      "offset 40 is before the previous event (50)",
      "step step_planner finished before it started",
    ]);
  });

  it("reports out-of-order step indexes and unstarted or doubly finished steps", () => {
    const events = stored([
      started(0, "step_planner", 1, 0),
      finished(1, "step_unknown", 1),
      finished(2, "step_planner", 2),
      finished(3, "step_planner", 3),
    ]);
    expect(checkTrace(events, budget).map((i) => i.message)).toEqual([
      "expected step index 0, got 1",
      "step step_unknown finished without being started",
      "step step_planner finished without being started",
    ]);
  });

  it("only retries failed steps, as the next attempt, unchanged", () => {
    const events = stored([
      started(0, "step_planner", 0, 0),
      finished(1, "step_planner", 10),
      started(2, "step_planner", 0, 20, { attempt: 3, name: "Renamed" }),
    ]);
    expect(checkTrace(events, budget).map((i) => i.message)).toEqual([
      "attempt 3 exceeds the retry budget of 1",
      "step step_planner is only retried after a failed attempt",
      "expected attempt 2, got 3",
      "a retry of step step_planner must keep its index, kind, name and tool",
    ]);
  });

  it("reports a step started twice without finishing", () => {
    const events = stored([started(0, "step_planner", 0, 0), started(1, "step_planner", 0, 5)]);
    expect(checkTrace(events, budget).map((i) => i.message)).toEqual([
      "step step_planner started again before attempt 1 finished",
    ]);
  });

  it("enforces the step count and duration budget", () => {
    const events = stored([
      ...[0, 1, 2, 3].flatMap((i) => [started(i * 2, `step_s${i}aaaa`, i, i * 10), finished(i * 2 + 1, `step_s${i}aaaa`, i * 10 + 5)]),
      started(8, "step_s4aaaa", 4, 10_001),
    ]);
    expect(checkTrace(events, budget)).toEqual([
      { path: "events.8.offsetMs", message: "offset 10001 is past the run's duration budget of 10000" },
      { path: "events.8", message: "step step_s4aaaa exceeds the budget of 4 steps" },
    ]);
  });
});
