import { redactTraceEvent, TraceEventInputSchema } from "@agentledger/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, runNotFound } from "../errors.js";
import {
  InvalidTraceError,
  RunNotAcceptingTraceError,
  RunNotFoundError,
  TraceConflictError,
  type RunStore,
  type TraceStore,
  type WorkspaceStore,
} from "../store/types.js";
import { loadRun } from "./runs.js";

/** Events per request; workers send a run's trace in batches. */
export const MAX_TRACE_BATCH = 100;

const AppendTraceBody = z
  .object({ events: z.array(TraceEventInputSchema).min(1).max(MAX_TRACE_BATCH) })
  .strict();

export function registerTraceRoutes(
  app: FastifyInstance,
  store: WorkspaceStore,
  runs: RunStore,
  traces: TraceStore,
): void {
  /**
   * Appends trace events to a run. Inputs, outputs and errors are redacted
   * here, before anything reaches the store, and the response returns the
   * stored (redacted) events. Re-sending stored events is a no-op, so a
   * worker can retry a batch; 201 means something new was stored.
   */
  app.post("/v1/workspaces/:workspaceId/runs/:runId/trace-events", async (request, reply) => {
    const run = await loadRun(request, store, runs, "editor");
    const body = AppendTraceBody.parse(request.body);
    const events = body.events.map(redactTraceEvent).sort((a, b) => a.sequence - b.sequence);

    try {
      const result = await traces.appendTraceEvents({ workspaceId: run.workspaceId, runId: run.id, events });
      reply.code(result.appended.length > 0 ? 201 : 200);
      return {
        appended: result.appended.length,
        replayed: result.replayed,
        nextSequence: result.nextSequence,
        events: result.appended,
      };
    } catch (error) {
      if (error instanceof RunNotAcceptingTraceError) {
        throw new HttpError(409, "run_not_accepting_trace", error.message);
      }
      if (error instanceof TraceConflictError) {
        throw new HttpError(409, error.code, error.message, { nextSequence: error.nextSequence });
      }
      if (error instanceof InvalidTraceError) {
        throw new HttpError(422, "invalid_trace", error.message, error.issues);
      }
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  });
}
