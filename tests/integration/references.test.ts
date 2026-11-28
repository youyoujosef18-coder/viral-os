/**
 * Cross-account references and API error mapping found by the fuzz test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { errorResponse, readJson, requireChanges } from "@/lib/api/handler";
import { setAIProviderForTests } from "@/lib/providers/ai";
import { saveUpload } from "@/lib/services/media";
import { createPost, updatePost } from "@/lib/services/publishing";
import { createClipJob } from "@/lib/services/clipping";
import { discoverKeywords } from "@/lib/services/keywords";
import { generateScript } from "@/lib/services/scripts";
import { assertOwned } from "@/lib/services/ownership";
import { createConnection, createUser } from "../helpers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(1024, 1)]);
const neverCalled = () => {
  throw new Error("AI must not be called when the request is rejected");
};
afterEach(() => setAIProviderForTests(null));

async function twoUsers() {
  const a = await createUser();
  const b = await createUser();
  const aAsset = await saveUpload(a.id, { name: "a.mp4", type: "video/mp4", buffer: MP4 });
  const [aProject] = await withUser(a.id, (tx) => tx.insert(schema.contentProjects).values({ userId: a.id, title: "A's project" }).returning());
  const [aList] = await withUser(a.id, (tx) => tx.insert(schema.keywordLists).values({ userId: a.id, name: "A's list" }).returning());
  const bAsset = await saveUpload(b.id, { name: "b.mp4", type: "video/mp4", buffer: MP4 });
  return { a, b, aAsset, aProject, aList, bAsset };
}

describe("references to another account's records are rejected", () => {
  it("posts can't point at someone else's media or project, on create or edit", async () => {
    const { b, aAsset, aProject, bAsset } = await twoUsers();
    const conn = await createConnection(b.id, "youtube");
    const base = { title: "T", baseCaption: "c", targets: [{ connectionId: conn.id, title: "T", caption: "c", hashtags: [], privacy: "private" }] };
    await expect(createPost(b.id, { ...base, mediaAssetId: aAsset.id })).rejects.toMatchObject({ status: 404 });
    await expect(createPost(b.id, { ...base, mediaAssetId: bAsset.id, thumbnailAssetId: aAsset.id })).rejects.toMatchObject({ status: 404 });
    await expect(createPost(b.id, { ...base, mediaAssetId: bAsset.id, projectId: aProject.id })).rejects.toMatchObject({ status: 404 });
    await expect(createPost(b.id, { ...base, mediaAssetId: bAsset.id, targets: [{ ...base.targets[0], thumbnailAssetId: aAsset.id }] })).rejects.toMatchObject({ status: 404 });
    const own = await createPost(b.id, { ...base, mediaAssetId: bAsset.id });
    await expect(updatePost(b.id, own.id, { ...base, mediaAssetId: aAsset.id })).rejects.toMatchObject({ status: 404 });
    const [row] = await serviceDb().select().from(schema.posts).where(eq(schema.posts.id, own.id));
    expect(row.mediaAssetId).toBe(bAsset.id); // unchanged
  });

  it("clip jobs, scripts and keyword discovery refuse foreign projects and lists before doing any work", async () => {
    const { b, aProject, aList, bAsset } = await twoUsers();
    setAIProviderForTests({ name: "test", model: "m", generateText: neverCalled });
    await expect(createClipJob(b.id, { assetId: bAsset.id, projectId: aProject.id, minSeconds: 15, maxSeconds: 30 })).rejects.toMatchObject({ status: 404 });
    await expect(generateScript(b.id, { topic: "Something", platform: "YouTube", projectId: aProject.id })).rejects.toMatchObject({ status: 404 });
    await expect(discoverKeywords(b.id, { seed: "coffee", platform: "YouTube", language: "en", listId: aList.id })).rejects.toMatchObject({ status: 404 });
    const jobs = await serviceDb().select().from(schema.clipJobs).where(eq(schema.clipJobs.userId, b.id));
    expect(jobs).toEqual([]);
  });

  it("assertOwned accepts the caller's own records and ignores empty values", async () => {
    const { a, aAsset, aProject, aList, bAsset } = await twoUsers();
    await expect(assertOwned(a.id, { mediaAssets: [aAsset.id, aAsset.id, null, undefined], projects: [aProject.id], keywordLists: [aList.id] })).resolves.toBeUndefined();
    await expect(assertOwned(a.id, { mediaAssets: [aAsset.id, bAsset.id] })).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Media file") });
  });
});

describe("API error mapping", () => {
  const pgError = (code: string) => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("db"), { code }) });
  it("maps Postgres data errors to 4xx instead of 500", async () => {
    expect(errorResponse(pgError("22P02")).status).toBe(400); // invalid input syntax
    expect(errorResponse(pgError("22021")).status).toBe(400); // NUL byte / bad encoding
    expect(errorResponse(pgError("22003")).status).toBe(400); // numeric out of range
    expect(errorResponse(pgError("23503")).status).toBe(404); // foreign key target missing
    expect(errorResponse(pgError("23505")).status).toBe(409); // unique
    expect(errorResponse(pgError("40001")).status).toBe(500); // anything else stays a server error
    expect(errorResponse(new Error("boom")).status).toBe(500);
  });

  it("readJson turns missing or malformed bodies into 400", async () => {
    for (const body of [undefined, "{", "not json"]) {
      const req = new NextRequest("http://x/api", { method: "POST", body });
      await expect(readJson(req)).rejects.toMatchObject({ status: 400 });
    }
    await expect(readJson(new NextRequest("http://x/api", { method: "POST", body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
  });

  it("requireChanges refuses an update with nothing to change", () => {
    expect(() => requireChanges({})).toThrow(/at least one field/);
    expect(() => requireChanges({ a: undefined })).toThrow();
    expect(requireChanges({ listId: null })).toEqual({ listId: null }); // clearing a value is a change
  });
});
