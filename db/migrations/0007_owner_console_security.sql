-- Owner console tables are reachable only by the server's service connection: RLS on with no policies,
-- and no privileges for the user-facing roles (Supabase grants new tables to anon/authenticated by default).
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "app_settings", "invites", "admin_audit_log", "usage_events" FROM authenticated, anon;--> statement-breakpoint
-- Users may edit their own profile fields, but never role, disabled_at or last_seen_at, and they can't
-- insert profile rows (profiles are created by the server). Column grants enforce this in Postgres.
REVOKE INSERT, UPDATE ON "profiles" FROM authenticated;--> statement-breakpoint
GRANT UPDATE ("display_name", "avatar_url", "timezone", "niche", "default_language", "dashboard_layout", "preferences", "updated_at") ON "profiles" TO authenticated;
