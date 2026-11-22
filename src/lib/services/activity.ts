import { serviceDb, schema } from "../db/client";

export async function logActivity(userId: string, a: { action: string; entityType: string; entityId?: string; summary: string; metadata?: Record<string, unknown> }) {
  await serviceDb().insert(schema.activityLog).values({ userId, ...a });
}
