/**
 * Seeds two synthetic workspaces for local development and prints a fresh API
 * token for each demo user. Safe to re-run: records are upserted, existing
 * agent versions are left untouched (they are immutable) and every run issues
 * new tokens. All names and emails are fictional.
 */
import { AgentVersionConfigSchema, type AgentVersionConfig } from "@agentledger/contracts";
import { PrismaClient, type Prisma, type WorkspaceRole } from "@prisma/client";
import { hashConfig } from "./agents/config-hash.js";
import { generateToken, hashToken } from "./auth/tokens.js";
import { newId } from "./ids.js";

const workspaces = [
  { id: "ws_acmesupport", slug: "acme-support", name: "Acme Support Agents" },
  { id: "ws_globexops", slug: "globex-ops", name: "Globex Operations" },
] as const;

const users: { id: string; email: string; displayName: string; roles: Record<string, WorkspaceRole> }[] = [
  {
    id: "usr_avaadmin",
    email: "ava.admin@example.test",
    displayName: "Ava (admin)",
    roles: { ws_acmesupport: "admin" },
  },
  {
    id: "usr_eliaseditor",
    email: "elias.editor@example.test",
    displayName: "Elias (editor)",
    roles: { ws_acmesupport: "editor" },
  },
  {
    id: "usr_rinareviewer",
    email: "rina.reviewer@example.test",
    displayName: "Rina (reviewer)",
    roles: { ws_acmesupport: "reviewer", ws_globexops: "viewer" },
  },
  {
    id: "usr_gusglobex",
    email: "gus.admin@example.test",
    displayName: "Gus (Globex admin)",
    roles: { ws_globexops: "admin" },
  },
];

const refundTools: AgentVersionConfig["tools"] = [
  { name: "lookup_order", description: "Read a fictional order by its number.", sensitive: false },
  { name: "issue_refund", description: "Refund part or all of a fictional order.", sensitive: true },
];

/** Two versions of one demo agent: v2 trades care for speed. */
const refundAgent = {
  id: "agt_acmerefunds",
  workspaceId: "ws_acmesupport",
  slug: "refund-assistant",
  name: "Refund assistant",
  description: "Answers refund questions for the fictional Acme store.",
  createdById: "usr_eliaseditor",
  versions: [
    {
      id: "agv_acmerefundsv1",
      notes: "First version: always looks up the order before answering.",
      config: {
        model: { provider: "fixture", name: "support-replay", temperature: 0, maxOutputTokens: 1024 },
        instructions:
          "Look up the order before answering. Never promise a refund; request one with issue_refund and wait for approval.",
        tools: refundTools,
        budget: { maxSteps: 12, maxDurationMs: 60_000, maxRetries: 2 },
      },
    },
    {
      id: "agv_acmerefundsv2",
      notes: "Faster: fewer steps and retries.",
      config: {
        model: { provider: "fixture", name: "support-replay-fast", temperature: 0.2, maxOutputTokens: 512 },
        instructions: "Answer refund questions quickly. Use issue_refund when the customer asks for money back.",
        tools: refundTools,
        budget: { maxSteps: 6, maxDurationMs: 20_000, maxRetries: 1 },
      },
    },
  ],
} as const;

async function seedAgents(prisma: PrismaClient) {
  const { versions, ...agent } = refundAgent;
  await prisma.agentDefinition.upsert({
    where: { id: agent.id },
    create: agent,
    update: { slug: agent.slug, name: agent.name, description: agent.description },
  });
  for (const [index, version] of versions.entries()) {
    const existing = await prisma.agentVersion.findUnique({ where: { id: version.id }, select: { id: true } });
    if (existing !== null) continue;
    const config = AgentVersionConfigSchema.parse(version.config);
    await prisma.agentVersion.create({
      data: {
        id: version.id,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        version: index + 1,
        config: config as unknown as Prisma.InputJsonObject,
        configHash: hashConfig(config),
        notes: version.notes,
        createdById: agent.createdById,
      },
    });
  }
}

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const ws of workspaces) {
      await prisma.workspace.upsert({
        where: { id: ws.id },
        create: ws,
        update: { slug: ws.slug, name: ws.name },
      });
    }

    const issued: { email: string; token: string }[] = [];
    for (const { roles, ...user } of users) {
      await prisma.user.upsert({ where: { id: user.id }, create: user, update: user });
      for (const [workspaceId, role] of Object.entries(roles)) {
        await prisma.membership.upsert({
          where: { workspaceId_userId: { workspaceId, userId: user.id } },
          create: { workspaceId, userId: user.id, role },
          update: { role },
        });
      }
      const token = generateToken();
      await prisma.apiToken.create({
        data: { id: newId("tok"), userId: user.id, tokenHash: hashToken(token), label: "seed" },
      });
      issued.push({ email: user.email, token });
    }

    await seedAgents(prisma);

    console.log("Seeded workspaces acme-support, globex-ops and agent refund-assistant (v1, v2).");
    console.log("Local API tokens:");
    for (const { email, token } of issued) console.log(`  ${email.padEnd(28)} ${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
