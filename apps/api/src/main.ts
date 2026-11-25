import { PrismaClient } from "@prisma/client";
import { buildServer } from "./server.js";
import { PrismaAgentStore, PrismaRunStore, PrismaWorkspaceStore } from "./store/prisma.js";

const prisma = new PrismaClient();
const app = buildServer({
  store: new PrismaWorkspaceStore(prisma),
  agents: new PrismaAgentStore(prisma),
  runs: new PrismaRunStore(prisma),
});

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

const port = Number(process.env.API_PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
