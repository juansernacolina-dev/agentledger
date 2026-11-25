import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRunSchema, parseRun, type AgentRun } from "../src/index.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

const fixtureNames = readdirSync(fixtureDir).filter((name) => name.endsWith(".json"));
const validFixtures = fixtureNames.filter((name) => name.startsWith("valid-"));
const invalidFixtures = fixtureNames.filter((name) => name.startsWith("invalid-"));

const expectedIssue: Record<string, { path: string; message: RegExp }> = {
  "invalid-missing-finished-at.json": { path: "finishedAt", message: /must have finishedAt/ },
  "invalid-pending-approval-while-running.json": { path: "status", message: /must be paused/ },
  "invalid-retry-over-budget.json": { path: "steps.3.attempt", message: /retry budget/ },
  "invalid-step-index-gap.json": { path: "steps.2.index", message: /expected step index 2/ },
  "invalid-unknown-field.json": { path: "(root)", message: /Unrecognized key/ },
};

describe("run contract fixtures", () => {
  it("ships at least one valid and one invalid fixture", () => {
    expect(validFixtures.length).toBeGreaterThan(0);
    expect(invalidFixtures.length).toBeGreaterThan(0);
  });

  it.each(validFixtures)("accepts %s", (name) => {
    const result = parseRun(loadFixture(name));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each(invalidFixtures)("rejects %s with the expected issue", (name) => {
    const expected = expectedIssue[name];
    expect(expected, `add an expected issue for ${name}`).toBeDefined();

    const result = parseRun(loadFixture(name));
    expect(result.ok).toBe(false);
    if (result.ok || !expected) return;
    expect(result.issues).toContainEqual({
      path: expected.path,
      message: expect.stringMatching(expected.message),
    });
  });
});

describe("run contract rules", () => {
  // Tests break the contract on purpose, so the version may hold any number.
  type EditableRun = Omit<AgentRun, "contractVersion"> & { contractVersion: number };
  const base = () => structuredClone(loadFixture("valid-succeeded.json")) as EditableRun;
  const step = (run: EditableRun, index: number) => {
    const found = run.steps[index];
    if (found === undefined) throw new Error(`fixture has no step ${index}`);
    return found;
  };

  it("rejects ids without the expected prefix", () => {
    const run = base();
    run.workspaceId = "workspace-1";
    const result = parseRun(run);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toContain("workspaceId");
  });

  it("rejects more steps than the budget allows", () => {
    const run = base();
    run.budget.maxSteps = 4;
    const result = parseRun(run);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toContain("steps");
  });

  it("rejects duplicate step ids", () => {
    const run = base();
    step(run, 1).id = step(run, 0).id;
    const result = parseRun(run);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toContain("steps.1.id");
  });

  it("requires an error message on errored steps only", () => {
    const missing = base();
    delete step(missing, 2).error;
    expect(!parseRun(missing).ok).toBe(true);

    const unexpected = base();
    step(unexpected, 0).error = "should not be here";
    expect(!parseRun(unexpected).ok).toBe(true);
  });

  it("rejects finishedAt before createdAt", () => {
    const run = base();
    run.finishedAt = "2026-01-15T08:59:59.000Z";
    const result = parseRun(run);
    expect(!result.ok && result.issues.map((issue) => issue.message)).toContain(
      "finishedAt is before createdAt",
    );
  });

  it("rejects a non-terminal run with finishedAt", () => {
    const run = base();
    run.status = "running";
    const result = parseRun(run);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toContain("finishedAt");
  });

  it("rejects an unknown contract version", () => {
    const run = base();
    run.contractVersion = 2;
    expect(parseRun(run).ok).toBe(false);
  });

  it("keeps fixture timing labelled as fixture timing", () => {
    const run = AgentRunSchema.parse(base());
    expect(run.timingSource).toBe("fixture");
  });
});
