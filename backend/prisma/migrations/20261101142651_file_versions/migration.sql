-- CreateTable
CREATE TABLE "file_versions" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version_id" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "etag" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_versions_file_id_created_at_idx" ON "file_versions"("file_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_file_id_version_id_key" ON "file_versions"("file_id", "version_id");

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing file gets one version row describing its current bytes.
-- Objects written before versioning was enabled have the S3 version id "null".
INSERT INTO "file_versions" ("id", "file_id", "version_id", "size", "etag", "mime_type", "created_at")
SELECT gen_random_uuid(), "id", COALESCE("version_id", 'null'), "size", "etag", "mime_type", "created_at"
FROM "files";
