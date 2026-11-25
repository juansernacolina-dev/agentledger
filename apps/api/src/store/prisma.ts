import type { AgentVersionConfig, Redaction, RunBudget, TraceEvent } from "@agentledger/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import { nextVersionNumber } from "../agents/publish.js";
import { applyTransition } from "../runs/lifecycle.js";
import { planTraceAppend } from "../traces/append.js";
import {
  AgentSlugTakenError,
  SlugTakenError,
  type AgentRecord,
  type AgentStore,
  type AgentVersionRecord,
  type CreateAgentInput,
  type CreateRunInput,
  type ListRunsQuery,
  type RunRecord,
  type RunStore,
  type TransitionRunInput,
  type AppendTraceInput,
  type AppendTraceResult,
  type TraceStore,
  RunNotFoundError,
  type PublishVersionInput,
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

const agentFields = {
  id: true,
  workspaceId: true,
  slug: true,
  name: true,
  description: true,
  createdAt: true,
  versions: { select: { version: true }, orderBy: { version: "desc" }, take: 1 },
} as const satisfies Prisma.AgentDefinitionSelect;

const versionFields = {
  id: true,
  workspaceId: true,
  agentId: true,
  version: true,
  config: true,
  configHash: true,
  notes: true,
  createdById: true,
  createdAt: true,
} as const satisfies Prisma.AgentVersionSelect;

type AgentRow = Prisma.AgentDefinitionGetPayload<{ select: typeof agentFields }>;
type VersionRow = Prisma.AgentVersionGetPayload<{ select: typeof versionFields }>;

function toAgentRecord({ versions, ...agent }: AgentRow): AgentRecord {
  return { ...agent, latestVersion: versions[0]?.version ?? null };
}

/** Configs were validated against the contract before they were stored. */
function toVersionRecord(row: VersionRow): AgentVersionRecord {
  return { ...row, config: row.config as unknown as AgentVersionConfig };
}

export class PrismaAgentStore implements AgentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listAgents(workspaceId: string): Promise<AgentRecord[]> {
    const rows = await this.prisma.agentDefinition.findMany({
      where: { workspaceId },
      select: agentFields,
      orderBy: { slug: "asc" },
    });
    return rows.map(toAgentRecord);
  }

  async findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null> {
    const row = await this.prisma.agentDefinition.findUnique({
      where: { id_workspaceId: { id: agentId, workspaceId } },
      select: agentFields,
    });
    return row === null ? null : toAgentRecord(row);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    try {
      const row = await this.prisma.agentDefinition.create({ data: input, select: agentFields });
      return toAgentRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AgentSlugTakenError(input.slug);
      }
      throw error;
    }
  }

  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersionRecord[]> {
    const rows = await this.prisma.agentVersion.findMany({
      where: { workspaceId, agentId },
      select: versionFields,
      orderBy: { version: "desc" },
    });
    return rows.map(toVersionRecord);
  }

  async findVersion(workspaceId: string, agentId: string, version: number): Promise<AgentVersionRecord | null> {
    const row = await this.prisma.agentVersion.findFirst({
      where: { workspaceId, agentId, version },
      select: versionFields,
    });
    return row === null ? null : toVersionRecord(row);
  }

  async publishVersion(input: PublishVersionInput): Promise<AgentVersionRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the agent row so concurrent publishes get consecutive numbers
      // instead of colliding on (agent_id, version).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM agent_definitions
        WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId}
        FOR UPDATE`;
      if (locked.length === 0) {
        throw new Error(`unknown agent ${input.agentId} in workspace ${input.workspaceId}`);
      }
      const latest = await tx.agentVersion.findFirst({
        where: { agentId: input.agentId, workspaceId: input.workspaceId },
        select: { version: true, configHash: true },
        orderBy: { version: "desc" },
      });
      const row = await tx.agentVersion.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          version: nextVersionNumber(latest, input),
          config: input.config as unknown as Prisma.InputJsonObject,
          configHash: input.configHash,
          notes: input.notes,
          createdById: input.createdById,
        },
        select: versionFields,
      });
      return toVersionRecord(row);
    });
  }
}

const runFields = {
  id: true,
  workspaceId: true,
  agentId: true,
  agentVersionId: true,
  status: true,
  timingSource: true,
  budget: true,
  input: true,
  failureReason: true,
  createdById: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  agentVersion: { select: { version: true } },
} as const satisfies Prisma.AgentRunSelect;

type RunRow = Prisma.AgentRunGetPayload<{ select: typeof runFields }>;

/** Budgets come from validated version configs; inputs were validated as objects. */
function toRunRecord({ agentVersion, ...row }: RunRow): RunRecord {
  return {
    ...row,
    agentVersion: agentVersion.version,
    budget: row.budget as unknown as RunBudget,
    input: row.input as Record<string, unknown>,
  };
}

export class PrismaRunStore implements RunStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    // The composite foreign key rejects a version that does not belong to
    // this agent and workspace.
    const row = await this.prisma.agentRun.create({
      data: {
        id: input.id,
        workspaceId: input.version.workspaceId,
        agentId: input.version.agentId,
        agentVersionId: input.version.id,
        timingSource: input.timingSource,
        budget: input.budget as unknown as Prisma.InputJsonObject,
        input: input.input as Prisma.InputJsonObject,
        createdById: input.createdById,
        createdAt: input.createdAt,
      },
      select: runFields,
    });
    return toRunRecord(row);
  }

  async findRun(workspaceId: string, runId: string): Promise<RunRecord | null> {
    const row = await this.prisma.agentRun.findFirst({ where: { id: runId, workspaceId }, select: runFields });
    return row === null ? null : toRunRecord(row);
  }

  async listRuns(workspaceId: string, query: ListRunsQuery): Promise<RunRecord[]> {
    const { after } = query;
    const rows = await this.prisma.agentRun.findMany({
      where: {
        workspaceId,
        agentId: query.agentId,
        status: query.status,
        ...(after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      select: runFields,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit,
    });
    return rows.map(toRunRecord);
  }

  async transitionRun(input: TransitionRunInput): Promise<RunRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the row so two workers cannot both move the same run.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM agent_runs
        WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId}
        FOR UPDATE`;
      if (locked.length === 0) throw new RunNotFoundError(input.runId);
      const current = await tx.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { status: true, startedAt: true, finishedAt: true, failureReason: true },
      });
      const row = await tx.agentRun.update({
        where: { id: input.runId },
        data: applyTransition(current, input),
        select: runFields,
      });
      return toRunRecord(row);
    });
  }
}

