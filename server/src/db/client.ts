import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { requireDatabaseUrl } from "./env";
import * as schema from "./schema";

export const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
