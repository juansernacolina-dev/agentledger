import { z } from "zod";

/**
 * Shared run contract: the shape of one agent run as it moves between the
 * API, the worker and the web app. Version 1 covers the run envelope, its
 * budget and an ordered list of steps; trace events and assertions build on
 * top of it in later contracts.
 */
export const RUN_CONTRACT_VERSION = 1;

/** `<prefix>_<6-32 lowercase letters or digits>`, the ID format shared by every entity. */
export const idPattern = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9]{6,32}$`),
      `must look like ${prefix}_<6-32 lowercase letters or digits>`,
    );

export const RunIdSchema = idPattern("run");
export const WorkspaceIdSchema = idPattern("ws");
export const AgentDefinitionIdSchema = idPattern("agt");
export const AgentVersionIdSchema = idPattern("agv");
export const StepIdSchema = idPattern("step");

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * Allowed status changes. A run is queued, then runs; it may pause for a
 * review and resume. Terminal statuses never change again.
 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["paused", "succeeded", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const StepKindSchema = z.enum(["model", "tool", "retrieval", "decision"]);
export const StepStatusSchema = z.enum(["ok", "error", "skipped", "pending_approval"]);

/**
 * Where timing numbers come from. Fixture runs replay recorded durations and
 * must never be presented as live measurements.
 */
export const TimingSourceSchema = z.enum(["fixture", "measured"]);
export type TimingSource = z.infer<typeof TimingSourceSchema>;

export const RunBudgetSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(200),
    maxDurationMs: z.number().int().min(1).max(30 * 60 * 1000),
    maxRetries: z.number().int().min(0).max(5),
  })
  .strict();
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const RunStepSchema = z
  .object({
    id: StepIdSchema,
    index: z.number().int().min(0),
    kind: StepKindSchema,
    name: z.string().min(1).max(120),
    status: StepStatusSchema,
    startOffsetMs: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    attempt: z.number().int().min(1),
    error: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.status === "error" && step.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "an errored step must explain the error",
      });
    }
    if (step.status !== "error" && step.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "only errored steps may carry an error",
      });
    }
  });
export type RunStep = z.infer<typeof RunStepSchema>;

export const AgentRunSchema = z
  .object({
    contractVersion: z.literal(RUN_CONTRACT_VERSION),
    id: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    agent: z
      .object({
        definitionId: AgentDefinitionIdSchema,
        versionId: AgentVersionIdSchema,
        version: z.number().int().min(1),
      })
      .strict(),
    status: RunStatusSchema,
    timingSource: TimingSourceSchema,
    budget: RunBudgetSchema,
    createdAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).optional(),
    steps: z.array(RunStepSchema),
  })
  .strict()
  .superRefine((run, ctx) => {
    run.steps.forEach((step, position) => {
      if (step.index !== position) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", position, "index"],
          message: `expected step index ${position}, got ${step.index}`,
        });
      }
      if (step.attempt > run.budget.maxRetries + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", position, "attempt"],
          message: `attempt ${step.attempt} exceeds the retry budget of ${run.budget.maxRetries}`,
        });
      }
      if (step.startOffsetMs + step.durationMs > run.budget.maxDurationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", position, "durationMs"],
          message: "step ends after the run's duration budget",
        });
      }
    });

    const stepIds = new Set<string>();
    run.steps.forEach((step, position) => {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", position, "id"],
          message: `duplicate step id ${step.id}`,
        });
      }
      stepIds.add(step.id);
    });

    if (run.steps.length > run.budget.maxSteps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: `${run.steps.length} steps exceed the budget of ${run.budget.maxSteps}`,
      });
    }

    const terminal = TERMINAL_RUN_STATUSES.includes(run.status);
    if (terminal && run.finishedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: `a ${run.status} run must have finishedAt`,
      });
    }
    if (!terminal && run.finishedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: `a ${run.status} run cannot have finishedAt`,
      });
    }
    if (
      run.finishedAt !== undefined &&
      Date.parse(run.finishedAt) < Date.parse(run.createdAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt is before createdAt",
      });
    }

    const pending = run.steps.some((step) => step.status === "pending_approval");
    if (pending && run.status !== "paused") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "a run with a step pending approval must be paused",
      });
    }
  });
export type AgentRun = z.infer<typeof AgentRunSchema>;

export interface ContractIssue {
  path: string;
  message: string;
}

export type ParseRunResult =
  | { ok: true; run: AgentRun }
  | { ok: false; issues: ContractIssue[] };

/** Validate untrusted input against the run contract without throwing. */
export function parseRun(input: unknown): ParseRunResult {
  const result = AgentRunSchema.safeParse(input);
  if (result.success) {
    return { ok: true, run: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    })),
  };
}
