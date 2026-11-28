/**
 * Owner console: owner checks, sign-up modes and invites, disabling and deleting accounts, usage
 * metering, read-only content access with audit, and the database grants that keep this owner-only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { resetEnvCache } from "@/lib/env";
import { setFetchForTests, http } from "@/lib/providers/http";
import { generateStructured, setAIProviderForTests } from "@/lib/providers/ai";
import { meteredFor, recordUsage, runAsUser, youtubeCost } from "@/lib/usage";
import {
  checkSignupAllowed,
  consumeInvite,
  createInvite,
  deleteUser,
  describeInvite,
  getSignupMode,
  getUser,
  listAudit,
  listInvites,
  listUsers,
  requireOwner,
  revokeInvite,
  setDisabled,
  setSignupMode,
  userContent,
} from "@/lib/services/admin";
import { saveUpload } from "@/lib/services/media";
import { createPost } from "@/lib/services/publishing";
import { storage } from "@/lib/storage";
import { createConnection, createUser } from "../helpers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(2048, 1)]);

async function makeOwner() {
  const u = await createUser();
  await serviceDb().update(schema.profiles).set({ role: "owner" }).where(eq(schema.profiles.id, u.id));
  return u;
}
const tokenOf = (url: string) => new URL(url).searchParams.get("invite")!;

afterEach(async () => {
  process.env.OWNER_EMAIL = "";
  resetEnvCache();
  await serviceDb().delete(schema.appSettings).where(eq(schema.appSettings.key, "signup_mode"));
  setFetchForTests(null);
  setAIProviderForTests(null);
});

describe("owner checks", () => {
  it("only an enabled owner passes", async () => {
    const owner = await makeOwner();
    const user = await createUser();
    await expect(requireOwner(owner.id)).resolves.toBeUndefined();
    await expect(requireOwner(user.id)).rejects.toMatchObject({ status: 403, code: "owner_only" });
    await serviceDb().update(schema.profiles).set({ disabledAt: new Date() }).where(eq(schema.profiles.id, owner.id));
    await expect(requireOwner(owner.id)).rejects.toMatchObject({ status: 403 });
  });

  it("users can't make themselves owner or touch owner tables, even with direct database access", async () => {
    const user = await createUser();
    await expect(withUser(user.id, (tx) => tx.update(schema.profiles).set({ role: "owner" }).where(eq(schema.profiles.id, user.id)))).rejects.toThrow();
    await expect(withUser(user.id, (tx) => tx.update(schema.profiles).set({ disabledAt: null }).where(eq(schema.profiles.id, user.id)))).rejects.toThrow();
    const ok = await withUser(user.id, (tx) => tx.update(schema.profiles).set({ displayName: "Renamed", updatedAt: new Date() }).where(eq(schema.profiles.id, user.id)).returning());
    expect(ok[0].displayName).toBe("Renamed");
    for (const t of [schema.invites, schema.appSettings, schema.adminAuditLog, schema.usageEvents]) {
      await expect(withUser(user.id, (tx) => tx.select().from(t).limit(1))).rejects.toThrow();
    }
    await expect(withUser(user.id, (tx) => tx.insert(schema.profiles).values({ id: crypto.randomUUID(), email: "x@y.z", role: "owner" }))).rejects.toThrow();
  });
});

describe("sign-up control", () => {
  it("open by default; closed refuses; owner emails always get in", async () => {
    const owner = await makeOwner();
    expect(await getSignupMode()).toBe("open");
    await expect(checkSignupAllowed("a@x.test")).resolves.toEqual({ invite: null });
    await setSignupMode(owner.id, "closed");
    await expect(checkSignupAllowed("a@x.test")).rejects.toMatchObject({ status: 403, code: "signup_closed" });
    process.env.OWNER_EMAIL = "boss@x.test, second@x.test";
    resetEnvCache();
    await expect(checkSignupAllowed("Boss@X.test")).resolves.toEqual({ invite: null });
    const log = await listAudit(5);
    expect(log.find((l) => l.action === "signup_mode_changed")).toMatchObject({ detail: { from: "open", to: "closed" }, actorEmail: owner.email });
  });

  it("invite-only: links work once, can be bound to an email, revoked or expire", async () => {
    const owner = await makeOwner();
    await setSignupMode(owner.id, "invite");
    await expect(checkSignupAllowed("new@x.test")).rejects.toMatchObject({ code: "invite_required" });
    await expect(checkSignupAllowed("new@x.test", "not-a-token")).rejects.toMatchObject({ code: "invite_invalid" });

    const open = await createInvite(owner.id, { expiresInDays: 7, note: "for the team" });
    expect(open.url).toMatch(/\/signup\?invite=/);
    const t = tokenOf(open.url);
    expect(await describeInvite(t)).toEqual({ valid: true, email: null });
    const { invite } = await checkSignupAllowed("new@x.test", t);
    expect(invite?.id).toBe(open.id);
    expect(await consumeInvite(open.id)).toBe(true);
    expect(await consumeInvite(open.id)).toBe(false); // second use refused
    await expect(checkSignupAllowed("other@x.test", t)).rejects.toMatchObject({ code: "invite_invalid" });

    const bound = await createInvite(owner.id, { email: "Only@X.test" });
    await expect(checkSignupAllowed("someone@x.test", tokenOf(bound.url))).rejects.toMatchObject({ code: "invite_email_mismatch" });
    await expect(checkSignupAllowed("only@x.test", tokenOf(bound.url))).resolves.toMatchObject({ invite: { id: bound.id } });

    const revoked = await createInvite(owner.id, {});
    await revokeInvite(owner.id, revoked.id);
    await expect(checkSignupAllowed("r@x.test", tokenOf(revoked.url))).rejects.toMatchObject({ code: "invite_invalid" });
    await expect(revokeInvite(owner.id, open.id)).rejects.toMatchObject({ status: 409 }); // already used

    const expired = await createInvite(owner.id, {});
    await serviceDb().update(schema.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invites.id, expired.id));
    await expect(checkSignupAllowed("e@x.test", tokenOf(expired.url))).rejects.toMatchObject({ code: "invite_invalid" });

    const statuses = Object.fromEntries((await listInvites()).filter((i) => [open.id, bound.id, revoked.id, expired.id].includes(i.id)).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({ [open.id]: "used", [bound.id]: "active", [revoked.id]: "revoked", [expired.id]: "expired" });
    // Only a hash is stored.
    const [row] = await serviceDb().select().from(schema.invites).where(eq(schema.invites.id, open.id));
    expect(row.tokenHash).not.toContain(t);
  });

  it("two people racing for one invite: only one gets it", async () => {
    const owner = await makeOwner();
    const inv = await createInvite(owner.id, {});
    const results = await Promise.all([consumeInvite(inv.id), consumeInvite(inv.id), consumeInvite(inv.id)]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("managing users", () => {
  it("disables (signing the user out everywhere) and re-enables; can't target self or another owner", async () => {
    const owner = await makeOwner();
    const other = await makeOwner();
    const user = await createUser();
    await serviceDb().insert(schema.sessions).values({ tokenHash: `t-${user.id}`, userId: user.id, expiresAt: new Date(Date.now() + 86400_000) });
    const d = await setDisabled(owner.id, user.id, true);
    expect(d.disabledAt).toBeTruthy();
    expect(await serviceDb().select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toEqual([]);
    expect((await setDisabled(owner.id, user.id, false)).disabledAt).toBeNull();
    await expect(setDisabled(owner.id, owner.id, true)).rejects.toMatchObject({ status: 400 });
    await expect(setDisabled(owner.id, other.id, true)).rejects.toMatchObject({ status: 409 });
    const actions = (await listAudit(50, user.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user_disabled", "user_enabled"]));
  });

  it("deletes every row and file a user owns, after typed confirmation, and leaves others untouched", async () => {
    const owner = await makeOwner();
    const victim = await createUser();
    const bystander = await createUser();
    for (const u of [victim, bystander]) {
      const conn = await createConnection(u.id, "youtube");
      const asset = await saveUpload(u.id, { name: "v.mp4", type: "video/mp4", buffer: MP4 });
      await createPost(u.id, { title: "P", baseCaption: "c", mediaAssetId: asset.id, targets: [{ connectionId: conn.id, title: "P", caption: "c", hashtags: [], privacy: "private" }] });
      await runAsUser(u.id, () => recordUsage("ai_call", 1, { inputTokens: 10, outputTokens: 5 }));
    }
    const [victimAsset] = await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.userId, victim.id));
    await getUser(owner.id, victim.id); // logged while the account still exists
    await expect(deleteUser(owner.id, victim.id, "wrong@x.test")).rejects.toMatchObject({ status: 400 });
    const res = await deleteUser(owner.id, victim.id, victim.email.toUpperCase());
    expect(res).toMatchObject({ ok: true, files: 1, filesRemoved: 1 });
    await expect(storage().size(victimAsset.storageKey)).rejects.toThrow();
    const leftovers = await serviceDb().execute(sql`
      select (select count(*) from profiles where id = ${victim.id})
           + (select count(*) from media_assets where user_id = ${victim.id})
           + (select count(*) from posts where user_id = ${victim.id})
           + (select count(*) from post_targets where user_id = ${victim.id})
           + (select count(*) from platform_connections where user_id = ${victim.id})
           + (select count(*) from usage_events where user_id = ${victim.id}) as n`);
    expect(Number((leftovers as unknown as { n: string }[])[0].n)).toBe(0);
    const b = (await listUsers()).items.find((u) => u.id === bystander.id)!;
    expect(b.usage).toMatchObject({ posts: 1, mediaCount: 1, connections: 1, aiCalls30d: 1, aiTokens30d: 15 });
    const log = await listAudit(10, victim.id);
    expect(log[0]).toMatchObject({ action: "user_deleted", targetEmail: victim.email });
    // The entry written before the deletion still names the account.
    const viewed = (await listAudit(50, victim.id)).find((l) => l.action === "user_viewed");
    expect(viewed).toMatchObject({ targetEmail: victim.email });
    await expect(deleteUser(owner.id, owner.id, owner.email)).rejects.toMatchObject({ status: 400 });
  });
});

describe("usage overview", () => {
  it("meters AI calls with tokens and YouTube quota per user, inside requests and background jobs", async () => {
    const user = await createUser();
    setFetchForTests((async () => new Response("{}", { status: 200 })) as typeof fetch);
    setAIProviderForTests({ name: "test", model: "m1", lastUsage: { inputTokens: 120, outputTokens: 30 }, generateText: async () => '{"ok":true}' });
    await runAsUser(user.id, async () => {
      await http("https://www.googleapis.com/youtube/v3/videos?part=snippet&id=x");
      await http("https://www.googleapis.com/youtube/v3/captions/abc?tfmt=vtt");
      await http("https://www.googleapis.com/youtube/v3/search?q=x"); // separate search.list bucket
      await http("https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE"); // not Data API quota
      await http("https://example.com/not-youtube");
      await generateStructured(z.object({ ok: z.boolean() }), { system: "s", prompt: "p", shapeHint: "{ok}" });
    });
    // Background work with no request context is attributed to the row's owner.
    const [job] = await serviceDb().insert(schema.clipJobs).values({ userId: user.id, settings: {}, source: {} }).returning();
    await meteredFor("clip_jobs", job.id, () => recordUsage("youtube_units", 50, { detail: { bucket: "daily_units" } }));
    // Outside any context nothing is recorded (no orphan rows).
    await recordUsage("ai_call", 1);

    const u = (await listUsers(user.email)).items[0];
    expect(u.usage).toMatchObject({ aiCalls30d: 1, aiTokens30d: 150, youtubeUnits30d: 1 + 200 + 50 });
    const owner = await makeOwner();
    const detail = await getUser(owner.id, user.id);
    expect(Object.fromEntries(detail.youtubeByBucket.map((b) => [b.bucket, b.units]))).toEqual({ daily_units: 251, "search.list": 1 });
    expect(detail.aiByDay[0]).toMatchObject({ calls: 1, tokens: 150 });
  });

  it("classifies YouTube Data API costs", () => {
    expect(youtubeCost("https://www.googleapis.com/youtube/v3/channels?mine=true")).toEqual({ units: 1, bucket: "daily_units" });
    expect(youtubeCost("https://www.googleapis.com/youtube/v3/thumbnails/set?videoId=x", "POST")).toEqual({ units: 50, bucket: "daily_units" });
    expect(youtubeCost("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable", "POST")).toEqual({ units: 1, bucket: "videos.insert" });
    expect(youtubeCost("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc", "PUT")).toBeNull(); // upload chunk
    expect(youtubeCost("https://open.tiktokapis.com/v2/post/publish/")).toBeNull();
  });
});

describe("viewing a user's content", () => {
  it("returns posts, clips and media read-only and logs every look", async () => {
    const owner = await makeOwner();
    const user = await createUser();
    const asset = await saveUpload(user.id, { name: "holiday.mp4", type: "video/mp4", buffer: MP4 });
    await createPost(user.id, { title: "My post", baseCaption: "hello", mediaAssetId: asset.id, targets: [] });
    const posts = await userContent(owner.id, user.id, "posts");
    expect(posts.items).toMatchObject([{ title: "My post", caption: "hello", mediaAssetId: asset.id }]);
    const media = await userContent(owner.id, user.id, "media");
    expect(media.items).toMatchObject([{ filename: "holiday.mp4", kind: "video" }]);
    expect((await userContent(owner.id, user.id, "clips")).items).toEqual([]);
    const log = await listAudit(10, user.id);
    expect(log.filter((l) => l.action === "content_viewed").map((l) => (l.detail as { type: string }).type).sort()).toEqual(["clips", "media", "posts"]);
    const rows = await serviceDb().select().from(schema.adminAuditLog).where(and(eq(schema.adminAuditLog.actorId, owner.id), eq(schema.adminAuditLog.targetUserId, user.id)));
    expect(rows.length).toBe(3);
  });
});
