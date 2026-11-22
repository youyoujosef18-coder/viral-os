import { execSync } from "node:child_process";
import postgres from "postgres";
import { TEST_ENV } from "./env";

export default async function setup() {
  const url = new URL(TEST_ENV.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = postgres({ host: url.hostname, port: Number(url.port || 5432), username: url.username, password: url.password, database: "postgres", onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.unsafe(`create database ${dbName}`);
  await admin.end();
  execSync("npx tsx scripts/migrate.ts", { env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL }, stdio: "inherit" });
}
