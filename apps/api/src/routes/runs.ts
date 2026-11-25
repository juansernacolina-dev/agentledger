import {
  AgentDefinitionIdSchema,
  RUN_CONTRACT_VERSION,
  RunIdSchema,
  RunStatusSchema,
  type AgentRun,
} from "@agentledger/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership } from "../auth/access.js";
import { agentNotFound, HttpError, runNotFound, versionNotFound } from "../errors.js";
import { newId } from "../ids.js";
import { timingSourceFor } from "../runs/lifecycle.js";
import {
  InvalidRunTransitionError,
  RunNotFoundError,
  type AgentStore,
  type RunCursor,
  type RunRecord,
  type RunStore,
  type WorkspaceStore,
} from "../store/types.js";
import { parseWorkspaceId } from "./workspaces.js";

/** Run inputs are small synthetic payloads, not documents. */
export const MAX_RUN_INPUT_BYTES = 32 * 1024;

const CreateRunBody = z
  .object({
    agentId: AgentDefinitionIdSchema,
    /** Defaults to the agent's latest version. */
    version: z.number().int().min(1).optional(),
    input: z
      .record(z.unknown())
      .refine(
        (input) => Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_RUN_INPUT_BYTES,
        `input must be at most ${MAX_RUN_INPUT_BYTES} bytes of JSON`,
      ),
  })
  .strict();

const ListRunsQuery = z
  .object({
    agentId: AgentDefinitionIdSchema.optional(),
    status: RunStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .strict();

const RunParams = z.object({ workspaceId: z.string(), runId: z.string() });

export function encodeCursor(run: Pick<RunRecord, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify([run.createdAt.toISOString(), run.id])).toString("base64url");
}

export function decodeCursor(cursor: string): RunCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z.tuple([z.string().datetime(), RunIdSchema]).safeParse(value);
    return parsed.success ? { createdAt: new Date(parsed.data[0]), id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/** The run in the shared contract shape. Steps arrive with trace events. */
export function toContractRun(run: RunRecord): AgentRun {
  return {
    contractVersion: RUN_CONTRACT_VERSION,
    id: run.id,
    workspaceId: run.workspaceId,
    agent: { definitionId: run.agentId, versionId: run.agentVersionId, version: run.agentVersion },
    status: run.status,
    timingSource: run.timingSource,
    budget: run.budget,
    createdAt: run.createdAt.toISOString(),
    ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt.toISOString() }),
    steps: [],
  };
}

function toRunView(run: RunRecord) {
  return {
    run: toContractRun(run),
    lifecycle: {
      createdById: run.createdById,
      startedAt: run.startedAt?.toISOString() ?? null,
      failureReason: run.failureReason,
    },
  };
}

const toRunDetail = (run: RunRecord) => ({ ...toRunView(run), input: run.input });

export function registerRunRoutes(
  app: FastifyInstance,
  store: WorkspaceStore,
  agents: AgentStore,
  runs: RunStore,
): void {
  app.post("/v1/workspaces/:workspaceId/runs", async (request, reply) => {
    const { user, membership } = await requireMembership(
      request,
      store,
      parseWorkspaceId(request.params),
      "editor",
    );
    const body = CreateRunBody.parse(request.body);
    const workspaceId = membership.workspace.id;

    const agent = await agents.findAgent(workspaceId, body.agentId);
    if (agent === null) throw agentNotFound();
    const number = body.version ?? agent.latestVersion;
    if (number === null) {
      throw new HttpError(409, "agent_has_no_versions", "Publish a version of this agent before running it.");
    }
    const version = await agents.findVersion(workspaceId, agent.id, number);
    if (version === null) throw versionNotFound();

    const run = await runs.createRun({
      id: newId("run"),
      version,
      timingSource: timingSourceFor(version.config),
      budget: version.config.budget,
      input: body.input,
      createdById: user.id,
      createdAt: new Date(),
    });
    reply.code(201);
    return toRunDetail(run);
  });

  app.get("/v1/workspaces/:workspaceId/runs", async (request) => {
    const { membership } = await requireMembership(request, store, parseWorkspaceId(request.params), "viewer");
    const query = ListRunsQuery.parse(request.query);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (after === null) throw new HttpError(400, "invalid_cursor", "The cursor is not valid.");

    // Fetch one extra row to know whether another page exists.
    const page = await runs.listRuns(membership.workspace.id, {
      agentId: query.agentId,
      status: query.status,
      limit: query.limit + 1,
      after,
    });
    const items = page.slice(0, query.limit);
    const last = items.at(-1);
    return {
      runs: items.map(toRunView),
      nextCursor: page.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  });

  async function resolveRun(request: Parameters<typeof requireMembership>[0], required: "viewer" | "editor") {
    const params = RunParams.parse(request.params);
    const { membership } = await requireMembership(request, store, parseWorkspaceId(request.params), required);
    const runId = RunIdSchema.safeParse(params.runId);
    const run = runId.success ? await runs.findRun(membership.workspace.id, runId.data) : null;
    if (run === null) throw runNotFound();
    return run;
  }

  app.get("/v1/workspaces/:workspaceId/runs/:runId", async (request) => toRunDetail(await resolveRun(request, "viewer")));

  app.post("/v1/workspaces/:workspaceId/runs/:runId/cancel", async (request) => {
    const run = await resolveRun(request, "editor");
    try {
      const cancelled = await runs.transitionRun({
        workspaceId: run.workspaceId,
        runId: run.id,
        to: "cancelled",
        at: new Date(),
      });
      return toRunDetail(cancelled);
    } catch (error) {
      if (error instanceof InvalidRunTransitionError) {
        throw new HttpError(409, "invalid_run_transition", error.message);
      }
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  });
}
