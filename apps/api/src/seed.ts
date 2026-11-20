/**
 * Seeds two synthetic workspaces for local development and prints a fresh API
 * token for each demo user. Safe to re-run: records are upserted and every run
 * issues new tokens. All names and emails are fictional.
 */
import { PrismaClient, type WorkspaceRole } from "@prisma/client";
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

    console.log("Seeded workspaces: acme-support, globex-ops. Local API tokens:");
    for (const { email, token } of issued) console.log(`  ${email.padEnd(28)} ${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
