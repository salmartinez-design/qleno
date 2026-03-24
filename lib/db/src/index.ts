import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Prefer the Replit Helium DB connection (PG* secrets) over a stale DATABASE_URL secret.
// PGHOST=helium is Replit's internal hostname — always correct in both dev and production.
function getConnectionConfig(): pg.PoolConfig {
  const pgHost = process.env.PGHOST;
  const pgDatabase = process.env.PGDATABASE;
  const pgUser = process.env.PGUSER;
  const pgPassword = process.env.PGPASSWORD;
  const pgPort = process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432;

  if (pgHost && pgDatabase && pgUser && pgPassword) {
    // Use individual PG vars — these always point to the Replit Helium DB.
    // Production requires SSL; development (internal network) does not.
    const ssl = process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false;
    return { host: pgHost, database: pgDatabase, user: pgUser, password: pgPassword, port: pgPort, ssl };
  }

  // Fallback to DATABASE_URL
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }
  return { connectionString: process.env.DATABASE_URL };
}

export const pool = new Pool(getConnectionConfig());
export const db = drizzle(pool, { schema });

export * from "./schema";
