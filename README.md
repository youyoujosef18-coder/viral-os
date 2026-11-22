# VIRAL OS

**Research. Create. Publish. Grow.**

A creator platform for researching, writing, optimizing, scheduling, publishing and analyzing content on YouTube, TikTok and Instagram from one dashboard. It has its own branding and design and uses only official platform APIs.

---

## What's in the box

| Area | What it does | Where the numbers come from |
|---|---|---|
| **Overview** | KPIs with previous-period comparison, performance chart, top/underperforming content, best publishing times, schedule, failures, automations, account health, AI next-best-actions. Widgets can be reordered and hidden (saved per user). | Platform APIs (synced snapshots) + your workspace. AI recommendations reason only over those facts. |
| **AI Research** | Niche research (pain points, questions, search intent, gaps, viral formats, angles, clusters, series), personas, briefs, and ideas scored on 8 factors | AI estimates. The overall score uses a fixed, documented weighted formula over the AI factor scores. |
| **Trend Radar** | Most-popular videos by region, momentum, opportunity score, estimated window, saved trends, watchlists with alerts, ideas from a trend | YouTube Data API (verified). Momentum, opportunity and expiry are **computed** from snapshots; expiry is labeled as an estimate. |
| **Keyword Explorer** | Discovery, long-tail and question keywords, clusters, intent, difficulty and opportunity, title suggestions, gaps, lists, CSV export | Expansion is AI. Difficulty and opportunity are **computed from real top-20 YouTube results** on demand. **Search volume is never invented**; it shows "Not available" because no licensed volume provider is configured. |
| **Competitor Intelligence** | Track channels, uploads per week, median views, short-form share, title patterns, outliers, comparison table, AI pattern analysis, original ideas | YouTube public data API (verified + computed). TikTok/Instagram have no official API for other creators' analytics, so those are tracked manually and labeled as manual. |
| **Content Studio** | Projects with format, platforms, audience, language, tone, references, assets, due date, notes; drag-and-drop pipeline board; list view; duplicate; automatic version history and restore | Your data |
| **AI Script Writer** | Scene-by-scene scripts (hook, voiceover, visuals, on-screen text, B-roll, transitions, editing notes, CTA, caption, hashtags, titles, description, pinned comment, repurposing), 10 controls, variations, hook and asset generators, per-section AI edits (regenerate, shorten, expand, change tone, improve hook, make natural, translate, rewrite), autosave, 50-version history, copy and export (md/txt/json) | AI |
| **Thumbnail Lab** | Concepts with prompts and paired titles, optional image generation, **measured** contrast, mobile readability, visual hierarchy, WCAG text contrast, focal point; library, side-by-side comparison, export | Image analysis with sharp (computed, no AI) |
| **Clip Studio** | Turns a long video you uploaded into short clips: measures loudness, pauses and scene cuts (ffmpeg); follows your transcript (uploaded .srt/.vtt, or OpenAI speech-to-text) so clips start and end on full sentences; ranks with a documented score; renders 9:16 / 1:1 / 16:9 with crop-with-focus, blurred fill or letterbox, burned-in word-group captions, fades and -14 LUFS loudness; trim and re-render; download; send to Publishing as a draft. Runs on the worker. **YouTube links:** finds moments without downloading the video, from official API data only (description chapters, timestamps viewers wrote in comments weighted by likes, and for videos on your connected channel the YouTube Analytics retention curve and your caption track). Each clip is a start/end range played in YouTube's official embedded player, with timestamp links and embed code. For your own videos you can attach your original file and render real clips from it. | Measured signals (computed). With an AI provider and a transcript, an AI estimate is blended 50/50 and labeled. Never downloads videos from YouTube or other sites. |
| **Video Analyzer** | **Measured** duration, orientation, fps, scene cuts, cuts/min, time to first cut (ffmpeg), plus AI-assessed hook, clarity, retention potential, originality, platform fit, CTA, ranked recommendations, alternative hooks and titles, confidence | ffprobe/ffmpeg (computed) + AI assessment, clearly labeled as predicted, never actual |
| **Publishing Center** | Compose once, customize per platform (title, caption, hashtags, privacy, thumbnail, platform options), previews, publish now, schedule with timezone, drafts, review states, queue, retry, cancel, duplicate, repost, full event history, notifications | Status comes from the platform APIs; **published only after the platform confirms** |
| **Automation Workflows** | Triggers: manual, cron schedule with timezone, post published, post failed, trend watchlist match. Steps: notify, sync analytics, refresh trends, generate ideas, run agent, retry failed posts. Run history with per-step logs. | n/a |
| **Content Calendar** | Month/week views in your timezone; drag to reschedule (keeps time of day) | Your data |
| **Analytics** | KPIs, views over time, per-account sync, content table with sort/filter/pagination, CSV export | Platform APIs only |
| **Experiments** | Title/thumbnail/hook/caption/time/format tests, variants linked to published content, **pull verified metrics** from synced snapshots or enter manually, lift vs. A, winner, conclusion | Platform APIs or manual (labeled) |
| **AI Agents** | Reusable agents with instructions and output format, templates, run history; usable as automation steps | AI |
| **Media Library** | Upload (drag and drop, progress), folders, tags, search, preview (video/image/audio), download, delete | Your files |
| **Global** | Ctrl/Cmd-K search across the workspace and AI assistant, quick create, notifications center, connection status, universal upload, activity history, help docs | |

