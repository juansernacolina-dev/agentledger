import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTrace,
  parseTraceFixture,
  redactTraceEvent,
  TraceEventSchema,
  type TraceEvent,
  type TraceEventInput,
  type TraceFixture,
} from "../src/index.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/traces/refund-eight-steps.json");
const rawText = readFileSync(fixturePath, "utf8");
const raw = () => JSON.parse(rawText) as { events: Record<string, unknown>[] } & Record<string, unknown>;

/** The fictional personal data and credentials planted in the fixture. */
const RAW_VALUES = [
  "noor.patel@example.test",
  "+44 20 7946 0958",
  "5555 5555 5555 4444",
  "5555555555554444",
  "1990-04-12",
  "fixture-orders-7Qm2Xc9LpA",
  "sk-test-fixtureRefunds0123456789",
];

function load(input: unknown = raw()): TraceFixture {
  const result = parseTraceFixture(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.fixture;
}

describe("refund-eight-steps trace fixture", () => {
  it("loads as eight steps, one retried, within its budget", () => {
    const fixture = load();
    expect(fixture.name).toBe("refund-eight-steps");
    expect(fixture.stepIds).toEqual([
      "step_classify",
      "step_lookuporder",
      "step_searchpolicy",
      "step_checkeligibility",
      "step_approvalgate",
      "step_issuerefund",
      "step_draftreply",
      "step_auditsummary",
    ]);
    expect(fixture.events).toHaveLength(18);
    expect(fixture.budget.maxSteps).toBe(8);
    expect(checkTrace(fixture.events, fixture.budget)).toEqual([]);
    for (const event of fixture.events) expect(TraceEventSchema.safeParse(event).success).toBe(true);

    const retried = fixture.events.filter((event) => event.attempt === 2).map((event) => [event.type, event.stepId]);
    expect(retried).toEqual([
      ["step_started", "step_lookuporder"],
      ["step_finished", "step_lookuporder"],
    ]);
    const kinds = fixture.events.flatMap((e) => (e.type === "step_started" && e.attempt === 1 ? [e.kind] : []));
    expect(new Set(kinds)).toEqual(new Set(["model", "tool", "retrieval", "decision"]));
  });

  it("keeps the IDs written in the fixture, in sequence order", () => {
    const fixture = load();
    expect(fixture.events.map((event) => event.id)).toEqual(
      Array.from({ length: 18 }, (_, i) => `evt_refund8e${String(i).padStart(2, "0")}`),
    );
    expect(fixture.events.map((event) => event.sequence)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(raw().events.map((event) => [event.id, event.stepId])).toEqual(
      fixture.events.map((event) => [event.id, event.stepId]),
    );
  });

  it("gives the same events every time it is loaded", () => {
    expect(load()).toEqual(load());
    expect(JSON.stringify(load().events)).toBe(JSON.stringify(load().events));
  });

  it("removes every planted sensitive value and records where", () => {
    // Guard against the test going stale: the values really are in the file.
    for (const value of RAW_VALUES) expect(rawText).toContain(value);

    const fixture = load();
    const stored = JSON.stringify(fixture);
    for (const value of RAW_VALUES) expect(stored).not.toContain(value);

    const redactions = fixture.events.flatMap((event) => event.redactions.map((r) => `${event.sequence} ${r.path} ${r.reason}`));
    expect(redactions).toEqual([
      "0 input.message email",
      "0 input.message card_number",
      "0 input.message phone",
      "2 input.authorization secret",
      "4 input.authorization secret",
      "5 output.order.customer.email email",
      "5 output.order.customer.phone phone",
      "5 output.order.customer.dateOfBirth personal_id",
      "5 output.order.payment.cardNumber card_number",
      "12 input.apiKey secret",
      "12 input.note card_number",
      "14 input.to email",
      "16 input.contact email",
      "17 output.note email",
    ]);
  });

  it("keeps the non-sensitive content that a reviewer needs", () => {
    const [, classified, , , , lookedUp] = load().events as TraceEvent[];
    expect(classified).toMatchObject({ output: { intent: "refund_request", orderNumber: "A-2048" } });
    expect(lookedUp).toMatchObject({
      output: { order: { number: "A-2048", totalMinor: 4999, payment: { last4: "4444" } } },
    });
  });

  it("is already in its final form: redacting the stored events again changes nothing", () => {
    for (const event of load().events) {
      const input: Partial<TraceEvent> = { ...event };
      delete input.redactions;
      expect(redactTraceEvent(input as TraceEventInput)).toEqual({ ...event, redactions: [] });
    }
  });
});

describe("parseTraceFixture", () => {
  it("rejects unknown fields and malformed events with their paths", () => {
    const extra = { ...raw(), recordedBy: "someone" };
    expect(parseTraceFixture(extra)).toEqual({
      ok: false,
      issues: [{ path: "(root)", message: expect.stringMatching(/Unrecognized key/) }],
    });

    const badId = raw();
    badId.events[3] = { ...badId.events[3], id: "event-3" };
    const result = parseTraceFixture(badId);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(["events.3.id"]);
  });

  it("rejects a trace that breaks the trace rules or its own budget", () => {
    const gap = raw();
    gap.events.splice(6, 1);
    const gapResult = parseTraceFixture(gap);
    expect(!gapResult.ok && gapResult.issues[0]).toEqual({ path: "events.6.sequence", message: "expected sequence 6, got 7" });

    const tight = { ...raw(), budget: { maxSteps: 7, maxDurationMs: 10_000, maxRetries: 0 } };
    const tightResult = parseTraceFixture(tight);
    expect(!tightResult.ok && tightResult.issues.map((issue) => issue.message)).toEqual([
      "attempt 2 exceeds the retry budget of 0",
      "attempt 2 exceeds the retry budget of 0",
      "step step_auditsummary exceeds the budget of 7 steps",
    ]);
  });
});
