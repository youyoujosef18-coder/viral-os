CREATE TABLE "clip_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_asset_id" uuid,
	"project_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"stage" text,
	"settings" jsonb NOT NULL,
	"transcript_source" text DEFAULT 'none' NOT NULL,
	"transcript" jsonb,
	"source" jsonb,
	"signals" jsonb,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"title" text NOT NULL,
	"hook" text,
	"caption" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"computed_score" integer NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"ai_score" integer,
	"ai_reason" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"render_settings" jsonb NOT NULL,
	"asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"render_info" jsonb,
	"error" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_jobs" ADD CONSTRAINT "clip_jobs_source_asset_id_media_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_jobs" ADD CONSTRAINT "clip_jobs_project_id_content_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."content_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_job_id_clip_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."clip_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_thumbnail_asset_id_media_assets_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_jobs_user_idx" ON "clip_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_jobs_status_idx" ON "clip_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clips_job_idx" ON "clips" USING btree ("job_id","rank");--> statement-breakpoint
CREATE INDEX "clips_status_idx" ON "clips" USING btree ("status");