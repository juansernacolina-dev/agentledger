import { randomBytes } from "node:crypto";

export type IdPrefix = "ws" | "usr" | "tok" | "agt" | "agv" | "run";

/** `<prefix>_<16 hex chars>`, matching the ID pattern in the run contract. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
