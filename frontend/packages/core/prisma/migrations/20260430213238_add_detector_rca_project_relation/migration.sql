-- CreateIndex
CREATE INDEX "ix_detector_rcas_project_id" ON "detector_rcas"("project_id");

-- AddForeignKey
ALTER TABLE "detector_rcas" ADD CONSTRAINT "detector_rcas_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
