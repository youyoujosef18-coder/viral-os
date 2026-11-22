/**
 * Clip Studio with YouTube links. YouTube's HTTP API is replaced by a mock transport that returns
 * responses shaped like the documented ones (videos.list, commentThreads.list, captions.list/download,
 * YouTube Analytics reports). Postgres + RLS, the worker step and (for owned videos) real ffmpeg rendering
 * from an attached original file all run for real.
 *
 * The request log is asserted on: the only hosts contacted are the YouTube Data API and the YouTube
 * Analytics API. The video media itself is never requested.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { setFetchForTests } from "@/lib/providers/http";
import { saveConnection } from "@/lib/services/connections";
import { saveUpload } from "@/lib/services/media";
import { createClipJob, getClipJob, listClipJobs, renderClipRow, requestRender, runClipJob, updateClip } from "@/lib/services/clipping";
import { addManualClip, attachOriginal, youtubeClipCapabilities } from "@/lib/services/youtube-clips";
import { YOUTUBE_CAPTION_SCOPE } from "@/lib/providers/platforms/youtube";
import { createUser } from "../helpers";

const SINTEL = path.join(process.cwd(), "tests/fixtures/real/sintel-short.mp4");
const VTT = path.join(process.cwd(), "tests/fixtures/real/sintel-en.vtt");
const haveFixtures = existsSync(SINTEL) && existsSync(VTT);

type Video = { id: string; channelId: string; seconds: number; description?: string; embeddable?: boolean; live?: string };
let videos: Record<string, Video> = {};
let comments: Record<string, { text: string; likes: number }[] | "disabled"> = {};
let retentionRows: number[][] | null = null;
let log: string[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gErr = (status: number, reason: string, message: string) => json(status, { error: { code: status, message, errors: [{ reason, message }] } });

function iso(seconds: number) {
  return `PT${Math.floor(seconds / 60)}M${seconds % 60}S`;
}

async function mockYouTube(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  log.push(`${url.host}${url.pathname}`);
  const auth = new Headers(init?.headers).get("authorization");
  if (url.host === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
    const v = videos[url.searchParams.get("id") ?? ""];
    if (!url.searchParams.get("key") && !auth) return gErr(403, "forbidden", "The request is missing a valid API key.");
    return json(200, {
      kind: "youtube#videoListResponse",
      items: v ? [{ kind: "youtube#video", id: v.id, snippet: { publishedAt: "2026-10-01T12:00:00Z", channelId: v.channelId, title: `Video ${v.id}`, description: v.description ?? "", thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` } }, channelTitle: "Some Channel", liveBroadcastContent: v.live ?? "none" }, contentDetails: { duration: iso(v.seconds) }, status: { privacyStatus: "public", embeddable: v.embeddable ?? true }, statistics: { viewCount: "1000", likeCount: "10", commentCount: "5" } }] : [],
    });
  }
  if (url.host === "www.googleapis.com" && url.pathname === "/youtube/v3/commentThreads") {
    const c = comments[url.searchParams.get("videoId") ?? ""] ?? [];
    if (c === "disabled") return gErr(403, "commentsDisabled", "The video identified by the videoId parameter has disabled comments.");
    expect(url.searchParams.get("textFormat")).toBe("plainText");
    const page = Number(url.searchParams.get("pageToken") ?? 0);
    const slice = c.slice(page * 2, page * 2 + 2); // tiny pages to exercise pagination
    return json(200, { kind: "youtube#commentThreadListResponse", nextPageToken: page * 2 + 2 < c.length ? String(page + 1) : undefined, items: slice.map((x) => ({ kind: "youtube#commentThread", snippet: { topLevelComment: { kind: "youtube#comment", snippet: { textDisplay: x.text, likeCount: x.likes, publishedAt: "2026-10-02T00:00:00Z" } } } })) });
  }
  if (url.host === "www.googleapis.com" && url.pathname === "/youtube/v3/captions") {
    if (auth !== "Bearer owner-token") return gErr(403, "forbidden", "The permissions associated with the request are not sufficient to download the caption track.");
    return json(200, { kind: "youtube#captionListResponse", items: [{ kind: "youtube#caption", id: "asr-track", snippet: { trackKind: "ASR", language: "en", name: "", isDraft: false, status: "serving" } }, { kind: "youtube#caption", id: "std-track", snippet: { trackKind: "standard", language: "en", name: "English", isDraft: false, status: "serving" } }] });
  }
  if (url.host === "www.googleapis.com" && url.pathname.startsWith("/youtube/v3/captions/")) {
    if (auth !== "Bearer owner-token") return gErr(403, "forbidden", "forbidden");
    expect(url.pathname).toBe("/youtube/v3/captions/std-track");
    expect(url.searchParams.get("tfmt")).toBe("vtt");
    return new Response(readFileSync(VTT, "utf8"), { status: 200, headers: { "content-type": "text/vtt" } });
  }
  if (url.host === "youtubeanalytics.googleapis.com" && url.pathname === "/v2/reports") {
    expect(url.searchParams.get("ids")).toBe("channel==MINE");
    expect(url.searchParams.get("dimensions")).toBe("elapsedVideoTimeRatio");
    expect(url.searchParams.get("filters")).toMatch(/^video==/);
    if (auth !== "Bearer owner-token") return gErr(403, "forbidden", "Forbidden");
    return json(200, { kind: "youtubeAnalytics#resultTable", columnHeaders: [{ name: "elapsedVideoTimeRatio", columnType: "DIMENSION", dataType: "FLOAT" }, { name: "audienceWatchRatio", columnType: "METRIC", dataType: "FLOAT" }, { name: "relativeRetentionPerformance", columnType: "METRIC", dataType: "FLOAT" }], rows: retentionRows ?? [] });
  }
  return new Response("unexpected request", { status: 599 });
}

beforeEach(() => {
  videos = {};
  comments = {};
  retentionRows = null;
  log = [];
  setFetchForTests(mockYouTube as typeof fetch);
});
afterEach(() => setFetchForTests(null));

async function ownedChannel(userId: string, channelId: string, captions = true) {
  return saveConnection(userId, "youtube", { accessToken: "owner-token", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), scopes: ["https://www.googleapis.com/auth/youtube.readonly", ...(captions ? [YOUTUBE_CAPTION_SCOPE] : [])] }, { externalAccountId: channelId, name: "My Channel" });
}

describe("YouTube clip jobs (official API data only)", () => {
  it("finds moments in someone else's video from chapters and comment timestamps and plays them in the embed player", async () => {
    const user = await createUser();
    videos.aaaaaaaaaaa = { id: "aaaaaaaaaaa", channelId: "UCother", seconds: 600, description: "0:00 Intro\n1:30 Setup\n3:15 The twist\n7:00 Ending" };
    comments.aaaaaaaaaaa = [
      { text: "3:20 I did not see that coming", likes: 812 },
      { text: "the twist at 3:22 😂", likes: 95 },
      { text: "great video", likes: 400 },
      { text: "8:05 the ending got me", likes: 12 },
      { text: "Commenting at 99:99 nothing", likes: 1 },
    ];
    const job = await createClipJob(user.id, { source: "youtube", url: "https://youtu.be/aaaaaaaaaaa", minSeconds: 15, maxSeconds: 30, count: 3, commentPages: 5 });
    expect(job.sourceType).toBe("youtube");
    expect(job.youtubeVideoId).toBe("aaaaaaaaaaa");
    expect(await runClipJob(job.id)).toBe("completed");

    const d = await getClipJob(user.id, job.id);
    expect(d.status).toBe("completed");
    expect(d.clips.length).toBe(3);
    for (const c of d.clips) {
      expect(c.status).toBe("embed");
      expect(c.assetId).toBeNull();
      expect(Number.isInteger(c.startSec) && Number.isInteger(c.endSec)).toBe(true);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(15);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(30);
    }
    const top = d.clips[0];
    expect(top.startSec).toBeLessThanOrEqual(200);
    expect(top.endSec).toBeGreaterThanOrEqual(202);
    expect(Object.keys(top.scoreBreakdown).sort()).toEqual(["community", "structure"]);
    expect(top.title).toBe("The twist");
    expect(d.notes.join(" ")).toMatch(/Read 5 comments; 3 mention a timestamp/);
    expect(d.notes.join(" ")).toMatch(/isn't on a channel you've connected/);
    expect(d.notes.join(" ")).toMatch(/Used about 4 YouTube API quota units/); // 1 videos.list + 3 comment pages
    expect((d.source as { quotaUnits: number }).quotaUnits).toBe(4);

    // Only YouTube's data APIs were contacted, never a media URL.
    expect(new Set(log)).toEqual(new Set(["www.googleapis.com/youtube/v3/videos", "www.googleapis.com/youtube/v3/commentThreads"]));

    const list = await listClipJobs(user.id);
    expect(list.find((j) => j.id === job.id)).toMatchObject({ sourceType: "youtube", sourceFilename: "Video aaaaaaaaaaa", clipCount: 3 });
  });

  it("edits embed clips in whole seconds without queuing renders, and refuses renders and attachments", async () => {
    const user = await createUser();
    videos.bbbbbbbbbbb = { id: "bbbbbbbbbbb", channelId: "UCother", seconds: 300 };
    comments.bbbbbbbbbbb = [{ text: "1:00 wow", likes: 3 }];
    const job = await createClipJob(user.id, { source: "youtube", url: "bbbbbbbbbbb", minSeconds: 15, maxSeconds: 30, count: 1 });
    await runClipJob(job.id);
    const [clip] = (await getClipJob(user.id, job.id)).clips;
    const edited = await updateClip(user.id, clip.id, { startSec: 50.4, endSec: 70.2, title: "Renamed" });
    expect(edited).toMatchObject({ startSec: 50, endSec: 71, status: "embed", title: "Renamed" });
    await expect(requestRender(user.id, clip.id)).rejects.toMatchObject({ status: 409, code: "embed_only" });
    await expect(updateClip(user.id, clip.id, { endSec: 301.5 })).rejects.toMatchObject({ status: 400 });
    await expect(attachOriginal(user.id, job.id, clip.id)).rejects.toMatchObject({ status: 403, code: "not_owner" });

    const manual = await addManualClip(user.id, job.id, { startSec: 10.6, endSec: 25.1 });
    expect(manual).toMatchObject({ rank: 2, startSec: 10, endSec: 26, status: "embed", computedScore: 0, title: "Clip 2" });
    await expect(addManualClip(user.id, job.id, { startSec: 290, endSec: 320 })).rejects.toMatchObject({ status: 400 });
    await expect(addManualClip(user.id, job.id, { startSec: 0, endSec: 200 })).rejects.toMatchObject({ status: 400 });

    const other = await createUser();
    await expect(getClipJob(other.id, job.id)).rejects.toMatchObject({ status: 404 });
    await expect(addManualClip(other.id, job.id, { startSec: 1, endSec: 20 })).rejects.toMatchObject({ status: 404 });
  });

  it("completes with no clips and says why when there's no data, and handles disabled comments and embedding", async () => {
    const user = await createUser();
    videos.ccccccccccc = { id: "ccccccccccc", channelId: "UCother", seconds: 120, embeddable: false };
    comments.ccccccccccc = "disabled";
    const job = await createClipJob(user.id, { source: "youtube", url: "https://www.youtube.com/watch?v=ccccccccccc", minSeconds: 15, maxSeconds: 30 });
    expect(await runClipJob(job.id)).toBe("completed");
    const d = await getClipJob(user.id, job.id);
    expect(d.clips).toEqual([]);
    const notes = d.notes.join(" ");
    expect(notes).toMatch(/Comments are turned off/);
    expect(notes).toMatch(/no chapters, timestamped comments, retention data or captions/);
    expect(notes).toMatch(/turned off embedding/);
  });

  it("validates links, missing videos, live streams, length and caption access", async () => {
    const user = await createUser();
    videos.ddddddddddd = { id: "ddddddddddd", channelId: "UCother", seconds: 10 };
    videos.eeeeeeeeeee = { id: "eeeeeeeeeee", channelId: "UCother", seconds: 0, live: "live" };
    videos.fffffffffff = { id: "fffffffffff", channelId: "UCother", seconds: 400 };
    await expect(createClipJob(user.id, { source: "youtube", url: "https://vimeo.com/1" })).rejects.toMatchObject({ status: 400 });
    await expect(createClipJob(user.id, { source: "youtube", url: "zzzzzzzzzzz" })).rejects.toMatchObject({ status: 404 });
    await expect(createClipJob(user.id, { source: "youtube", url: "eeeeeeeeeee" })).rejects.toThrow(/Live streams/);
    await expect(createClipJob(user.id, { source: "youtube", url: "ddddddddddd", minSeconds: 15, maxSeconds: 30 })).rejects.toThrow(/shorter than the 15s minimum/);
    await expect(createClipJob(user.id, { source: "youtube", url: "fffffffffff", transcriptMode: "youtube" })).rejects.toThrow(/only be read for videos on a channel you've connected/);
    await ownedChannel(user.id, "UCother", false);
    await expect(createClipJob(user.id, { source: "youtube", url: "fffffffffff", transcriptMode: "youtube" })).rejects.toThrow(/doesn't include caption access/);
    const caps = await youtubeClipCapabilities(user.id);
    expect(caps).toMatchObject({ apiKey: true, channels: [{ name: "My Channel", captions: false }] });
  });

  describe.skipIf(!haveFixtures)("your own videos", () => {
    it("uses retention and your caption track, then renders real clips from your attached original", async () => {
      const user = await createUser();
      await ownedChannel(user.id, "UCmine");
      videos.ggggggggggg = { id: "ggggggggggg", channelId: "UCmine", seconds: 120 };
      // Rewatched section around 40–60% of the video (48–72 s).
      retentionRows = Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, i >= 40 && i < 60 ? 1.3 : Math.max(0.2, 1 - i / 100), 0.6]);
      const job = await createClipJob(user.id, { source: "youtube", url: "https://www.youtube.com/shorts/ggggggggggg", minSeconds: 8, maxSeconds: 20, count: 2, commentPages: 0, transcriptMode: "youtube" });
      expect((job.source as { owned: boolean }).owned).toBe(true);
      expect(await runClipJob(job.id)).toBe("completed");

      const d = await getClipJob(user.id, job.id);
      expect(d.transcriptSource).toBe("youtube");
      expect(d.transcript?.[0].text).toBe("This blade has a dark past.");
      expect(d.notes.join(" ")).toMatch(/Used the English caption track/);
      expect(d.notes.join(" ")).toMatch(/Used about 251 YouTube API quota units/); // 1 + 50 + 200
      expect(d.clips.length).toBe(2);
      expect(Object.keys(d.clips[0].scoreBreakdown).sort()).toEqual(["completeness", "hook", "retention", "speech"]);
      expect(d.clips.every((c) => c.status === "embed")).toBe(true);
      expect(log).toContain("youtubeanalytics.googleapis.com/v2/reports");
      expect(log.some((l) => /googlevideo|videoplayback/.test(l))).toBe(false);

      // Attach the original file (Sintel stands in for the creator's own upload).
      const asset = await saveUpload(user.id, { name: "my-original.mp4", type: "video/mp4", buffer: readFileSync(SINTEL) });
      await attachOriginal(user.id, job.id, asset.id);
      const after = await getClipJob(user.id, job.id);
      expect(after.sourceAsset?.id).toBe(asset.id);
      expect(after.clips.every((c) => c.status === "candidate")).toBe(true);

      const clip = after.clips[0];
      await requestRender(user.id, clip.id);
      expect(await renderClipRow(clip.id)).toBe("ready");
      const [row] = await withUser(user.id, (tx) => tx.select().from(schema.clips).where(eq(schema.clips.id, clip.id)));
      expect(row.renderInfo).toMatchObject({ width: 720, height: 1280 });
      expect(Math.abs(Number((row.renderInfo as { duration: number }).duration) - (clip.endSec - clip.startSec))).toBeLessThan(0.3);
    }, 180_000);

    it("refuses to render from a file whose length doesn't match the YouTube video", async () => {
      const user = await createUser();
      await ownedChannel(user.id, "UCmine2");
      videos.hhhhhhhhhhh = { id: "hhhhhhhhhhh", channelId: "UCmine2", seconds: 300, description: "0:00 a\n0:40 b\n1:30 c" };
      const job = await createClipJob(user.id, { source: "youtube", url: "hhhhhhhhhhh", minSeconds: 15, maxSeconds: 30, count: 1, commentPages: 0 });
      await runClipJob(job.id);
      const asset = await saveUpload(user.id, { name: "wrong.mp4", type: "video/mp4", buffer: readFileSync(SINTEL) });
      await attachOriginal(user.id, job.id, asset.id);
      const [clip] = (await getClipJob(user.id, job.id)).clips;
      await requestRender(user.id, clip.id);
      expect(await renderClipRow(clip.id)).toBe("failed");
      const [row] = await serviceDb().select().from(schema.clips).where(eq(schema.clips.id, clip.id));
      expect(row.error).toMatch(/attached file is 120\.0s long but the YouTube video is 300s/);
    }, 120_000);
  });
});
