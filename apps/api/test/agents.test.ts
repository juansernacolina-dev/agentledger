import type { AgentVersionConfig } from "@agentledger/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, hashConfig } from "../src/agents/config-hash.js";
import { hashToken } from "../src/auth/tokens.js";
import { buildServer } from "../src/server.js";
import { InMemoryAgentStore, InMemoryRunStore, InMemoryWorkspaceStore } from "../src/store/memory.js";

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

describe("config hash", () => {
  it("ignores key order but not array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(hashConfig({ a: 1, b: 2 })).toBe(hashConfig({ b: 2, a: 1 }));
    expect(hashConfig([1, 2])).not.toBe(hashConfig([2, 1]));
    expect(hashConfig(config())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("agent routes", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer({
      store: workspaces(),
      agents: new InMemoryAgentStore(),
      runs: new InMemoryRunStore(),
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
    return res.json().agent as { id: string; latestVersion: number | null };
  }

  function publish(agentId: string, payload: object, token = tokens.editor, workspaceId = ACME) {
    return app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/agents/${agentId}/versions`,
      headers: auth(token),
      payload,
    });
  }

  it("lets editors create agents and lists them to viewers", async () => {
    const agent = await createAgent();
    expect(agent.id).toMatch(/^agt_[a-f0-9]{16}$/);
    expect(agent.latestVersion).toBeNull();

    const list = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}/agents`, headers: auth(tokens.viewer) });
    expect(list.statusCode).toBe(200);
    expect(list.json().agents).toEqual([
      expect.objectContaining({ id: agent.id, slug: "refund-assistant", description: null, latestVersion: null }),
    ]);
  });

  it("forbids viewers from creating agents or publishing versions", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ACME}/agents`,
      headers: auth(tokens.viewer),
      payload: { slug: "viewer-agent", name: "Nope" },
    });
    expect(created.statusCode).toBe(403);

    const agent = await createAgent();
    const published = await publish(agent.id, { config: config() }, tokens.viewer);
    expect(published.statusCode).toBe(403);
    expect(published.json().error.code).toBe("forbidden");
  });

  it("rejects a duplicate slug within a workspace but not across workspaces", async () => {
    await createAgent();
    const again = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ACME}/agents`,
      headers: auth(tokens.editor),
      payload: { slug: "refund-assistant", name: "Copy" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("agent_slug_taken");

    await createAgent(GLOBEX, tokens.globex);
  });

  it("numbers versions 1, 2, 3 and keeps every config", async () => {
    const agent = await createAgent();
    const v1 = await publish(agent.id, { config: config(), notes: "first" });
    expect(v1.statusCode).toBe(201);
    expect(v1.json().version).toMatchObject({
      agentId: agent.id,
      version: 1,
      notes: "first",
      createdById: "usr_eli",
      configHash: hashConfig(config()),
    });
    expect(v1.json().version.id).toMatch(/^agv_[a-f0-9]{16}$/);

    await publish(agent.id, { config: config({ instructions: "Be brief." }) });
    const v3 = await publish(agent.id, { config: config({ tools: [] }) });
    expect(v3.json().version.version).toBe(3);

    const list = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/agents/${agent.id}/versions`,
      headers: auth(tokens.viewer),
    });
    expect(list.json().versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(list.json().versions[0]).not.toHaveProperty("config");

    const first = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/agents/${agent.id}/versions/1`,
      headers: auth(tokens.viewer),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version.config).toEqual(config());

    const detail = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/agents/${agent.id}`,
      headers: auth(tokens.viewer),
    });
    expect(detail.json().agent.latestVersion).toBe(3);
  });

  it("refuses to publish a config identical to the latest version", async () => {
    const agent = await createAgent();
    await publish(agent.id, { config: config() });
    // Same content, different key order: still unchanged.
    const reordered = { budget: config().budget, tools: config().tools, instructions: config().instructions, model: config().model };
    const res = await publish(agent.id, { config: reordered });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("version_unchanged");

    // Going back to an older config is a real change and gets a new number.
    await publish(agent.id, { config: config({ instructions: "Be brief." }) });
    const back = await publish(agent.id, { config: config() });
    expect(back.json().version.version).toBe(3);
  });

  it("rejects a publish based on a stale latest version", async () => {
    const agent = await createAgent();
    const first = await publish(agent.id, { config: config(), expectedLatestVersion: null });
    expect(first.statusCode).toBe(201);

    const stale = await publish(agent.id, { config: config({ instructions: "Other." }), expectedLatestVersion: null });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");

    const current = await publish(agent.id, { config: config({ instructions: "Other." }), expectedLatestVersion: 1 });
    expect(current.json().version.version).toBe(2);
  });

  it("validates the config against the shared contract", async () => {
    const agent = await createAgent();
    const res = await publish(agent.id, {
      config: { ...config(), budget: { maxSteps: 0, maxDurationMs: 1000, maxRetries: 1 }, secret: "x" },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["config", "config.budget.maxSteps"]));
  });

  it("answers PUT, PATCH and DELETE on a version with 405 and leaves it unchanged", async () => {
    const agent = await createAgent();
    await publish(agent.id, { config: config() });
    const url = `/v1/workspaces/${ACME}/agents/${agent.id}/versions/1`;

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url, headers: auth(tokens.editor), payload: { config: config({ tools: [] }) } });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
      expect(res.json().error.code).toBe("version_immutable");
    }

    const after = await app.inject({ method: "GET", url, headers: auth(tokens.viewer) });
    expect(after.json().version.config).toEqual(config());
  });

  it("does not let callers mutate stored versions through returned records", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.createAgent({
      id: "agt_store000001",
      workspaceId: ACME,
      slug: "store-test",
      name: "Store test",
      description: null,
      createdById: "usr_eli",
    });
    const input = config();
    const published = await store.publishVersion({
      id: "agv_store000001",
      workspaceId: ACME,
      agentId: agent.id,
      config: input,
      configHash: hashConfig(input),
      notes: null,
      createdById: "usr_eli",
    });
    input.instructions = "changed after publishing";
    published.config.tools.length = 0;

    const stored = await store.findVersion(ACME, agent.id, 1);
    expect(stored?.config).toEqual(config());
  });

  it("hides other workspaces' agents behind the same 404 as unknown ones", async () => {
    const globexAgent = await createAgent(GLOBEX, tokens.globex);
    const acmeAgent = await createAgent();

    for (const agentId of [globexAgent.id, "agt_doesnotexist", "not-an-id"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${ACME}/agents/${agentId}`,
        headers: auth(tokens.editor),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "agent_not_found", message: "Agent not found." } });
    }

    // Publishing into another workspace's agent through your own workspace fails too.
    const crossPublish = await publish(globexAgent.id, { config: config() });
    expect(crossPublish.statusCode).toBe(404);

    // Non-members cannot see the workspace at all, even for immutable-version probes.
    const otherTenant = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${ACME}/agents/${acmeAgent.id}/versions/1`,
      headers: auth(tokens.globex),
    });
    expect(otherTenant.statusCode).toBe(404);
    expect(otherTenant.json().error.code).toBe("workspace_not_found");
  });

  it.each(["0", "-1", "1.5", "abc", "01", "99"])("answers version %s with version_not_found", async (version) => {
    const agent = await createAgent();
    await publish(agent.id, { config: config() });
    const res = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/agents/${agent.id}/versions/${version}`,
      headers: auth(tokens.viewer),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("version_not_found");
  });
});
