-- Owner-only Row Level Security. auth.uid() is provided by Supabase, or by db/bootstrap.sql locally.
-- Server code runs user queries as role `authenticated` with request.jwt.claims set (see src/lib/db/client.ts).
GRANT USAGE ON SCHEMA public TO authenticated;--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "profiles_owner_all" ON "profiles" FOR ALL TO authenticated USING ("id" = auth.uid()) WITH CHECK ("id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "profiles" TO authenticated;--> statement-breakpoint
ALTER TABLE "platform_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "platform_connections_owner_all" ON "platform_connections" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_connections" TO authenticated;--> statement-breakpoint
ALTER TABLE "oauth_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "oauth_states_owner_all" ON "oauth_states" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "oauth_states" TO authenticated;--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_assets_owner_all" ON "media_assets" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_assets" TO authenticated;--> statement-breakpoint
ALTER TABLE "content_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_projects_owner_all" ON "content_projects" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "content_projects" TO authenticated;--> statement-breakpoint
ALTER TABLE "project_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "project_versions_owner_all" ON "project_versions" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "project_versions" TO authenticated;--> statement-breakpoint
ALTER TABLE "scripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scripts_owner_all" ON "scripts" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "scripts" TO authenticated;--> statement-breakpoint
ALTER TABLE "script_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "script_versions_owner_all" ON "script_versions" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "script_versions" TO authenticated;--> statement-breakpoint
ALTER TABLE "research_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "research_runs_owner_all" ON "research_runs" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "research_runs" TO authenticated;--> statement-breakpoint
ALTER TABLE "ideas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ideas_owner_all" ON "ideas" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ideas" TO authenticated;--> statement-breakpoint
ALTER TABLE "keyword_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "keyword_lists_owner_all" ON "keyword_lists" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "keyword_lists" TO authenticated;--> statement-breakpoint
ALTER TABLE "keywords" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "keywords_owner_all" ON "keywords" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "keywords" TO authenticated;--> statement-breakpoint
ALTER TABLE "trend_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "trend_items_owner_all" ON "trend_items" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "trend_items" TO authenticated;--> statement-breakpoint
ALTER TABLE "trend_watchlists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "trend_watchlists_owner_all" ON "trend_watchlists" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "trend_watchlists" TO authenticated;--> statement-breakpoint
ALTER TABLE "competitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "competitors_owner_all" ON "competitors" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "competitors" TO authenticated;--> statement-breakpoint
ALTER TABLE "competitor_content" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "competitor_content_owner_all" ON "competitor_content" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "competitor_content" TO authenticated;--> statement-breakpoint
ALTER TABLE "thumbnails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "thumbnails_owner_all" ON "thumbnails" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "thumbnails" TO authenticated;--> statement-breakpoint
ALTER TABLE "video_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "video_analyses_owner_all" ON "video_analyses" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "video_analyses" TO authenticated;--> statement-breakpoint
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "posts_owner_all" ON "posts" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "posts" TO authenticated;--> statement-breakpoint
ALTER TABLE "post_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "post_targets_owner_all" ON "post_targets" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "post_targets" TO authenticated;--> statement-breakpoint
ALTER TABLE "publish_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "publish_events_owner_all" ON "publish_events" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "publish_events" TO authenticated;--> statement-breakpoint
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workflows_owner_all" ON "workflows" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflows" TO authenticated;--> statement-breakpoint
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workflow_runs_owner_all" ON "workflow_runs" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_runs" TO authenticated;--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agents_owner_all" ON "agents" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "agents" TO authenticated;--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_runs_owner_all" ON "agent_runs" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_runs" TO authenticated;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "metric_snapshots_owner_all" ON "metric_snapshots" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "metric_snapshots" TO authenticated;--> statement-breakpoint
ALTER TABLE "experiments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "experiments_owner_all" ON "experiments" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "experiments" TO authenticated;--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notifications_owner_all" ON "notifications" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO authenticated;--> statement-breakpoint
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "activity_log_owner_all" ON "activity_log" FOR ALL TO authenticated USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_log" TO authenticated;--> statement-breakpoint
-- Credentials and sessions are never reachable from the authenticated role.
ALTER TABLE "local_auth_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "local_auth_users" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON "sessions" FROM authenticated;
