import { route, readJson } from "@/lib/api/handler";
import { createClipJob, listClipJobs } from "@/lib/services/clipping";
import { isTranscriptionConfigured } from "@/lib/clipping/transcript";
import { isAIConfigured } from "@/lib/providers/ai";
import { ffmpegAvailable } from "@/lib/services/analyzer";
import { isQueueConfigured } from "@/lib/queue/queues";
import { youtubeClipCapabilities } from "@/lib/services/youtube-clips";

export const GET = route(async ({ user }) => ({
  jobs: await listClipJobs(user.id),
  capabilities: { transcription: isTranscriptionConfigured(), ai: isAIConfigured(), ffmpeg: await ffmpegAvailable(), queue: isQueueConfigured(), youtube: await youtubeClipCapabilities(user.id) },
}));

export const POST = route(async ({ req, user }) => createClipJob(user.id, await readJson(req)), { rateLimit: { bucket: "clips", limit: 30, windowSeconds: 3600 } });
