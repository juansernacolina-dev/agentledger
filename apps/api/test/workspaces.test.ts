import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasRole } from "../src/auth/roles.js";
import { hashToken, readBearerToken } from "../src/auth/tokens.js";
import { buildServer } from "../src/server.js";
import { InMemoryAgentStore, InMemoryRunStore, InMemoryTraceStore, InMemoryWorkspaceStore } from "../src/store/memory.js";

const ACME = "ws_acmesupport";
const GLOBEX = "ws_globexops";

const tokens = {
  admin: "alk_admin000000000000000000000000000000000000000000",
  viewer: "alk_viewer00000000000000000000000000000000000000000",
  globex: "alk_globex00000000000000000000000000000000000000000",
  revoked: "alk_revoked0000000000000000000000000000000000000000",
};

function seededStore() {
  const createdAt = new Date("2026-01-05T09:00:00.000Z");
  return new InMemoryWorkspaceStore()
    .addWorkspace({ id: ACME, slug: "acme-support", name: "Acme Support Agents", createdAt })
    .addWorkspace({ id: GLOBEX, slug: "globex-ops", name: "Globex Operations", createdAt })
    .addUser({ id: "usr_ava", email: "ava@example.test", displayName: "Ava" })
    .addUser({ id: "usr_vic", email: "vic@example.test", displayName: "Vic" })
    .addUser({ id: "usr_gus", email: "gus@example.test", displayName: "Gus" })
    .addMembership(ACME, "usr_ava", "admin")
    .addMembership(ACME, "usr_vic", "viewer")
    .addMembership(GLOBEX, "usr_gus", "admin")
    .addToken(hashToken(tokens.admin), "usr_ava")
    .addToken(hashToken(tokens.viewer), "usr_vic")
    .addToken(hashToken(tokens.globex), "usr_gus")
    .addToken(hashToken(tokens.revoked), "usr_ava", true);
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function withRuns() {
  const runs = new InMemoryRunStore();
  return { runs, traces: new InMemoryTraceStore(runs) };
}

describe("roles", () => {
  it("orders roles from viewer to admin", () => {
    expect(hasRole("admin", "editor")).toBe(true);
    expect(hasRole("editor", "editor")).toBe(true);
    expect(hasRole("reviewer", "editor")).toBe(false);
    expect(hasRole("viewer", "reviewer")).toBe(false);
  });
});

describe("readBearerToken", () => {
  it("accepts only bearer tokens with the AgentLedger prefix", () => {
    expect(readBearerToken(`Bearer ${tokens.admin}`)).toBe(tokens.admin);
    expect(readBearerToken(`bearer ${tokens.admin}`)).toBe(tokens.admin);
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken(`Basic ${tokens.admin}`)).toBeNull();
    expect(readBearerToken("Bearer sk-something-else")).toBeNull();
  });
});

describe("workspace routes", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer({
      store: seededStore(),
      agents: new InMemoryAgentStore(),
      ...withRuns(),
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps /health public", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it.each([
    ["no header", {}],
    ["unknown token", auth("alk_unknown000000000000000000000000000000000000000")],
    ["revoked token", auth(tokens.revoked)],
  ])("rejects requests with %s", async (_label, headers) => {
    const res = await app.inject({ method: "GET", url: "/v1/workspaces", headers });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("lists only the caller's workspaces with their role", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/workspaces", headers: auth(tokens.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspaces: [
        {
          id: ACME,
          slug: "acme-support",
          name: "Acme Support Agents",
          createdAt: "2026-01-05T09:00:00.000Z",
          role: "viewer",
        },
      ],
    });
  });

  it("returns a workspace to its members", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/workspaces/${ACME}`, headers: auth(tokens.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toMatchObject({ id: ACME, role: "viewer" });
  });

  it("hides other tenants' workspaces behind the same 404 as unknown ones", async () => {
    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${GLOBEX}`,
      headers: auth(tokens.admin),
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/v1/workspaces/ws_doesnotexist",
      headers: auth(tokens.admin),
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/v1/workspaces/not-an-id",
      headers: auth(tokens.admin),
    });
    for (const res of [otherTenant, unknown, malformed]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "workspace_not_found", message: "Workspace not found." } });
    }
  });

  it("authenticates before resolving a workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/workspaces/not-an-id" });
    expect(res.statusCode).toBe(401);
  });

  it("lets admins list members and forbids lower roles", async () => {
    const asAdmin = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/members`,
      headers: auth(tokens.admin),
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().members).toEqual([
      { userId: "usr_ava", email: "ava@example.test", displayName: "Ava", role: "admin" },
      { userId: "usr_vic", email: "vic@example.test", displayName: "Vic", role: "viewer" },
    ]);

    const asViewer = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ACME}/members`,
      headers: auth(tokens.viewer),
    });
    expect(asViewer.statusCode).toBe(403);
    expect(asViewer.json().error.code).toBe("forbidden");
  });

  it("creates a workspace and makes the creator its admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: auth(tokens.globex),
      payload: { slug: "globex-labs", name: "Globex Labs" },
    });
    expect(res.statusCode).toBe(201);
    const { workspace } = res.json();
    expect(workspace).toMatchObject({ slug: "globex-labs", name: "Globex Labs", role: "admin" });
    expect(workspace.id).toMatch(/^ws_[a-f0-9]{16}$/);

    const list = await app.inject({ method: "GET", url: "/v1/workspaces", headers: auth(tokens.globex) });
    expect(list.json().workspaces.map((w: { slug: string }) => w.slug)).toEqual(["globex-labs", "globex-ops"]);
  });

  it("rejects a taken slug with 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: auth(tokens.admin),
      payload: { slug: "globex-ops", name: "Copy" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("slug_taken");
  });

  it("validates the request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: auth(tokens.admin),
      payload: { slug: "Bad Slug!", name: "", role: "admin" },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details.map((d: { path: string }) => d.path).sort()).toEqual(["", "name", "slug"]);
  });
});
