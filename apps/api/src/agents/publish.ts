import {
  VersionConflictError,
  VersionUnchangedError,
  type PublishVersionInput,
} from "../store/types.js";

/**
 * The publishing rules shared by every store: optional optimistic check, no
 * empty versions, numbers increase by one. Returns the next version number.
 */
export function nextVersionNumber(
  latest: { version: number; configHash: string } | null,
  input: Pick<PublishVersionInput, "configHash" | "expectedLatestVersion">,
): number {
  const latestNumber = latest?.version ?? null;
  if (input.expectedLatestVersion !== undefined && input.expectedLatestVersion !== latestNumber) {
    throw new VersionConflictError(input.expectedLatestVersion, latestNumber);
  }
  if (latest !== null && latest.configHash === input.configHash) {
    throw new VersionUnchangedError(latest.version);
  }
  return (latestNumber ?? 0) + 1;
}
