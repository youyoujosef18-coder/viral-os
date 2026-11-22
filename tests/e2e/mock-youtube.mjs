// Testing only: a local stand-in for the YouTube Data API v3 responses used by Clip Studio.
// Start it, then run the app and worker with YOUTUBE_API_BASE_URL=http://127.0.0.1:4599/youtube/v3
import http from "node:http";

const PORT = Number(process.env.MOCK_YOUTUBE_PORT ?? 4599);
const VIDEO = {
  kind: "youtube#video",
  id: "Mock1234567",
  snippet: {
    publishedAt: "2026-10-01T12:00:00Z",
    channelId: "UCsomeoneelse000000000000",
    title: "How we built a cabin in 10 days",
    description: "0:00 Intro\n1:20 Foundations\n3:05 Raising the walls\n6:40 The roof\n9:00 Final tour",
    thumbnails: { high: { url: "https://i.ytimg.com/vi/Mock1234567/hqdefault.jpg" } },
    channelTitle: "Cabin Builders",
    liveBroadcastContent: "none",
  },
  contentDetails: { duration: "PT10M30S" },
  status: { privacyStatus: "public", embeddable: true },
  statistics: { viewCount: "120000", likeCount: "5400", commentCount: "830" },
};
const COMMENTS = [
  ["3:12 when the wall almost fell 😬", 2210],
  ["The moment at 3:15 had me screaming", 640],
  ["6:55 that roof timelapse is so satisfying", 1300],
  ["Love this channel", 900],
  ["9:20 the final reveal!!", 410],
  ["1:25 how deep did you dig?", 35],
];
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    console.log(req.method, url.pathname, url.searchParams.toString());
    if (!url.searchParams.get("key") && !req.headers.authorization) return json(res, 403, { error: { code: 403, message: "The request is missing a valid API key.", errors: [{ reason: "forbidden" }] } });
    if (url.pathname === "/youtube/v3/videos") return json(res, 200, { kind: "youtube#videoListResponse", items: url.searchParams.get("id") === VIDEO.id ? [VIDEO] : [] });
    if (url.pathname === "/youtube/v3/commentThreads") {
      return json(res, 200, { kind: "youtube#commentThreadListResponse", items: COMMENTS.map(([text, likes]) => ({ kind: "youtube#commentThread", snippet: { topLevelComment: { kind: "youtube#comment", snippet: { textDisplay: text, likeCount: likes, publishedAt: "2026-10-03T09:00:00Z" } } } })) });
    }
    json(res, 404, { error: { code: 404, message: "Not found", errors: [{ reason: "notFound" }] } });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock YouTube API on ${PORT}`));
