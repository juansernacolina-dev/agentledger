import { Prisma, type PrismaClient } from "@prisma/client";
import {
  SlugTakenError,
  type CreateWorkspaceInput,
  type MemberRecord,
  type MembershipRecord,
  type UserRecord,
  type WorkspaceRecord,
  type WorkspaceStore,
} from "./types.js";

const userFields = { id: true, email: true, displayName: true } as const;
const workspaceFields = { id: true, slug: true, name: true, createdAt: true } as const;

export class PrismaWorkspaceStore implements WorkspaceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash },
      select: { revokedAt: true, user: { select: userFields } },
    });
    if (token === null || token.revokedAt !== null) return null;
    return token.user;
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    return this.prisma.membership.findMany({
      where: { userId },
      select: { role: true, workspace: { select: workspaceFields } },
      orderBy: { workspace: { slug: "asc" } },
    });
  }

  async findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null> {
    return this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspace: { select: workspaceFields } },
    });
  }

  async listMembers(workspaceId: string): Promise<MemberRecord[]> {
    return this.prisma.membership.findMany({
      where: { workspaceId },
      select: { role: true, user: { select: userFields } },
      orderBy: { user: { email: "asc" } },
    });
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    try {
      return await this.prisma.workspace.create({
        data: {
          id: input.id,
          slug: input.slug,
          name: input.name,
          memberships: { create: { userId: input.ownerId, role: "admin" } },
        },
        select: workspaceFields,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new SlugTakenError(input.slug);
      }
      throw error;
    }
  }
}