Every number in the UI carries a source tag: **Verified** (platform API, with retrieval time), **Computed** (formula over verified data), **AI estimate**, or **Manual**.

---

## Architecture

```
Browser (Next.js client pages, TanStack Query)
   │  same-origin JSON  (CSRF: Origin check on every mutation)
   ▼
Next.js 16 App Router ── /api/v1/* route handlers (Zod-validated, rate-limited)
   │        │                 │
   │        │                 └─ services/  (publishing, analytics, trends, keywords, …)
   │        │                         │
   │        │                         ├─ providers/platforms  YouTube · TikTok · Instagram adapters
   │        │                         ├─ providers/ai         Anthropic · OpenAI (+ image)
   │        │                         └─ storage              local disk · Supabase Storage
   │        ▼
   │   PostgreSQL (Supabase)  ◄── every user query runs as role `authenticated`
   │                              with JWT claims set → RLS `user_id = auth.uid()`
   ▼
Redis (BullMQ) ──► Worker process (npm run worker)
                     publish · poll · sync · automations · reconcile · token refresh · cleanup
```

### Key decisions (and where they deviate from the brief)

- **Next.js 16 with Cache Components.** Pages are client components fed by typed route handlers through TanStack Query. Auth is enforced in **every** API handler and by Postgres RLS. `proxy.ts` (the renamed middleware) only does optimistic redirects.
- **Drizzle ORM over raw Postgres instead of the Supabase JS client for data.** Typed schema, generated SQL migrations and transactions, while still running on Supabase Postgres. RLS is enforced by the database: `withUser()` opens a transaction, sets `request.jwt.claims` and `SET LOCAL ROLE authenticated`, which is exactly what Supabase's `auth.uid()` reads. Integration tests prove cross-user reads and writes are blocked.
- **Two auth adapters.** `AUTH_PROVIDER=supabase` uses Supabase Auth via `@supabase/ssr` (recommended in production). `AUTH_PROVIDER=local` uses scrypt-hashed passwords and hashed session tokens in Postgres, so the app runs and is testable without a Supabase project.
- **Postgres is the source of truth for publishing; Redis is the delivery mechanism.** Jobs are idempotent (deterministic job IDs), targets are claimed atomically (`UPDATE … WHERE status IN (…) RETURNING`), and a reconciler re-runs anything due every minute, so lost Redis jobs never lose posts. Without Redis the worker polls Postgres every 30 seconds.
- **Retries live in Postgres**, not BullMQ: exponential backoff with jitter (30s → 1h cap, 5 attempts), persisted `next_attempt_at`, error classification (retryable, needs user action, platform approval required, re-auth).
- **Resumable/idempotent uploads.** The YouTube resumable session URL is persisted before any bytes are sent; retries query the server offset and resume. Once a video ID exists the upload is never repeated. Instagram publishes a container exactly once. TikTok follows the documented 5–64 MB sequential chunking.
- **Direct-to-storage uploads.** With Supabase Storage the browser uploads straight to a signed URL, then the server verifies size and magic bytes before registering the file. This avoids Vercel's ~4.5 MB request-body limit.
- **No shadcn CLI.** Components are hand-built on Radix primitives in a shadcn-like style; the CLI fetches its registry over the network.

---

## Local development

Requirements: Node 22, PostgreSQL 15+, Redis 7 (optional but recommended), ffmpeg (optional).

```bash
npm install
cp .env.example .env          # fill SESSION_SECRET and TOKEN_ENCRYPTION_KEY (openssl rand -base64 32)
createdb viral_os
npm run db:migrate            # bootstrap (auth.uid shim, roles) + migrations + RLS
npm run dev                   # http://localhost:3000
npm run worker                # in a second terminal: publishing, scheduling, automations
```

