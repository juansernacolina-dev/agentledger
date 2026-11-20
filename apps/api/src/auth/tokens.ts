import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "alk_";

/** A new plain API token. Show it once; store only {@link hashToken}. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (token === undefined || !token.startsWith(TOKEN_PREFIX)) return null;
  return token;
}
