/**
 * Grant or remove the owner role on the server: npm run make-owner -- you@example.com [--revoke]
 * The account must have signed up first. Alternatively set OWNER_EMAIL before the owner signs up.
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, schema, serviceDb } from "../src/lib/db/client";

async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  const revoke = args.includes("--revoke");
  if (!email) throw new Error("Usage: npm run make-owner -- you@example.com [--revoke]");
  const db = serviceDb();
  const [p] = await db.select().from(schema.profiles).where(sql`lower(${schema.profiles.email}) = ${email}`);
  if (!p) throw new Error(`No account with email ${email}. Sign up first, then run this again.`);
  if (revoke) {
    const owners = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.role, "owner"));
    if (owners.length <= 1 && p.role === "owner") throw new Error("This is the only owner. Make someone else owner first.");
  }
  await db.update(schema.profiles).set({ role: revoke ? "user" : "owner", disabledAt: revoke ? p.disabledAt : null }).where(eq(schema.profiles.id, p.id));
  await db.insert(schema.adminAuditLog).values({ actorId: p.id, action: revoke ? "owner_revoked" : "owner_granted", targetUserId: p.id, detail: { email, via: "make-owner script" } });
  console.log(revoke ? `${email} is no longer an owner.` : `${email} is now an owner. Sign in and open Owner console.`);
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
