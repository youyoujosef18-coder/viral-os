ALTER TABLE "clip_jobs" ADD COLUMN "source_type" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_jobs" ADD COLUMN "youtube_video_id" text;