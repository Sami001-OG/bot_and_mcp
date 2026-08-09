-- AlterTable
-- Backfill existing rows with their slug, then enforce NOT NULL + uniqueness.
ALTER TABLE "Workspace" ADD COLUMN "handle" TEXT;
UPDATE "Workspace" SET "handle" = "slug" WHERE "handle" IS NULL;
ALTER TABLE "Workspace" ALTER COLUMN "handle" SET NOT NULL;
CREATE UNIQUE INDEX "Workspace_handle_key" ON "Workspace"("handle");