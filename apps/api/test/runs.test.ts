import { parseRun, type AgentVersionConfig } from "@agentledger/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { decodeCursor, encodeCursor, MAX_RUN_INPUT_BYTES } from "../src/routes/runs.js";
import { applyTransition } from "../src/runs/lifecycle.js";
import { buildServer } from "../src/server.js";
import { InMemoryAgentStore, InMemoryRunStore, InMemoryTraceStore, InMemoryWorkspaceStore } from "../src/store/memory.js";
import { InvalidRunTransitionError, RunNotFoundError, type AgentVersionRecord } from "../src/store/types.js";

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

const config = (overrides: Partial<AgentVersionConfig> = {}): AgentVersionConfig => ({
  model: { provider: "fixture", name: "support-replay", temperature: 0, maxOutputTokens: 1024 },
  instructions: "Look up the order before answering.",
  tools: [{ name: "lookup_order", description: "Read an order.", sensitive: false }],
  budget: { maxSteps: 12, maxDurationMs: 60_000, maxRetries: 2 },
  ...overrides,
});

describe("run routes", () => {
  let app: ReturnType<typeof buildServer>;
  let runs: InMemoryRunStore;

  beforeEach(() => {
    runs = new InMemoryRunStore();
    app = buildServer({
      store: workspaces(),
      agents: new InMemoryAgentStore(),
      runs,
      traces: new InMemoryTraceStore(runs),
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAgent(workspaceId = ACME, token = tokens.editor) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/agents`,
      headers: auth(token),
      payload: { slug: "refund-assistant", name: "Refund assistant" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().agent.id as string;
  }

  async function publish(agentId: string, versionConfig: AgentVersionConfig, workspaceId = ACME, token = tokens.editor) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/agents/${agentId}/versions`,
      headers: auth(token),
      payload: { config: versionConfig },
    });
    expect(res.statusCode).toBe(201);
    return res.json().version as Omit<AgentVersionRecord, "workspaceId">;
  }

  function startRun(payload: object, token = tokens.editor, workspaceId = ACME) {
    return app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/runs`, headers: auth(token), payload });
  }

  it("queues a run on the latest version in the shared contract shape", async () => {
    const agentId = await createAgent();
    await publish(agentId, config());
    const v2 = await publish(agentId, config({ budget: { maxSteps: 6, maxDurationMs: 20_000, maxRetries: 1 } }));

    const res = await startRun({ agentId, input: { orderNumber: "A-1001", question: "Where is my refund?" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run.id).toMatch(/^run_[a-f0-9]{16}$/);
    expect(body.run).toMatchObject({
      workspaceId: ACME,
      agent: { definitionId: agentId, versionId: v2.id, version: 2 },
      status: "queued",
      timingSource: "fixture",
      budget: { maxSteps: 6, maxDurationMs: 20_000, maxRetries: 1 },
      steps: [],
    });
    expect(body.run.finishedAt).toBeUndefined();
    expect(body.lifecycle).toEqual({ createdById: "usr_eli", startedAt: null, failureReason: null });
    expect(body.input).toEqual({ orderNumber: "A-1001", question: "Where is my refund?" });
    expect(parseRun(body.run)).toEqual({ ok: true, run: body.run });
  });

  it("keeps a run linked to the version it was started on", async () => {
    const agentId = await createAgent();
    const v1 = await publish(agentId, config());
    await publish(agentId, config({ instructions: "Be brief." }));

    const created = await startRun({ agentId, version: 1, input: {} });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;

    await publish(agentId, config({ instructions: "Be even briefer." }));
    const res = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs/${runId}`, headers: auth(tokens.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.agent).toEqual({ definitionId: agentId, versionId: v1.id, version: 1 });
    expect(res.json().run.budget).toEqual(config().budget);
  });

  it("labels runs of hosted models as measured", async () => {
    const agentId = await createAgent();
    await publish(agentId, config({ model: { provider: "anthropic", name: "claude-test", temperature: 0, maxOutputTokens: 512 } }));
    const res = await startRun({ agentId, input: {} });
    expect(res.json().run.timingSource).toBe("measured");
  });

  it("explains why a run cannot start", async () => {
    const agentId = await createAgent();
    const noVersion = await startRun({ agentId, input: {} });
    expect(noVersion.statusCode).toBe(409);
    expect(noVersion.json().error.code).toBe("agent_has_no_versions");

    await publish(agentId, config());
    const missing = await startRun({ agentId, version: 9, input: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("version_not_found");

    const unknownAgent = await startRun({ agentId: "agt_0000000000000000", input: {} });
    expect(unknownAgent.statusCode).toBe(404);
    expect(unknownAgent.json().error.code).toBe("agent_not_found");
  });

  it("validates the request body", async () => {
    const agentId = await createAgent();
    await publish(agentId, config());

    for (const payload of [
      { agentId, input: "not an object" },
      { agentId, input: {}, status: "succeeded" },
      { agentId, input: { text: "x".repeat(MAX_RUN_INPUT_BYTES) } },
      { agentId: "not-an-id", input: {} },
    ]) {
      const res = await startRun(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("lets only editors start or cancel runs", async () => {
    const agentId = await createAgent();
    await publish(agentId, config());

    const viewerStart = await startRun({ agentId, input: {} }, tokens.viewer);
    expect(viewerStart.statusCode).toBe(403);

    const runId = (await startRun({ agentId, input: {} })).json().run.id as string;
    const viewerCancel = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ACME}/runs/${runId}/cancel`,
      headers: auth(tokens.viewer),
    });
    expect(viewerCancel.statusCode).toBe(403);
  });

  it("keeps runs and agents inside their workspace", async () => {
    const acmeAgent = await createAgent();
    await publish(acmeAgent, config());
    const runId = (await startRun({ agentId: acmeAgent, input: {} })).json().run.id as string;

    // Globex cannot see Acme, nor reach Acme's run or agent through its own workspace.
    const direct = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs/${runId}`, headers: auth(tokens.globex) });
    expect(direct.statusCode).toBe(404);
    expect(direct.json().error.code).toBe("workspace_not_found");

    const viaGlobex = await app.inject({ method: "GET", url: `/v1/workspaces/${GLOBEX}/runs/${runId}`, headers: auth(tokens.globex) });
    expect(viaGlobex.statusCode).toBe(404);
    expect(viaGlobex.json().error.code).toBe("run_not_found");

    const crossStart = await startRun({ agentId: acmeAgent, input: {} }, tokens.globex, GLOBEX);
    expect(crossStart.statusCode).toBe(404);
    expect(crossStart.json().error.code).toBe("agent_not_found");

    const globexList = await app.inject({ method: "GET", url: `/v1/workspaces/${GLOBEX}/runs`, headers: auth(tokens.globex) });
    expect(globexList.json().runs).toEqual([]);

    const malformed = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs/nope`, headers: auth(tokens.viewer) });
    expect(malformed.statusCode).toBe(404);
  });

  it("cancels a queued run once", async () => {
    const agentId = await createAgent();
    await publish(agentId, config());
    const runId = (await startRun({ agentId, input: {} })).json().run.id as string;
    const cancel = () =>
      app.inject({ method: "POST", url: `/v1/workspaces/${ACME}/runs/${runId}/cancel`, headers: auth(tokens.editor) });

    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json().run.status).toBe("cancelled");
    expect(first.json().run.finishedAt).toEqual(expect.any(String));
    expect(parseRun(first.json().run).ok).toBe(true);

    const second = await cancel();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("invalid_run_transition");
  });

  it("lists runs newest first with filters and stable cursor paging", async () => {
    const agentId = await createAgent();
    const version = await publish(agentId, config());
    const same = new Date("2026-02-01T10:00:00.000Z");
    const ids = ["run_aaaa000001", "run_aaaa000002", "run_aaaa000003", "run_aaaa000004", "run_aaaa000005"];
    for (const [index, id] of ids.entries()) {
      await runs.createRun({
        id,
        version: { ...version, workspaceId: ACME },
        timingSource: "fixture",
        budget: config().budget,
        input: {},
        createdById: "usr_eli",
        // Two pairs share a timestamp, so paging must fall back to the id.
        createdAt: index < 4 ? new Date(same.getTime() + Math.floor(index / 2) * 1000) : new Date("2026-02-02T00:00:00.000Z"),
      });
    }
    await runs.transitionRun({ workspaceId: ACME, runId: ids[1], to: "cancelled", at: new Date("2026-02-03T00:00:00.000Z") });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/workspaces/${ACME}/runs?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const page = await app.inject({ method: "GET", url, headers: auth(tokens.viewer) });
      expect(page.statusCode).toBe(200);
      seen.push(...page.json().runs.map((item: { run: { id: string } }) => item.run.id));
      cursor = page.json().nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(["run_aaaa000005", "run_aaaa000004", "run_aaaa000003", "run_aaaa000002", "run_aaaa000001"]);

    const cancelled = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/runs?status=cancelled&agentId=${agentId}`,
      headers: auth(tokens.viewer),
    });
    expect(cancelled.json().runs.map((item: { run: { id: string } }) => item.run.id)).toEqual(["run_aaaa000002"]);
    expect(cancelled.json().runs[0].input).toBeUndefined();

    const bad = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs?cursor=garbage`, headers: auth(tokens.viewer) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_cursor");

    const tooMany = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/runs?limit=500`, headers: auth(tokens.viewer) });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe("run cursors", () => {
  it("round-trips and rejects tampered values", () => {
    const run = { createdAt: new Date("2026-02-01T10:00:00.000Z"), id: "run_abcdef123456" };
    expect(decodeCursor(encodeCursor(run))).toEqual(run);
    expect(decodeCursor(Buffer.from('["yesterday","run_abcdef123456"]').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('["2026-02-01T10:00:00.000Z","agt_abcdef123456"]').toString("base64url"))).toBeNull();
  });
});

describe("run lifecycle", () => {
  const queued = { status: "queued", startedAt: null, finishedAt: null, failureReason: null } as const;
  const t = (minute: number) => new Date(Date.UTC(2026, 1, 1, 10, minute));

  it("stamps startedAt once and finishedAt at the end", () => {
    const running = applyTransition(queued, { to: "running", at: t(1) });
    expect(running).toEqual({ status: "running", startedAt: t(1), finishedAt: null, failureReason: null });
    const paused = applyTransition(running, { to: "paused", at: t(2) });
    const resumed = applyTransition(paused, { to: "running", at: t(3) });
    expect(resumed.startedAt).toEqual(t(1));
    const done = applyTransition(resumed, { to: "succeeded", at: t(4) });
    expect(done).toEqual({ status: "succeeded", startedAt: t(1), finishedAt: t(4), failureReason: null });
  });

  it("requires a reason for failures only", () => {
    const running = applyTransition(queued, { to: "running", at: t(1) });
    expect(() => applyTransition(running, { to: "failed", at: t(2) })).toThrow(/failure reason/);
    expect(() => applyTransition(running, { to: "succeeded", at: t(2), failureReason: "x" })).toThrow(/only failed/);
    expect(applyTransition(running, { to: "failed", at: t(2), failureReason: "budget exceeded" }).failureReason).toBe(
      "budget exceeded",
    );
  });

  it("rejects moves the contract does not allow", () => {
    expect(() => applyTransition(queued, { to: "succeeded", at: t(1) })).toThrow(InvalidRunTransitionError);
    const done = { status: "succeeded", startedAt: t(1), finishedAt: t(2), failureReason: null } as const;
    expect(() => applyTransition(done, { to: "running", at: t(3) })).toThrow(InvalidRunTransitionError);
  });

  it("does not move runs of another workspace", async () => {
    const store = new InMemoryRunStore();
    await store.createRun({
      id: "run_scoped0001",
      version: { id: "agv_v1", workspaceId: ACME, agentId: "agt_a", version: 1 },
      timingSource: "fixture",
      budget: config().budget,
      input: {},
      createdById: "usr_eli",
      createdAt: t(0),
    });
    await expect(store.transitionRun({ workspaceId: GLOBEX, runId: "run_scoped0001", to: "running", at: t(1) })).rejects.toThrow(
      RunNotFoundError,
    );
    expect((await store.findRun(ACME, "run_scoped0001"))?.status).toBe("queued");
  });
});
