-- CreateTable
CREATE TABLE "agent_definitions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_definitions_created_by_id_idx" ON "agent_definitions"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_definitions_workspace_id_slug_key" ON "agent_definitions"("workspace_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "agent_definitions_id_workspace_id_key" ON "agent_definitions"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "agent_versions_workspace_id_idx" ON "agent_versions"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_versions_created_by_id_idx" ON "agent_versions"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_id_workspace_id_key" ON "agent_versions"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_workspace_id_fkey" FOREIGN KEY ("agent_id", "workspace_id") REFERENCES "agent_definitions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Version numbers start at 1 and the hash is a lowercase SHA-256 hex digest.
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_version_check" CHECK ("version" >= 1);
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_config_hash_check" CHECK ("config_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_config_object_check" CHECK (jsonb_typeof("config") = 'object');

-- Published versions are immutable: runs must always point at exactly what ran.
CREATE FUNCTION "agent_versions_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent version % is immutable; publish a new version instead', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "agent_versions_immutable"
BEFORE UPDATE OR DELETE ON "agent_versions"
FOR EACH ROW EXECUTE FUNCTION "agent_versions_reject_change"();
