import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "./errors.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { AgentStore, RunStore, TraceStore, WorkspaceStore } from "./store/types.js";

export interface ServerOptions {
  store: WorkspaceStore;
  agents: AgentStore;
  runs: RunStore;
  traces: TraceStore;
  logger?: FastifyServerOptions["logger"];
}

export function buildServer({ store, agents, runs, traces, logger = true }: ServerOptions) {
  // Fastify's default request serializer logs method and URL only, never headers,
  // so bearer tokens stay out of the logs.
  const app = Fastify({ logger });

  app.setErrorHandler((error: FastifyError | HttpError | ZodError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_failed",
          message: "The request is invalid.",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: "bad_request", message: error.message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "internal_error", message: "Something went wrong." } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found." } }),
  );

  app.get("/health", async () => ({ status: "ok" }));
  registerWorkspaceRoutes(app, store);
  registerAgentRoutes(app, store, agents);
  registerRunRoutes(app, store, agents, runs);
  registerTraceRoutes(app, store, runs, traces);

  return app;
}
