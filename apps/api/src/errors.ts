/** An error that maps directly to an HTTP response with a stable error code. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Extra machine-readable context, sent as `error.details`. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const unauthorized = () =>
  new HttpError(401, "unauthorized", "A valid API token is required.");

/**
 * Non-members get the same response as for a workspace that does not exist,
 * so workspace IDs cannot be probed across tenants.
 */
export const workspaceNotFound = () =>
  new HttpError(404, "workspace_not_found", "Workspace not found.");

export const forbidden = (required: string) =>
  new HttpError(403, "forbidden", `This action requires the ${required} role.`);

export const agentNotFound = () => new HttpError(404, "agent_not_found", "Agent not found.");

export const versionNotFound = () =>
  new HttpError(404, "version_not_found", "Agent version not found.");

export const runNotFound = () => new HttpError(404, "run_not_found", "Run not found.");
