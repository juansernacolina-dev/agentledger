import { z } from "zod";
import { RunBudgetSchema } from "./run.js";

/**
 * Agent definitions and their immutable versions.
 *
 * A definition is the stable name of an agent inside a workspace. Every change
 * to how the agent behaves is published as a new version with its own
 * configuration; runs always point at the exact version they used, so a
 * version can never be edited once it exists.
 */

export const AgentSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens");

/** A tool the agent may call. Sensitive tools pause the run for a review. */
export const AgentToolSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case"),
    description: z.string().trim().min(1).max(500),
    sensitive: z.boolean(),
  })
  .strict();
export type AgentTool = z.infer<typeof AgentToolSchema>;

export const AgentModelSchema = z
  .object({
    /**
     * `fixture` replays recorded responses and needs no API key; the other
     * providers are only used when a key is configured.
     */
    provider: z.enum(["fixture", "anthropic", "openai"]),
    name: z.string().trim().min(1).max(100),
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().min(1).max(32_000),
  })
  .strict();

export const AgentVersionConfigSchema = z
  .object({
    model: AgentModelSchema,
    instructions: z.string().trim().min(1).max(20_000),
    tools: z.array(AgentToolSchema).max(50),
    budget: RunBudgetSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", index, "name"],
          message: `duplicate tool name "${tool.name}"`,
        });
      }
      seen.add(tool.name);
    });
  });
export type AgentVersionConfig = z.infer<typeof AgentVersionConfigSchema>;
