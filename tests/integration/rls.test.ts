import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { createUser, createConnection } from "../helpers";

/** Drizzle wraps driver errors; assert on the underlying Postgres message. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { message: string; cause?: { message?: string } };
    return e.cause?.message ?? e.message;
  }
  throw new Error("expected query to fail");
}

describe("row level security (enforced by Postgres)", () => {
  it("isolates every user's rows", async () => {
    const a = await createUser();
    const b = await createUser();
    await withUser(a.id, (tx) => tx.insert(schema.contentProjects).values({ userId: a.id, title: "A secret project" }));
    await withUser(b.id, (tx) => tx.insert(schema.contentProjects).values({ userId: b.id, title: "B project" }));

    const seenByB = await withUser(b.id, (tx) => tx.select().from(schema.contentProjects));
    expect(seenByB.map((p) => p.title)).toEqual(["B project"]);

    // Even an explicit filter for A's rows returns nothing for B.
    const sneaky = await withUser(b.id, (tx) => tx.select().from(schema.contentProjects).where(eq(schema.contentProjects.userId, a.id)));
    expect(sneaky).toHaveLength(0);
  });

  it("rejects writes that claim another user's id", async () => {
    const a = await createUser();
    const b = await createUser();
    expect(await pgError(withUser(b.id, (tx) => tx.insert(schema.contentProjects).values({ userId: a.id, title: "forged" })))).toMatch(/row-level security/i);
  });

  it("cannot update or delete another user's rows", async () => {
    const a = await createUser();
    const b = await createUser();
    const [p] = await withUser(a.id, (tx) => tx.insert(schema.contentProjects).values({ userId: a.id, title: "mine" }).returning());
    const upd = await withUser(b.id, (tx) => tx.update(schema.contentProjects).set({ title: "pwned" }).where(eq(schema.contentProjects.id, p.id)).returning());
    const del = await withUser(b.id, (tx) => tx.delete(schema.contentProjects).where(eq(schema.contentProjects.id, p.id)).returning());
    expect(upd).toHaveLength(0);
    expect(del).toHaveLength(0);
    const [still] = await serviceDb().select().from(schema.contentProjects).where(eq(schema.contentProjects.id, p.id));
    expect(still.title).toBe("mine");
  });

  it("never exposes credential tables to the authenticated role", async () => {
    const a = await createUser();
    expect(await pgError(withUser(a.id, (tx) => tx.select().from(schema.localAuthUsers)))).toMatch(/permission denied/i);
    expect(await pgError(withUser(a.id, (tx) => tx.select().from(schema.sessions)))).toMatch(/permission denied/i);
  });

  it("stores OAuth tokens encrypted at rest", async () => {
    const a = await createUser();
    const conn = await createConnection(a.id);
    expect(conn.accessTokenEnc).not.toContain("access-123");
    expect(conn.accessTokenEnc.startsWith("v1.")).toBe(true);
  });
});

describe("direct uploads", () => {
  it("uses the streaming local upload endpoint with local storage and refuses keys outside the user's prefix", async () => {
    const { createDirectUpload, completeDirectUpload } = await import("@/lib/services/media");
    const a = await createUser();
    const b = await createUser();
    const plan = await createDirectUpload(a.id, { name: "x.mp4", size: 1000 });
    expect(plan).toMatchObject({ mode: "direct", key: expect.stringMatching(new RegExp(`^${a.id}/`)), url: expect.stringMatching(/^\/api\/v1\/media\/local-upload\//) });
    await expect(completeDirectUpload(b.id, { key: `${a.id}/2026-11/evil.mp4`, filename: "evil.mp4" })).rejects.toMatchObject({ status: 403 });
  });
});
