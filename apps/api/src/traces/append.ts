import { checkTrace, type TraceEvent } from "@agentledger/contracts";
import { canonicalJson } from "../agents/config-hash.js";
import {
  InvalidTraceError,
  RunNotAcceptingTraceError,
  TraceConflictError,
  type RunRecord,
} from "../store/types.js";

export interface TraceAppendPlan {
  insert: TraceEvent[];
  replayed: number;
}

const ACCEPTING_STATUSES: ReadonlySet<RunRecord["status"]> = new Set(["running", "paused"]);

/**
 * Decides what an append does, shared by every store so they behave the same:
 *
 * - events whose sequence is already stored must match the stored event
 *   exactly (a retried batch) and are skipped; anything else is a conflict
 * - the first new event must take the next free sequence
 * - new events need a running or paused run
 * - the whole trace, old and new, must pass the contract's `checkTrace`
 */
export function planTraceAppend(
  run: Pick<RunRecord, "status" | "budget">,
  existing: readonly TraceEvent[],
  incoming: readonly TraceEvent[],
): TraceAppendPlan {
  const next = existing.length;
  const insert: TraceEvent[] = [];
  let replayed = 0;

  for (const event of incoming) {
    const stored = event.sequence < next ? existing[event.sequence] : undefined;
    if (stored === undefined) {
      insert.push(event);
    } else if (canonicalJson(stored) === canonicalJson(event)) {
      replayed += 1;
    } else {
      throw new TraceConflictError(
        "trace_event_conflict",
        `Event ${event.sequence} is already stored with different content.`,
        next,
      );
    }
  }

  const first = insert[0];
  if (first === undefined) return { insert, replayed };
  if (first.sequence !== next) {
    throw new TraceConflictError(
      "trace_sequence_gap",
      `The next event must have sequence ${next}, not ${first.sequence}.`,
      next,
    );
  }
  if (!ACCEPTING_STATUSES.has(run.status)) throw new RunNotAcceptingTraceError(run.status);

  const issues = checkTrace([...existing, ...insert], run.budget);
  if (issues.length > 0) throw new InvalidTraceError(issues);
  return { insert, replayed };
}
