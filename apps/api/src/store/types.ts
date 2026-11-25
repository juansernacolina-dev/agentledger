import type {
  AgentVersionConfig,
  ContractIssue,
  RunBudget,
  RunStatus,
  TimingSource,
  TraceEvent,
} from "@agentledger/contracts";
import type { WorkspaceRole } from "../auth/roles.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface MembershipRecord {
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
}

export interface MemberRecord {
  user: UserRecord;
  role: WorkspaceRole;
}

export interface CreateWorkspaceInput {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Workspace slug "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

/** Persistence for workspaces, users and memberships. */
export interface WorkspaceStore {
  /** The user owning an active (not revoked) token with this hash. */
  findUserByTokenHash(tokenHash: string): Promise<UserRecord | null>;
  listMemberships(userId: string): Promise<MembershipRecord[]>;
  findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null>;
  listMembers(workspaceId: string): Promise<MemberRecord[]>;
  /** Creates the workspace and makes the owner its admin, atomically. */
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
}

export interface AgentRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  /** Highest published version number, or null before the first version. */
  latestVersion: number | null;
}

export interface AgentVersionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  version: number;
  config: AgentVersionConfig;
  configHash: string;
  notes: string | null;
  createdById: string;
  createdAt: Date;
}

export interface CreateAgentInput {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  createdById: string;
}

export interface PublishVersionInput {
  id: string;
  workspaceId: string;
  agentId: string;
  config: AgentVersionConfig;
  configHash: string;
  notes: string | null;
  createdById: string;
  /**
   * When set, publishing fails with {@link VersionConflictError} unless this is
   * still the latest version (null = the agent has no versions yet).
   */
  expectedLatestVersion?: number | null;
}

export class AgentSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`An agent with slug "${slug}" already exists in this workspace.`);
    this.name = "AgentSlugTakenError";
  }
}

/** The config is identical to the latest version, so there is nothing to publish. */
export class VersionUnchangedError extends Error {
  constructor(readonly latestVersion: number) {
    super(`The config is identical to version ${latestVersion}.`);
    this.name = "VersionUnchangedError";
  }
}

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number | null,
    readonly actual: number | null,
  ) {
    super(`Expected latest version ${expected ?? "none"}, but it is ${actual ?? "none"}.`);
    this.name = "VersionConflictError";
  }
}

/**
 * Persistence for agent definitions and their immutable versions. Every lookup
 * is scoped by workspace, so an ID from another workspace is never found.
 */
export interface AgentStore {
  listAgents(workspaceId: string): Promise<AgentRecord[]>;
  findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null>;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  /** Newest first. */
  listVersions(workspaceId: string, agentId: string): Promise<AgentVersionRecord[]>;
  findVersion(workspaceId: string, agentId: string, version: number): Promise<AgentVersionRecord | null>;
  /**
   * Stores the config as the next version number (latest + 1). Versions are
   * append-only: there is no update or delete.
   */
  publishVersion(input: PublishVersionInput): Promise<AgentVersionRecord>;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  agentVersionId: string;
  /** The version number of `agentVersionId`. */
  agentVersion: number;
  status: RunStatus;
  timingSource: TimingSource;
  budget: RunBudget;
  input: Record<string, unknown>;
  failureReason: string | null;
  createdById: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CreateRunInput {
  id: string;
  /** The exact version to run; its workspace and agent are copied onto the run. */
  version: Pick<AgentVersionRecord, "id" | "workspaceId" | "agentId" | "version">;
  timingSource: TimingSource;
  budget: RunBudget;
  input: Record<string, unknown>;
  createdById: string;
  createdAt: Date;
}

export interface TransitionRunInput {
  workspaceId: string;
  runId: string;
  to: RunStatus;
  at: Date;
  /** Required when moving to `failed`, rejected otherwise. */
  failureReason?: string;
}

/** Keyset position: runs strictly older than this (createdAt, id) pair. */
export interface RunCursor {
  createdAt: Date;
  id: string;
}

export interface ListRunsQuery {
  agentId?: string;
  status?: RunStatus;
  limit: number;
  after?: RunCursor;
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} not found.`);
    this.name = "RunNotFoundError";
  }
}

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`A ${from} run cannot become ${to}.`);
    this.name = "InvalidRunTransitionError";
  }
}

/**
 * Persistence for agent runs. Runs are scoped by workspace like agents, always
 * point at one immutable version, and only change status along
 * `RUN_STATUS_TRANSITIONS`.
 */
export interface RunStore {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  findRun(workspaceId: string, runId: string): Promise<RunRecord | null>;
  /** Newest first: createdAt descending, then id descending. */
  listRuns(workspaceId: string, query: ListRunsQuery): Promise<RunRecord[]>;
  /**
   * Moves a run to a new status, stamping `startedAt` on its first start and
   * `finishedAt` when it ends. Concurrent callers are serialised, so only
   * transitions valid from the current status succeed.
   */
  transitionRun(input: TransitionRunInput): Promise<RunRecord>;
}

export interface AppendTraceInput {
  workspaceId: string;
  runId: string;
  /** Already redacted, ordered by sequence. */
  events: TraceEvent[];
}

export interface AppendTraceResult {
  /** The events stored by this call. */
  appended: TraceEvent[];
  /** Events that were already stored with identical content (a retried batch). */
  replayed: number;
  /** The sequence the next new event must use. */
  nextSequence: number;
}

/** New trace events can only be added while the run is running or paused. */
export class RunNotAcceptingTraceError extends Error {
  constructor(readonly status: RunStatus) {
    super(`A ${status} run does not take new trace events.`);
    this.name = "RunNotAcceptingTraceError";
  }
}

/** The batch does not line up with what is already stored for the run. */
export class TraceConflictError extends Error {
  constructor(
    readonly code: "trace_event_conflict" | "trace_sequence_gap",
    message: string,
    readonly nextSequence: number,
  ) {
    super(message);
    this.name = "TraceConflictError";
  }
}

/** The events break the trace rules in the shared contract (`checkTrace`). */
export class InvalidTraceError extends Error {
  constructor(readonly issues: ContractIssue[]) {
    super("The trace events are not consistent with the run.");
    this.name = "InvalidTraceError";
  }
}

/**
 * Persistence for redacted trace events. Events are append-only and scoped by
 * workspace through their run; appends to one run are serialised.
 */
export interface TraceStore {
  /** Ordered by sequence. Empty for an unknown run or another workspace's run. */
  listTraceEvents(workspaceId: string, runId: string): Promise<TraceEvent[]>;
  /**
   * Stores the events after the ones already there. Events that repeat stored
   * ones exactly are skipped, so a worker can safely retry a batch.
   */
  appendTraceEvents(input: AppendTraceInput): Promise<AppendTraceResult>;
}
