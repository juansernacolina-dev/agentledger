import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AgentVersionConfig, RunBudget, TraceEvent } from "@agentledger/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashConfig } from "../src/agents/config-hash.js";
import { hashToken } from "../src/auth/tokens.js";
import { buildServer } from "../src/server.js";
import { InMemoryAgentStore, InMemoryRunStore, InMemoryTraceStore, InMemoryWorkspaceStore } from "../src/store/memory.js";
import { InvalidTraceError } from "../src/store/types.js";
import { loadTraceFixture, readTraceFixture, traceOutcome } from "../src/traces/fixture.js";

const ACME = "ws_acmesupport";
const EDITOR_TOKEN = "alk_editor00000000000000000000000000000000000000000";
const auth = { authorization: `Bearer ${EDITOR_TOKEN}` };

const fixture = readTraceFixture("refund-eight-steps");
const rawFixture = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@agentledger/contracts/fixtures/traces/refund-eight-steps.json"), "utf8"),
) as { events: unknown[] };

const FIXTURE_EVENT_IDS = Array.from({ length: 18 }, (_, i) => `evt_refund8e${String(i).padStart(2, "0")}`);

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

const config = (budget: RunBudget): AgentVersionConfig => ({
  model: { provider: "fixture", name: "support-replay", temperature: 0, maxOutputTokens: 1024 },
  instructions: "Look up the order before answering.",
  tools: [
    { name: "lookup_order", description: "Read an order.", sensitive: false },
    { name: "issue_refund", description: "Refund an order.", sensitive: true },
  ],
  budget,
});

const startedAt = new Date("2026-01-15T09:00:00.250Z");

describe("refund-eight-steps fixture in the API", () => {
  let agents: InMemoryAgentStore;
  let runs: InMemoryRunStore;
  let traces: InMemoryTraceStore;
  let app: ReturnType<typeof buildServer>;
  let runCount = 0;

  beforeEach(() => {
    const workspaces = new InMemoryWorkspaceStore()
      .addWorkspace({ id: ACME, slug: "acme-support", name: "Acme Support Agents", createdAt: new Date("2026-01-05T09:00:00.000Z") })
      .addUser({ id: "usr_eli", email: "eli@example.test", displayName: "Eli" })
      .addMembership(ACME, "usr_eli", "editor")
      .addToken(hashToken(EDITOR_TOKEN), "usr_eli");
    agents = new InMemoryAgentStore();
    runs = new InMemoryRunStore();
    traces = new InMemoryTraceStore(runs);
    app = buildServer({ store: workspaces, agents, runs, traces, logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRun(budget: RunBudget = { maxSteps: 12, maxDurationMs: 60_000, maxRetries: 2 }) {
    runCount += 1;
    const agent = await agents.createAgent({
      id: `agt_refunds${runCount}x`,
      workspaceId: ACME,
      slug: `refund-assistant-${runCount}`,
      name: "Refund assistant",
      description: null,
      createdById: "usr_eli",
    });
    const versionConfig = config(budget);
    const version = await agents.publishVersion({
      id: `agv_refunds${runCount}x`,
      workspaceId: ACME,
      agentId: agent.id,
      config: versionConfig,
      configHash: hashConfig(versionConfig),
      notes: null,
      createdById: "usr_eli",
    });
    const run = await runs.createRun({
      id: `run_fixture${runCount}x`,
      version,
      timingSource: "fixture",
      budget,
      input: fixture.input,
      createdById: "usr_eli",
      createdAt: new Date("2026-01-15T09:00:00.000Z"),
    });
    return run.id;
  }

  const load = (runId: string) => loadTraceFixture({ runs, traces }, { workspaceId: ACME, runId, fixture, startedAt });

  it("loads eight steps with the fixture's IDs and finishes the run", async () => {
    const runId = await createRun();
    const result = await load(runId);
    expect(result).toMatchObject({ appended: 18, replayed: 0 });
    expect(result.run).toMatchObject({
      status: "succeeded",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 5630),
      timingSource: "fixture",
    });

    const stored = await traces.listTraceEvents(ACME, runId);
    expect(stored.map((event) => event.id)).toEqual(FIXTURE_EVENT_IDS);
    expect(new Set(stored.map((event) => event.stepId)).size).toBe(8);
    expect(stored).toEqual(fixture.events);
  });

  it("is a no-op when loaded again", async () => {
    const runId = await createRun();
    await load(runId);
    const again = await load(runId);
    expect(again).toMatchObject({ appended: 0, replayed: 18, run: { status: "succeeded" } });
    expect(await traces.listTraceEvents(ACME, runId)).toEqual(fixture.events);
  });

  it("gives every run the same event and step IDs", async () => {
    const first = await createRun();
    const second = await createRun();
    await load(first);
    await load(second);
    expect(await traces.listTraceEvents(ACME, second)).toEqual(await traces.listTraceEvents(ACME, first));
  });

  it("stores the same events when a worker posts the raw fixture to the API", async () => {
    const runId = await createRun();
    await runs.transitionRun({ workspaceId: ACME, runId, to: "running", at: startedAt });
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ACME}/runs/${runId}/trace-events`,
      headers: auth,
      payload: { events: rawFixture.events },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ appended: 18, nextSequence: 18 });
    expect(await traces.listTraceEvents(ACME, runId)).toEqual(fixture.events);
  });

  it("keeps raw sensitive values out of storage and API responses", async () => {
    for (const value of RAW_VALUES) expect(JSON.stringify(rawFixture)).toContain(value);

    const runId = await createRun();
    await load(runId);
    const stored = (await traces.listTraceEvents(ACME, runId)) as TraceEvent[];
    const run = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs/${runId}`, headers: auth });
    expect(run.statusCode).toBe(200);

    const text = JSON.stringify(stored) + run.body;
    for (const value of RAW_VALUES) expect(text).not.toContain(value);
    expect(stored.reduce((count, event) => count + event.redactions.length, 0)).toBe(14);
  });

  it("leaves the run untouched when the fixture does not fit its budget", async () => {
    const runId = await createRun({ maxSteps: 6, maxDurationMs: 20_000, maxRetries: 1 });
    await expect(load(runId)).rejects.toBeInstanceOf(InvalidTraceError);
    expect(await runs.findRun(ACME, runId)).toMatchObject({ status: "queued", startedAt: null });
    expect(await traces.listTraceEvents(ACME, runId)).toEqual([]);
  });
});

describe("traceOutcome", () => {
  const events = fixture.events;

  it("follows each step's last attempt", () => {
    expect(traceOutcome(events)).toEqual({ status: "succeeded" });
    // Up to the lookup's first, failed attempt.
    expect(traceOutcome(events.slice(0, 4))).toEqual({
      status: "failed",
      failureReason: "order service timed out after 300 ms",
    });
    expect(traceOutcome(events.slice(0, 5))).toEqual({ status: "running" });
  });

  it("pauses on a step waiting for approval", () => {
    const waiting = events.slice(0, 12).map((event) =>
      event.sequence === 11 && event.type === "step_finished"
        ? { ...event, status: "pending_approval" as const, output: { requiresHumanApproval: true } }
        : event,
    );
    expect(traceOutcome(waiting)).toEqual({ status: "paused" });
  });
});