Create an account at `/signup`. Add integration keys to `.env` as you get them; each feature shows exactly what's missing until then.

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Background worker |
| `npm run db:generate` | Generate a migration after editing `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply bootstrap + migrations (idempotent) |
| `npm test` | Unit + integration tests (needs Postgres; Redis optional) |
| `npm run typecheck` | TypeScript strict |
| `npm run diagnose` | Pre-deployment diagnostic (`-- --strict` for production gates) |

---

## Testing

`npm test` creates a fresh `viral_os_test` database, applies the real migrations, and runs:

- **Unit:** crypto (AES-GCM tamper detection, scrypt, PKCE checked against OpenSSL), TikTok chunk plans, YouTube range parsing, backoff, status aggregation, idea scoring, keyword competition, trend momentum, WCAG contrast, ffmpeg output parsing, JSON extraction, magic-byte sniffing, competitor stats, cron and timezone handling, PATCH-default regression.
- **Integration (real Postgres):** RLS isolation (read, write, update, delete, credential tables), encrypted tokens, the full publishing state machine (queued → uploading → processing → published only on confirmation), atomic claim under concurrency, duplicate-post prevention, persisted retries and final failure, approval-required and re-auth mapping, scheduling and the reconciler, validation, cancel, duplicate, date-range queries, token refresh and revocation handling, automations, AI output validation and retry, measured thumbnail analysis, ffmpeg scene detection on a generated video.
- **Adapters (mocked HTTP transport):** YouTube resumable init/chunk/resume/quota/rejection, TikTok creator-info privacy gating, init, chunk PUT and status, Instagram container → status → publish exactly once.
- **Queue (real Redis):** a post queued through the API is consumed by a BullMQ worker and ends published.
- **Clipping on real videos** (`npm run fixtures:fetch` downloads them, SHA-256 pinned): the Blender Foundation's *Sintel* (CC BY 3.0) excerpt with its real English WebVTT captions, and *Big Buck Bunny* (CC BY 3.0). Tests run the full pipeline through Postgres, storage and ffmpeg and check the actual output files: clips align to real caption cues, 720×1280 with audio, integrated loudness about -14 LUFS (measured with EBU R128), captions visibly burned in (pixel comparison with and without captions), signal-only clipping on footage without dialogue, a source with no audio track, trim and re-render with old files removed, draft post from a clip, AI blending and AI-failure fallback, real audio extracted for speech-to-text, cross-user isolation and recovery by the reconciler.
- **YouTube clipping (mocked YouTube transport, documented response shapes):** chapters and comment timestamps for someone else's video, whole-second embed clips, comments turned off, embedding turned off, no-data jobs, quota accounting, retention and caption-track use for your own video, attaching your original (Sintel stands in) and rendering a real 720×1280 clip from it, refusing a file whose length doesn't match, refusing renders and attachments for videos you don't own, cross-user isolation. The request log is checked: only the YouTube Data and Analytics APIs are called, never a media URL.
- **Hardening regressions:** open-redirect guards, byte-range parsing, Unicode download names, client IP selection, token tampering and purpose separation, limiter pruning (unit); cancel and delete racing a worker claim on a second real Postgres connection, OAuth redirect storage, streaming local uploads with size cap and no overwrite, double registration, streamed ranges, analysis from storage, worker schedules restored after a Redis flush (integration).
- **Browser e2e:** `npm run test:e2e:media` (streamed upload through the dialog, reused upload link refused, Arabic filename download, byte ranges incl. 416, playback, 413 for oversized multipart, login open redirect blocked, per-email login cap under IP rotation), `npm run test:e2e` (core flows), `npm run test:e2e:clips` (uploads the real Sintel video and captions through the UI, waits for the worker, plays a rendered clip, trims it, creates a post) and `npm run test:e2e:youtube` (clips a YouTube link against `tests/e2e/mock-youtube.mjs`: embed URLs, timestamp links, trimming without renders, manual clips, no media requests). Needs the app, worker and Chrome running.

Live calls to YouTube, TikTok, Instagram, Anthropic and OpenAI are **not** exercised by the tests. They require your credentials; see the checklist below.

---

## Deployment

Recommended: **Vercel** (web) + **Railway** (worker) + **Supabase** (Postgres, Auth, Storage) + **managed Redis** (Upstash, Railway Redis).

1. **Supabase:** create a project. Run `npm run db:migrate` with `DATABASE_URL` set to the **direct** connection (port 5432). For the app, use the **transaction pooler** URL (port 6543) and `DATABASE_POOLER=true`. Run `db/supabase-storage.sql` to create the private `media` bucket. In Auth settings, set the Site URL to `APP_URL` and add `${APP_URL}/auth/callback` to redirect URLs.
2. **Redis:** create an instance with `maxmemory-policy=noeviction` (BullMQ requirement).
3. **Vercel:** import the repo and set the environment from `.env.example` (`AUTH_PROVIDER=supabase`, `STORAGE_PROVIDER=supabase`, https `APP_URL`). `vercel.json` raises API function duration to 60s for AI routes.
4. **Railway:** a service from this repo uses `railway.json` → `Dockerfile.worker` (includes ffmpeg, runs migrations, then the worker). Give it the same environment.
5. **Custom domain:** point it at Vercel, update `APP_URL`, then update the OAuth redirect URIs in Google, TikTok and Meta.
6. Run `npm run diagnose -- --strict` against production env vars. It must exit 0. `GET /api/health` reports database, Redis and worker heartbeat.

Self-hosting on a single box: `Dockerfile` (web) + `Dockerfile.worker`, any Postgres and Redis.

Staging and production are separate environment-variable sets (separate Supabase project, Redis and OAuth apps or redirect URIs). The code has no environment-specific branches beyond `NODE_ENV`.

---

## Security

- OAuth tokens: AES-256-GCM at rest, decrypted only server-side, never returned to the browser. Resumable upload URLs are stripped from API responses.
- RLS on all 29 user tables, enforced by Postgres for every user-facing query; credential/session tables are unreachable from the `authenticated` role.
- OAuth `state` is bound to the signed-in user and expires in 10 minutes; PKCE for Google.
- CSRF: mutations require a same-origin `Origin`. Cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production.
- Redirects after login and after connecting an account only go to paths on this site (`//host`, `/\host` and control-character tricks are refused).
- Uploads are validated by magic bytes, not the client MIME type; storage keys are namespaced per user and path-traversal safe. Uploads and downloads are streamed: with local storage the browser PUTs to a signed, single-use, size-capped endpoint; multipart uploads are limited to 100 MB. A storage object can be registered only once. Signed media links are checked in constant time.
- Rate limits (Redis-backed) on auth, AI, uploads, publishing, sync and quota-heavy YouTube calls. Login is limited per IP+email and per email (30 tries per 15 minutes) so rotating a spoofed `X-Forwarded-For` doesn't help; the IP comes from the last proxy hop or `TRUSTED_IP_HEADER`.
- Cancelling or deleting a post can't race the worker: a target the worker just claimed is never overwritten as cancelled or deleted mid-upload.
- The worker re-registers its schedules and heartbeat every minute, so a Redis restart without persistence doesn't silently stop scheduled work.
- Security headers: HSTS, frame-ancestors none, nosniff, referrer and permissions policy. Logs redact token, secret and password fields.

