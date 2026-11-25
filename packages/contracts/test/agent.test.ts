import { describe, expect, it } from "vitest";
import { AgentSlugSchema, AgentVersionConfigSchema, type AgentVersionConfig } from "../src/index.js";

const config = (): AgentVersionConfig => ({
  model: { provider: "fixture", name: "support-replay", temperature: 0, maxOutputTokens: 1024 },
  instructions: "Answer billing questions. Ask for approval before issuing a refund.",
  tools: [
    { name: "lookup_order", description: "Read an order by its number.", sensitive: false },
    { name: "issue_refund", description: "Refund part or all of an order.", sensitive: true },
  ],
  budget: { maxSteps: 12, maxDurationMs: 60_000, maxRetries: 2 },
});

describe("agent version config", () => {
  it("accepts a fixture-backed config", () => {
    expect(AgentVersionConfigSchema.safeParse(config()).success).toBe(true);
  });

  it("rejects duplicate tool names", () => {
    const input = config();
    input.tools.push({ name: "lookup_order", description: "Again.", sensitive: false });
    const result = AgentVersionConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("tools.2.name");
  });

  it("rejects unknown fields and out-of-range model settings", () => {
    const extra = { ...config(), apiKey: "sk-not-allowed" };
    expect(AgentVersionConfigSchema.safeParse(extra).success).toBe(false);

    const hot = config();
    hot.model.temperature = 3;
    expect(AgentVersionConfigSchema.safeParse(hot).success).toBe(false);
  });

  it("reuses the run budget limits", () => {
    const input = config();
    input.budget.maxRetries = 9;
    expect(AgentVersionConfigSchema.safeParse(input).success).toBe(false);
  });
});

describe("agent slug", () => {
  it.each(["support-triage", "faq2", "a-b-c"])("accepts %s", (slug) => {
    expect(AgentSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(["ab", "Support", "two--hyphens", "-leading", "has space"])("rejects %s", (slug) => {
    expect(AgentSlugSchema.safeParse(slug).success).toBe(false);
  });
});
