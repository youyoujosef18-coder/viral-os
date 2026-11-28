# External setup checklist

Everything in the codebase is implemented. These steps need your accounts, credentials or a platform's approval, and can't be done from code.

## 1. Core infrastructure
- [ ] Supabase project created; `npm run db:migrate` run against the direct connection string
- [ ] `db/supabase-storage.sql` run (private `media` bucket)
- [ ] Supabase Auth: Site URL = `APP_URL`; redirect URL `APP_URL/auth/callback` added; email templates reviewed
- [ ] Redis created with `maxmemory-policy=noeviction`
- [ ] `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` generated (`openssl rand -base64 32`) and stored in the host's secret manager. **Never rotate `TOKEN_ENCRYPTION_KEY` without re-connecting accounts**: stored tokens become undecryptable.
- [ ] Web deployed (Vercel) and worker deployed (Railway, `Dockerfile.worker`)
- [ ] `npm run diagnose -- --strict` exits 0 with production variables; `GET /api/health` returns `ok: true` with a worker heartbeat

## 1b. Workspace owner
- [ ] Set `OWNER_EMAIL` to your email before signing up (or run `npm run make-owner -- you@example.com` after signing up)
- [ ] Sign in, open **Owner console**, and choose the sign-up mode (open, invite only or closed) before sharing the link

## 2. AI
- [ ] `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (or `openai` + `OPENAI_API_KEY`)
- [ ] Optional: `IMAGE_PROVIDER=openai` for thumbnail image generation
- [ ] Optional: `OPENAI_API_KEY` also enables automatic transcription in Clip Studio (`OPENAI_TRANSCRIBE_MODEL`, default `whisper-1`). Without it, upload .srt/.vtt captions or clip from signals only.
- [ ] Worker host has ffmpeg and the DejaVu font installed (both included in `Dockerfile.worker`); Clip Studio renders there

## 3. YouTube (Google Cloud)
- [ ] Enable **YouTube Data API v3** and **YouTube Analytics API**
- [ ] OAuth consent screen: scopes `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`; add yourself as a test user while unverified
- [ ] OAuth client (Web application) with redirect URI `APP_URL/api/oauth/youtube/callback` → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- [ ] API key restricted to YouTube Data API v3 → `YOUTUBE_API_KEY` (also used by Clip Studio to read video details and comments for YouTube links)
- [ ] Optional: `YOUTUBE_CAPTION_ACCESS=true` adds the `youtube.force-ssl` scope so Clip Studio can read caption tracks of your own videos (captions.list 50 units + captions.download 200 units). It's a sensitive scope: add it to the consent screen, and expect Google's verification before public launch. Reconnect YouTube after changing it.
- [ ] Clip Studio YouTube links: audience retention needs the YouTube Analytics API enabled (already above) and only works for videos on the connected channel
- [ ] **Approval:** OAuth app verification for the sensitive scopes. Until verified, only test users you list can connect. (Google's current `videos.insert` reference, updated 2026-11-12, states uploads from unverified projects are no longer restricted to private. Re-check before launch, since this changed recently.)
- [ ] **Quota (per Google's quota page, updated 2026-11-12):** separate daily buckets of 100 `videos.insert` calls and 100 `search.list` calls, plus 10,000 units/day for everything else. Each keyword competition measurement uses one search call. Request more via the YouTube API Services audit and quota extension form.
- [ ] Custom thumbnails need a phone-verified YouTube channel

## 4. TikTok (developers.tiktok.com)
- [ ] App with **Login Kit** and **Content Posting API (Direct Post)**
- [ ] Scopes: `user.info.basic`, `user.info.stats`, `video.publish`, `video.upload`, `video.list`
- [ ] Redirect URI `APP_URL/api/oauth/tiktok/callback` → `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`
- [ ] **Approval:** until the app passes TikTok's audit, posts are limited to `SELF_ONLY` (private). VIRAL OS shows these as "Platform approval required" with a fix. Submit the audit with your UX recording when ready.

## 5. Instagram (developers.facebook.com)
- [ ] Meta app with the **Instagram** product, using *API setup with Instagram login*
- [ ] Permissions: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`
- [ ] Redirect URI `APP_URL/api/oauth/instagram/callback` → `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`
- [ ] The connected account must be a **Professional** (Business or Creator) account
- [ ] Media must be publicly fetchable: use `STORAGE_PROVIDER=supabase` (signed URLs) or a public `APP_URL`
- [ ] **Approval:** Meta **App Review** for advanced access before non-tester accounts can connect. API publishing is capped at 100 posts per account per 24 hours.

## 6. Domain
- [ ] Custom domain on Vercel; `APP_URL` updated; all three OAuth redirect URIs updated to the new domain

## 7. Not provided (optional future integrations)
- Licensed search-volume provider for Keyword Explorer (volume stays "Not available" until added)
- Speech-to-text for automatic transcripts in the Video Analyzer (transcripts are pasted today)