const traceEventFields = {
  id: true,
  sequence: true,
  stepId: true,
  type: true,
  attempt: true,
  offsetMs: true,
  data: true,
  redactions: true,
} as const satisfies Prisma.TraceEventSelect;

type TraceEventRow = Prisma.TraceEventGetPayload<{ select: typeof traceEventFields }>;

/** Rows are written by `toTraceEventRow` from contract-valid, redacted events. */
function toTraceEvent(row: TraceEventRow): TraceEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    type: row.type,
    stepId: row.stepId,
    attempt: row.attempt,
    offsetMs: row.offsetMs,
    ...(row.data as Prisma.JsonObject),
    redactions: row.redactions as unknown as Redaction[],
  } as TraceEvent;
}

function toTraceEventRow(workspaceId: string, runId: string, event: TraceEvent): Prisma.TraceEventCreateManyInput {
  const { id, sequence, type, stepId, attempt, offsetMs, redactions, ...data } = event;
  return {
    runId,
    workspaceId,
    id,
    sequence,
    type,
    stepId,
    attempt,
    offsetMs,
    data: data as Prisma.InputJsonObject,
    redactions: redactions as unknown as Prisma.InputJsonArray,
  };
}

export class PrismaTraceStore implements TraceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listTraceEvents(workspaceId: string, runId: string): Promise<TraceEvent[]> {
    const rows = await this.prisma.traceEvent.findMany({
      where: { runId, workspaceId },
      select: traceEventFields,
      orderBy: { sequence: "asc" },
    });
    return rows.map(toTraceEvent);
  }

  async appendTraceEvents(input: AppendTraceInput): Promise<AppendTraceResult> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the run: appends to one run are serialised, and its status
      // cannot change while the batch is checked.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM agent_runs
        WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId}
        FOR UPDATE`;
      if (locked.length === 0) throw new RunNotFoundError(input.runId);
      const run = await tx.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { status: true, budget: true },
      });
      const existing = (
        await tx.traceEvent.findMany({
          where: { runId: input.runId },
          select: traceEventFields,
          orderBy: { sequence: "asc" },
        })
      ).map(toTraceEvent);

      const plan = planTraceAppend(
        { status: run.status, budget: run.budget as unknown as RunBudget },
        existing,
        input.events,
      );
      if (plan.insert.length > 0) {
        await tx.traceEvent.createMany({
          data: plan.insert.map((event) => toTraceEventRow(input.workspaceId, input.runId, event)),
        });
      }
      return { appended: plan.insert, replayed: plan.replayed, nextSequence: existing.length + plan.insert.length };
    });
  }
}
