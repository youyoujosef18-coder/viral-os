import { serviceDb, schema } from "../db/client";

export async function notify(userId: string, n: { type: "info" | "success" | "warning" | "error"; title: string; body?: string; link?: string }) {
  await serviceDb().insert(schema.notifications).values({ userId, ...n });
}
