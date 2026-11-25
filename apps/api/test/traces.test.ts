import type { AgentVersionConfig, TraceEventInput } from "@agentledger/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { MAX_TRACE_BATCH } from "../src/routes/traces.js";
import { buildServer } from "../src/server.js";
import { InMemoryAgentStore, InMemoryRunStore, InMemoryTraceStore, InMemoryWorkspaceStore } from "../src/store/memory.js";
import { RunNotFoundError } from "../src/store/types.js";

const ACME = "ws_acmesupport";
const GLOBEX = "ws_globexops";

const tokens = {
  editor: "alk_editor00000000000000000000000000000000000000000",
  viewer: "alk_viewer00000000000000000000000000000000000000000",
  globex: "alk_globex00000000000000000000000000000000000000000",
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function workspaces() {
  const createdAt = new Date("2026-01-05T09:00:00.000Z");
  return new InMemoryWorkspaceStore()
    .addWorkspace({ id: ACME, slug: "acme-support", name: "Acme Support Agents", createdAt })
    .addWorkspace({ id: GLOBEX, slug: "globex-ops", name: "Globex Operations", createdAt })
    .addUser({ id: "usr_eli", email: "eli@example.test", displayName: "Eli" })
    .addUser({ id: "usr_vic", email: "vic@example.test", displayName: "Vic" })
    .addUser({ id: "usr_gus", email: "gus@example.test", displayName: "Gus" })
    .addMembership(ACME, "usr_eli", "editor")
    .addMembership(ACME, "usr_vic", "viewer")
    .addMembership(GLOBEX, "usr_gus", "admin")
    .addToken(hashToken(tokens.editor), "usr_eli")
    .addToken(hashToken(tokens.viewer), "usr_vic")
    .addToken(hashToken(tokens.globex), "usr_gus");
}

const config: AgentVersionConfig = {
  model: { provider: "fixture", name: "support-replay", temperature: 0, maxOutputTokens: 1024 },
  instructions: "Look up the order before answering.",
  tools: [{ name: "lookup_order", description: "Read an order.", sensitive: false }],
  budget: { maxSteps: 3, maxDurationMs: 60_000, maxRetries: 1 },
};

const evt = (sequence: number) => `evt_${String(sequence).padStart(6, "0")}`;

/** A two-step trace: a model step, then a tool lookup that sees customer data. */
const trace: TraceEventInput[] = [
  {
    id: evt(0),
    sequence: 0,
    type: "step_started",
    stepId: "step_planreply",
    attempt: 1,
    offsetMs: 0,
    index: 0,
    kind: "model",
    name: "Plan reply",
    input: { question: "Refund for order A-1001? Reply to dana.hill@example.test" },
  },
  { id: evt(1), sequence: 1, type: "step_finished", stepId: "step_planreply", attempt: 1, offsetMs: 180, status: "ok", output: { plan: "look up order" } },
  {
    id: evt(2),
    sequence: 2,
    type: "step_started",
    stepId: "step_lookuporder",
    attempt: 1,
    offsetMs: 180,
    index: 1,
    kind: "tool",
    name: "Look up order",
    tool: "lookup_order",
    input: { orderNumber: "A-1001", apiKey: "sk-test-AAAABBBBCCCCDDDD1234" },
  },
  {
    id: evt(3),
    sequence: 3,
    type: "step_finished",
    stepId: "step_lookuporder",
    attempt: 1,
    offsetMs: 420,
    status: "ok",
    output: { customer: { email: "dana.hill@example.test", phone: "+1 555 010 4477" }, card: "4111 1111 1111 1111", total: 4999 },
  },
];

const RAW_VALUES = ["dana.hill@example.test", "sk-test-AAAABBBBCCCCDDDD1234", "+1 555 010 4477", "4111 1111 1111 1111"];

describe("trace routes", () => {
  let app: ReturnType<typeof buildServer>;
  let runs: InMemoryRunStore;
  let traces: InMemoryTraceStore;
  let agentCount = 0;

  beforeEach(() => {
    runs = new InMemoryRunStore();
    traces = new InMemoryTraceStore(runs);
    app = buildServer({ store: workspaces(), agents: new InMemoryAgentStore(), runs, traces, logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  async function startRun(workspaceId = ACME, token = tokens.editor, status: "queued" | "running" = "running") {
    const agent = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/agents`,
      headers: auth(token),
      payload: { slug: `refund-assistant-${++agentCount}`, name: "Refund assistant" },
    });
    const agentId = agent.json().agent.id as string;
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/agents/${agentId}/versions`,
      headers: auth(token),
      payload: { config },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/runs`,
      headers: auth(token),
      payload: { agentId, input: { orderNumber: "A-1001" } },
    });
    const runId = res.json().run.id as string;
    if (status === "running") await runs.transitionRun({ workspaceId, runId, to: "running", at: new Date() });
    return runId;
  }

  function append(runId: string, events: unknown[], token = tokens.editor, workspaceId = ACME) {
    return app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/trace-events`,
      headers: auth(token),
      payload: { events },
    });
  }

  it("stores redacted events and returns them", async () => {
    const runId = await startRun();
    const res = await append(runId, trace);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ appended: 4, replayed: 0, nextSequence: 4 });
    expect(body.events[0]).toMatchObject({
      input: { question: "Refund for order A-1001? Reply to [REDACTED:email]" },
      redactions: [{ path: "input.question", reason: "email" }],
    });
    expect(body.events[2].input).toEqual({ orderNumber: "A-1001", apiKey: "[REDACTED:secret]" });
    expect(body.events[3].redactions).toEqual([
      { path: "output.customer.email", reason: "email" },
      { path: "output.customer.phone", reason: "phone" },
      { path: "output.card", reason: "card_number" },
    ]);

    const stored = await traces.listTraceEvents(ACME, runId);
    expect(stored.map((e) => e.id)).toEqual([evt(0), evt(1), evt(2), evt(3)]);
    const text = JSON.stringify(stored) + res.body;
    for (const raw of RAW_VALUES) expect(text).not.toContain(raw);
  });

  it("appends in batches and skips events that were already stored", async () => {
    const runId = await startRun();
    expect((await append(runId, trace.slice(0, 2))).statusCode).toBe(201);

    // A retried batch overlapping the stored events.
    const res = await append(runId, trace.slice(1));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ appended: 2, replayed: 1, nextSequence: 4 });

    const replay = await append(runId, trace);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ appended: 0, replayed: 4, nextSequence: 4, events: [] });
    expect(await traces.listTraceEvents(ACME, runId)).toHaveLength(4);
  });

  it("accepts a batch in any order", async () => {
    const runId = await startRun();
    const res = await append(runId, [...trace].reverse());
    expect(res.statusCode).toBe(201);
    expect(res.json().events.map((e: { sequence: number }) => e.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("rejects a stored sequence with different content and gaps in the sequence", async () => {
    const runId = await startRun();
    await append(runId, trace.slice(0, 2));

    const changed = await append(runId, [{ ...trace[1], offsetMs: 999 }]);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({ code: "trace_event_conflict", details: { nextSequence: 2 } });

    const gap = await append(runId, [trace[3]]);
    expect(gap.statusCode).toBe(409);
    expect(gap.json().error).toMatchObject({ code: "trace_sequence_gap", details: { nextSequence: 2 } });
  });

  it("rejects events that break the trace rules with the issues", async () => {
    const runId = await startRun();
    const res = await append(runId, [trace[0], { ...trace[2], sequence: 1, index: 3 }]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: "invalid_trace",
      details: [{ path: "events.1.index", message: "expected step index 1, got 3" }],
    });
    expect(await traces.listTraceEvents(ACME, runId)).toEqual([]);
  });

  it("enforces the run's step budget", async () => {
    const runId = await startRun();
    const steps = [0, 1, 2, 3].flatMap((i) => [
      { ...trace[0], id: evt(i * 2), sequence: i * 2, stepId: `step_budget${i}`, index: i, offsetMs: i * 10 },
      { ...trace[1], id: evt(i * 2 + 1), sequence: i * 2 + 1, stepId: `step_budget${i}`, offsetMs: i * 10 + 5 },
    ]);
    const res = await append(runId, steps);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual([{ path: "events.6", message: "step step_budget3 exceeds the budget of 3 steps" }]);
  });

  it("only takes new events while the run is running or paused", async () => {
    const queued = await startRun(ACME, tokens.editor, "queued");
    const res = await append(queued, trace.slice(0, 1));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("run_not_accepting_trace");

    const runId = await startRun();
    await append(runId, trace.slice(0, 2));
    await runs.transitionRun({ workspaceId: ACME, runId, to: "succeeded", at: new Date() });
    expect((await append(runId, trace.slice(2))).json().error.code).toBe("run_not_accepting_trace");
    // Retrying an already stored batch still succeeds after the run ended.
    expect((await append(runId, trace.slice(0, 2))).statusCode).toBe(200);
  });

  it("validates the request body before storing anything", async () => {
    const runId = await startRun();
    const cases: unknown[][] = [
      [],
      [{ ...trace[0], prompt: "raw prompt" }],
      [{ ...trace[2], tool: undefined }],
      [{ ...trace[0], input: { blob: "x".repeat(17_000) } }],
      Array.from({ length: MAX_TRACE_BATCH + 1 }, (_, i) => ({ ...trace[0], sequence: i })),
    ];
    for (const events of cases) {
      const res = await append(runId, events);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
    expect(await traces.listTraceEvents(ACME, runId)).toEqual([]);
  });

  it("needs the editor role and hides other workspaces' runs", async () => {
    const runId = await startRun();
    expect((await append(runId, trace, tokens.viewer)).statusCode).toBe(403);
    expect((await append(runId, trace, tokens.globex, GLOBEX)).json().error.code).toBe("run_not_found");
    expect((await append(runId, trace, tokens.globex)).statusCode).toBe(404);
    expect((await append("run_missing00", trace)).json().error.code).toBe("run_not_found");
    expect((await append("not-a-run", trace)).statusCode).toBe(404);
    expect((await append(runId, trace, "alk_nope")).statusCode).toBe(401);
    expect(await traces.listTraceEvents(ACME, runId)).toEqual([]);
  });

  it("scopes the store by workspace", async () => {
    const runId = await startRun();
    await append(runId, trace);
    expect(await traces.listTraceEvents(GLOBEX, runId)).toEqual([]);
    await expect(traces.appendTraceEvents({ workspaceId: GLOBEX, runId, events: [] })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
