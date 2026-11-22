import { afterAll } from "vitest";
import { TEST_ENV } from "./env";

Object.assign(process.env, TEST_ENV);

afterAll(async () => {
  const { closeDb } = await import("@/lib/db/client");
  const { closeRedis } = await import("@/lib/queue/redis");
  await closeDb();
  await closeRedis();
});
