/**
 * Workspace roles, from least to most privileged. Each role includes the
 * permissions of the roles before it.
 *
 * - viewer:   read agents, runs, traces and evaluation results
 * - reviewer: also decide on paused sensitive actions
 * - editor:   also publish agent versions and start runs and evaluations
 * - admin:    also manage the workspace and its members
 */
export const WORKSPACE_ROLES = ["viewer", "reviewer", "editor", "admin"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function hasRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLES.indexOf(actual) >= WORKSPACE_ROLES.indexOf(required);
}
