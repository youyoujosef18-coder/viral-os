import { inArray } from "drizzle-orm";
import { schema, withUser } from "../db/client";
import { notFound } from "../api/errors";

/**
 * Foreign keys don't respect row-level security: without this check a request could store a reference to
 * another account's media, project or keyword list. Each id is looked up through the caller's own RLS
 * scope, so anything that isn't theirs reads as "not found".
 */
type Ids = (string | null | undefined)[];
type Refs = { mediaAssets?: Ids; projects?: Ids; keywordLists?: Ids; agents?: Ids; watchlists?: Ids };
type Tx = Parameters<Parameters<typeof withUser>[1]>[0];

const TABLES = {
  mediaAssets: { table: schema.mediaAssets, label: "Media file" },
  projects: { table: schema.contentProjects, label: "Project" },
  keywordLists: { table: schema.keywordLists, label: "Keyword list" },
  agents: { table: schema.agents, label: "Agent" },
  watchlists: { table: schema.trendWatchlists, label: "Watchlist" },
} as const;

export async function assertOwnedIn(tx: Tx, refs: Refs) {
  for (const key of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
    const ids = [...new Set((refs[key] ?? []).filter((v): v is string => !!v))];
    if (!ids.length) continue;
    const { table, label } = TABLES[key];
    const found = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
    if (found.length !== ids.length) throw notFound(label);
  }
}

export function assertOwned(userId: string, refs: Refs) {
  return withUser(userId, (tx) => assertOwnedIn(tx, refs));
}
