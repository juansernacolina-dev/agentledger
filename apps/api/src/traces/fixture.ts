import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  checkTrace,
  parseTraceFixture,
  TraceFixtureNameSchema,
  type StepFinishedEvent,
  type TraceEvent,
  type TraceFixture,
} from "@agentledger/contracts";
import {
  InvalidTraceError,
  RunNotFoundError,
  type RunRecord,
  type RunStore,
  type TraceStore,
} from "../store/types.js";

const require = createRequire(import.meta.url);

/** Reads and validates a trace fixture shipped with `@agentledger/contracts`. */
export function readTraceFixture(name: string): TraceFixture {
  const fileName = TraceFixtureNameSchema.parse(name);
  const path = require.resolve(`@agentledger/contracts/fixtures/traces/${fileName}.json`);
  const result = parseTraceFixture(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) {
    const issues = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Trace fixture ${fileName} is invalid: ${issues}`);
  }
  return result.fixture;
}

export type TraceOutcome =
  | { status: "running" }
  | { status: "succeeded" }
  | { status: "paused" }
  | { status: "failed"; failureReason: string };

/**
 * How a complete trace ends, judged by each step's last attempt: a step
 * still open means the run is still running, one waiting for approval pauses
 * it, a step whose last attempt failed fails it, and otherwise it succeeded.
 */
export function traceOutcome(events: readonly TraceEvent[]): TraceOutcome {
  const last = new Map<string, TraceEvent>();
  for (const event of events) last.set(event.stepId, event);
  const ends = [...last.values()];
  if (ends.some((event) => event.type === "step_started")) return { status: "running" };
  const finished = ends as StepFinishedEvent[];
  if (finished.some((event) => event.status === "pending_approval")) return { status: "paused" };
  const failed = finished.find((event) => event.status === "error");
  if (failed !== undefined) return { status: "failed", failureReason: failed.error ?? "step failed" };
  return { status: "succeeded" };
}

export interface LoadTraceFixtureInput {
  workspaceId: string;
  runId: string;
  fixture: TraceFixture;
  /** When the replayed run started; event offsets count from here. */
  startedAt: Date;
}

export interface LoadTraceFixtureResult {
  run: RunRecord;
  appended: number;
  replayed: number;
}

/**
 * Replays a fixture into an existing run: starts a queued run, appends the
 * fixture's (already redacted) events through the trace store and moves the
 * run to the status the trace ends in. Loading the same fixture again is a
 * no-op, because the events keep the fixture's IDs and sequences.
 */
export async function loadTraceFixture(
  stores: { runs: RunStore; traces: TraceStore },
  input: LoadTraceFixtureInput,
): Promise<LoadTraceFixtureResult> {
  const { workspaceId, runId, fixture, startedAt } = input;
  let run = await stores.runs.findRun(workspaceId, runId);
  if (run === null) throw new RunNotFoundError(runId);

  // Check against the run's own budget before changing anything.
  const issues = checkTrace(fixture.events, run.budget);
  if (issues.length > 0) throw new InvalidTraceError(issues);

  if (run.status === "queued") {
    run = await stores.runs.transitionRun({ workspaceId, runId, to: "running", at: startedAt });
  }
  const appended = await stores.traces.appendTraceEvents({ workspaceId, runId, events: fixture.events });

  const outcome = traceOutcome(fixture.events);
  if (run.status === "running" && outcome.status !== "running") {
    const lastOffset = fixture.events[fixture.events.length - 1]?.offsetMs ?? 0;
    run = await stores.runs.transitionRun({
      workspaceId,
      runId,
      to: outcome.status,
      at: new Date(startedAt.getTime() + lastOffset),
      ...(outcome.status === "failed" ? { failureReason: outcome.failureReason } : {}),
    });
  }
  return { run, appended: appended.appended.length, replayed: appended.replayed };
}
