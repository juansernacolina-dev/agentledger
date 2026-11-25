import {
  AgentDefinitionIdSchema,
  AgentSlugSchema,
  AgentVersionConfigSchema,
} from "@agentledger/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashConfig } from "../agents/config-hash.js";
import { requireMembership } from "../auth/access.js";
import type { WorkspaceRole } from "../auth/roles.js";
import { agentNotFound, HttpError, versionNotFound } from "../errors.js";
import { newId } from "../ids.js";
import {
  AgentSlugTakenError,
  VersionConflictError,
  VersionUnchangedError,
  type AgentRecord,
  type AgentStore,
  type AgentVersionRecord,
  type WorkspaceStore,
} from "../store/types.js";
import { parseWorkspaceId } from "./workspaces.js";

const CreateAgentBody = z
  .object({
    slug: AgentSlugSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const PublishVersionBody = z
  .object({
    config: AgentVersionConfigSchema,
    notes: z.string().trim().min(1).max(1000).optional(),
    /** Optimistic check: the version the caller last saw (null = none yet). */
    expectedLatestVersion: z.number().int().min(1).nullable().optional(),
  })
  .strict();

const AgentParams = z.object({ workspaceId: z.string(), agentId: z.string() });
const VersionParams = AgentParams.extend({ version: z.string() });

function toAgentView(agent: AgentRecord) {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    createdAt: agent.createdAt.toISOString(),
    latestVersion: agent.latestVersion,
  };
}

function toVersionSummary(version: AgentVersionRecord) {
  return {
    id: version.id,
    agentId: version.agentId,
    version: version.version,
    configHash: version.configHash,
    notes: version.notes,
    createdById: version.createdById,
    createdAt: version.createdAt.toISOString(),
  };
}

const toVersionView = (version: AgentVersionRecord) => ({
  ...toVersionSummary(version),
  config: version.config,
});

/** Version numbers in URLs are positive integers; anything else is not found. */
function parseVersionNumber(raw: string): number | null {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

export function registerAgentRoutes(app: FastifyInstance, store: WorkspaceStore, agents: AgentStore): void {
  /**
   * Checks membership and role, then resolves the agent inside that workspace.
   * Agents of other workspaces and malformed IDs answer the same 404.
   */
  async function resolveAgent(request: FastifyRequest, required: WorkspaceRole) {
    const params = AgentParams.parse(request.params);
    const { user, membership } = await requireMembership(
      request,
      store,
      parseWorkspaceId(request.params),
      required,
    );
    const agentId = AgentDefinitionIdSchema.safeParse(params.agentId);
    const agent = agentId.success ? await agents.findAgent(membership.workspace.id, agentId.data) : null;
    if (agent === null) throw agentNotFound();
    return { user, agent };
  }

  app.get("/v1/workspaces/:workspaceId/agents", async (request) => {
    const { membership } = await requireMembership(request, store, parseWorkspaceId(request.params), "viewer");
    const list = await agents.listAgents(membership.workspace.id);
    return { agents: list.map(toAgentView) };
  });

  app.post("/v1/workspaces/:workspaceId/agents", async (request, reply) => {
    const { user, membership } = await requireMembership(
      request,
      store,
      parseWorkspaceId(request.params),
      "editor",
    );
    const body = CreateAgentBody.parse(request.body);
    try {
      const agent = await agents.createAgent({
        id: newId("agt"),
        workspaceId: membership.workspace.id,
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        createdById: user.id,
      });
      reply.code(201);
      return { agent: toAgentView(agent) };
    } catch (error) {
      if (error instanceof AgentSlugTakenError) {
        throw new HttpError(409, "agent_slug_taken", error.message);
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/agents/:agentId", async (request) => {
    const { agent } = await resolveAgent(request, "viewer");
    return { agent: toAgentView(agent) };
  });

  app.get("/v1/workspaces/:workspaceId/agents/:agentId/versions", async (request) => {
    const { agent } = await resolveAgent(request, "viewer");
    const versions = await agents.listVersions(agent.workspaceId, agent.id);
    return { versions: versions.map(toVersionSummary) };
  });

  app.post("/v1/workspaces/:workspaceId/agents/:agentId/versions", async (request, reply) => {
    const { user, agent } = await resolveAgent(request, "editor");
    const body = PublishVersionBody.parse(request.body);
    try {
      const version = await agents.publishVersion({
        id: newId("agv"),
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        config: body.config,
        configHash: hashConfig(body.config),
        notes: body.notes ?? null,
        createdById: user.id,
        expectedLatestVersion: body.expectedLatestVersion,
      });
      reply.code(201);
      return { version: toVersionView(version) };
    } catch (error) {
      if (error instanceof VersionUnchangedError) {
        throw new HttpError(409, "version_unchanged", error.message);
      }
      if (error instanceof VersionConflictError) {
        throw new HttpError(409, "version_conflict", error.message);
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/agents/:agentId/versions/:version", async (request) => {
    const { agent } = await resolveAgent(request, "viewer");
    const number = parseVersionNumber(VersionParams.parse(request.params).version);
    const version = number === null ? null : await agents.findVersion(agent.workspaceId, agent.id, number);
    if (version === null) throw versionNotFound();
    return { version: toVersionView(version) };
  });

  // Versions are immutable. Say so explicitly instead of a generic 404, but
  // only to members, so the route does not reveal other workspaces' agents.
  app.route({
    method: ["PUT", "PATCH", "DELETE"],
    url: "/v1/workspaces/:workspaceId/agents/:agentId/versions/:version",
    handler: async (request, reply) => {
      await resolveAgent(request, "viewer");
      reply.code(405).header("allow", "GET");
      return {
        error: {
          code: "version_immutable",
          message: "Agent versions cannot be changed or deleted. Publish a new version instead.",
        },
      };
    },
  });
}
