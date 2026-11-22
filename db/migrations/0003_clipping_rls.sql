ALTER TABLE "clip_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clip_jobs_owner_all" ON "clip_jobs" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clip_jobs" TO authenticated;--> statement-breakpoint
ALTER TABLE "clips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clips_owner_all" ON "clips" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clips" TO authenticated;
