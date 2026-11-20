import { WorkspaceIdSchema } from "@agentledger/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership, requireUser } from "../auth/access.js";
import { HttpError } from "../errors.js";
import { newId } from "../ids.js";
import { SlugTakenError, type MembershipRecord, type WorkspaceStore } from "../store/types.js";

const CreateWorkspaceBody = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens")
      .min(3)
      .max(40),
    name: z.string().trim().min(1).max(80),
  })
  .strict();

const WorkspaceParams = z.object({ workspaceId: z.string() });

function toWorkspaceView({ workspace, role }: MembershipRecord) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
    role,
  };
}

/** Malformed IDs can never match a workspace; they are answered like unknown ones. */
function parseWorkspaceId(params: unknown): string | null {
  const parsed = WorkspaceIdSchema.safeParse(WorkspaceParams.parse(params).workspaceId);
  return parsed.success ? parsed.data : null;
}

export function registerWorkspaceRoutes(app: FastifyInstance, store: WorkspaceStore): void {
  app.get("/v1/workspaces", async (request) => {
    const user = await requireUser(request, store);
    const memberships = await store.listMemberships(user.id);
    return { workspaces: memberships.map(toWorkspaceView) };
  });

  app.post("/v1/workspaces", async (request, reply) => {
    const user = await requireUser(request, store);
    const body = CreateWorkspaceBody.parse(request.body);
    try {
      const workspace = await store.createWorkspace({
        id: newId("ws"),
        slug: body.slug,
        name: body.name,
        ownerId: user.id,
      });
      reply.code(201);
      return { workspace: toWorkspaceView({ workspace, role: "admin" }) };
    } catch (error) {
      if (error instanceof SlugTakenError) {
        throw new HttpError(409, "slug_taken", error.message);
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId", async (request) => {
    const workspaceId = parseWorkspaceId(request.params);
    const { membership } = await requireMembership(request, store, workspaceId, "viewer");
    return { workspace: toWorkspaceView(membership) };
  });

  app.get("/v1/workspaces/:workspaceId/members", async (request) => {
    const workspaceId = parseWorkspaceId(request.params);
    const { membership } = await requireMembership(request, store, workspaceId, "admin");
    const members = await store.listMembers(membership.workspace.id);
    return {
      members: members.map(({ user, role }) => ({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role,
      })),
    };
  });
}
