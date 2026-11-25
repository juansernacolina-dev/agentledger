import {
  canTransitionRun,
  isTerminalRunStatus,
  type AgentVersionConfig,
  type TimingSource,
} from "@agentledger/contracts";
import {
  InvalidRunTransitionError,
  type RunRecord,
  type TransitionRunInput,
} from "../store/types.js";

type RunState = Pick<RunRecord, "status" | "startedAt" | "finishedAt" | "failureReason">;

/**
 * The status change shared by every store: checks the transition, stamps
 * `startedAt` the first time the run starts and `finishedAt` when it ends.
 */
export function applyTransition(run: RunState, input: Pick<TransitionRunInput, "to" | "at" | "failureReason">): RunState {
  if (!canTransitionRun(run.status, input.to)) {
    throw new InvalidRunTransitionError(run.status, input.to);
  }
  const failed = input.to === "failed";
  if (failed !== (input.failureReason !== undefined)) {
    throw new Error(failed ? "a failed run needs a failure reason" : "only failed runs carry a failure reason");
  }
  return {
    status: input.to,
    startedAt: run.startedAt ?? (input.to === "running" ? input.at : null),
    finishedAt: isTerminalRunStatus(input.to) ? input.at : null,
    failureReason: input.failureReason ?? null,
  };
}

/**
 * Fixture models replay recorded timings, so their runs must never be shown
 * as live measurements.
 */
export function timingSourceFor(config: AgentVersionConfig): TimingSource {
  return config.model.provider === "fixture" ? "fixture" : "measured";
}