## Known limitations (read before launch)

- The per-email login cap means someone who knows an email address can block its logins for up to 15 minutes by failing 30 times. That is the trade-off for stopping distributed password guessing.

- **Platform approvals are outside the code:** Google OAuth app verification for the sensitive YouTube scopes (until then only listed test users can connect) and YouTube's default quota of 100 uploads and 100 searches per project per day (per Google's quota page updated 2026-11-12), TikTok app audit (private-only posting until approved), and Meta App Review for Instagram advanced access. See `docs/SETUP_CHECKLIST.md`.
- **Instagram needs public media URLs.** Use Supabase Storage (signed URLs) or a public `APP_URL`.
- **Search volume** needs a licensed provider; none is integrated, so volume is reported as unavailable.
- **TikTok/Instagram trends and competitor analytics** have no official public API for this app type; Trend Radar is YouTube-based and those competitors are manual.
- **Clip Studio YouTube links** were tested against a mock of the documented YouTube responses, not the live API, and the embedded player was not loaded (this test environment can't reach youtube.com). Moments for someone else's video come only from chapters and comment timestamps; videos with neither get no automatic clips (add them by hand). Retention and captions only work for videos on your connected channel; captions also need `YOUTUBE_CAPTION_ACCESS=true` and a reconnect. Each job costs about 1 quota unit plus 1 per 100 comments, plus 250 when your caption track is read.
- **Clip Studio** needs ffmpeg on the worker host (in the Docker images). Automatic transcription needs `OPENAI_API_KEY`; without it, upload .srt/.vtt captions or clip from signals only. The live OpenAI transcription call was not exercised in tests (a stub received the real extracted audio). Reframing is center or manual-focus crop; there's no face tracking.
- **Video Analyzer** reads files up to 500 MB in the web tier and needs ffmpeg on the host (included in the Docker images; not available on Vercel, where pacing metrics are skipped and labeled). Transcripts are pasted, not auto-transcribed.
- Light theme is not included; the product is dark-only per the brand direction.
- The Supabase Auth and Supabase Storage code paths follow the official SDK APIs but were not run against a live Supabase project in this build environment.
