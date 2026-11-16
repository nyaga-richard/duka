/**
 * Database access layer.
 *
 * Production and tests share one small interface so the same SQL, constraints
 * and transactions are exercised everywhere. Two drivers exist:
 *   - `postgres` (node-postgres pool) — production/staging;
 *   - `pglite`   — embedded PostgreSQL used for local dev and automated tests.
 *
 * The embedded driver is intentionally serialised: it is a single PostgreSQL
 * connection. Genuine multi-connection concurrency must be verified against
 * real PostgreSQL (`npm run test:pg-concurrency`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { config } from "../config.ts";

export type DbRow = Record<string, any>;

export interface QueryResult<T = DbRow> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = DbRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Transaction extends Queryable {
  readonly txid: string;
  /** Simple-query protocol: required for multi-statement migration files. */
  exec(sql: string): Promise<void>;
}

/**
 * The transaction currently owned by this async call stack.
 *
 * Handlers receive both `ctx.db` and `tx`; without this indirection a handler
 * that calls `ctx.db.query(...)` while its own transaction is open would wait
 * for a second connection (node-postgres) or for the serialised queue to drain
 * (PGlite) and deadlock. Routing those calls through the open transaction keeps
 * the unit of work honest and makes nested access safe.
 */
const activeTransaction = new AsyncLocalStorage<Transaction>();

export function currentTransaction(): Transaction | undefined {
  return activeTransaction.getStore();
}

export interface Database extends Queryable {
  readonly driver: "postgres" | "pglite";
  exec(sql: string): Promise<void>;
  withTransaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options?: { isolation?: "repeatable read" | "serializable"; readOnly?: boolean; maxAttempts?: number },
  ): Promise<T>;
  healthCheck(): Promise<{ ok: boolean; driver: string; latency_ms: number; error?: string }>;
  close(): Promise<void>;
}

class PostgresDatabase implements Database {
  readonly driver = "postgres" as const;
  private pool: pg.Pool;

  constructor(url: string, poolMax: number) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      application_name: "ecommerce-api",
    });
    this.pool.on("error", (error) => {
      // Never log the connection string: it carries credentials.
      console.error("postgres pool error", error.message);
    });
  }

  async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const tx = activeTransaction.getStore();
    if (tx) return tx.query<T>(sql, params);
    const result = await this.pool.query(sql, params as any[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    const tx = activeTransaction.getStore();
    if (tx) return tx.exec(sql);
    await this.pool.query(sql);
  }

  async withTransaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options: { isolation?: "repeatable read" | "serializable"; readOnly?: boolean; maxAttempts?: number } = {},
  ): Promise<T> {
    if (activeTransaction.getStore()) {
      throw new Error("withTransaction() called inside an open transaction; pass the existing tx instead");
    }
    const maxAttempts = options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      const tx: Transaction = {
        txid: randomUUID(),
        query: async (sql, params = []) => {
          const result = await client.query(sql as string, params as any[]);
          return { rows: result.rows as any[], rowCount: result.rowCount ?? result.rows.length };
        },
        exec: async (sql) => {
          await client.query(sql);
        },
      };
      try {
        await client.query(
          "BEGIN" +
            (options.isolation ? ` ISOLATION LEVEL ${options.isolation.toUpperCase()}` : "") +
            (options.readOnly ? " READ ONLY" : ""),
        );
        await client.query("SELECT set_config('statement_timeout','15000',true), set_config('lock_timeout','8000',true)");
        const result = await activeTransaction.run(tx, () => fn(tx));
        await client.query("COMMIT");
        return result;
      } catch (error: any) {
        await client.query("ROLLBACK").catch(() => undefined);
        const retryable = ["40001", "40P01"].includes(error?.code);
        if (retryable && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 40)));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.pool.query("SELECT 1");
      return { ok: true, driver: this.driver, latency_ms: Date.now() - started };
    } catch (error: any) {
      return { ok: false, driver: this.driver, latency_ms: Date.now() - started, error: error.message };
    }
  }

  async close() {
    await this.pool.end();
  }
}

/** Serialised wrapper around a single PGlite instance. */
class EmbeddedDatabase implements Database {
  readonly driver = "pglite" as const;
  private queue: Promise<unknown> = Promise.resolve();
  private inTransaction = false;
  private closed = false;

  private constructor(private readonly instance: any) {}

  static async create(dataDir: string): Promise<EmbeddedDatabase> {
    const { PGlite } = await import("@electric-sql/pglite");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dataDir, { recursive: true });
    const instance = new PGlite(dataDir);
    await instance.waitReady;
    return new EmbeddedDatabase(instance);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const tx = activeTransaction.getStore();
    if (tx) return tx.query<T>(sql, params);
    return this.run(async () => {
      const result = await this.instance.query(sql, params);
      return { rows: (result.rows ?? []) as T[], rowCount: (result.rows ?? []).length };
    });
  }

  async exec(sql: string): Promise<void> {
    const tx = activeTransaction.getStore();
    if (tx) return tx.exec(sql);
    await this.run(async () => {
      await this.instance.exec(sql);
    });
  }

  async withTransaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options: { isolation?: "repeatable read" | "serializable"; readOnly?: boolean } = {},
  ): Promise<T> {
    if (this.inTransaction || activeTransaction.getStore()) {
      throw new Error("Nested transactions are not supported by the embedded driver");
    }
    this.inTransaction = true;
    try {
      return await this.run(async () => {
        const txid = randomUUID();
        await this.instance.exec(
          "BEGIN" +
            (options.isolation ? ` ISOLATION LEVEL ${options.isolation.toUpperCase()}` : "") +
            (options.readOnly ? " READ ONLY" : ""),
        );
        const tx: Transaction = {
          txid,
          query: async (sql, params = []) => {
            const result = await this.instance.query(sql, params);
            return { rows: (result.rows ?? []) as any[], rowCount: (result.rows ?? []).length };
          },
          exec: async (sql) => {
            await this.instance.exec(sql);
          },
        };
        try {
          const result = await activeTransaction.run(tx, () => fn(tx));
          await this.instance.exec("COMMIT");
          return result;
        } catch (error) {
          await this.instance.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    } finally {
      this.inTransaction = false;
    }
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.query("SELECT 1");
      return { ok: true, driver: this.driver, latency_ms: Date.now() - started };
    } catch (error: any) {
      return { ok: false, driver: this.driver, latency_ms: Date.now() - started, error: error.message };
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.instance.close();
  }
}

let database: Database | undefined;

export async function getDatabase(): Promise<Database> {
  if (database) return database;
  database =
    config.db.embedded && config.db.url.startsWith("pglite://")
      ? await EmbeddedDatabase.create(config.db.url.slice("pglite://".length))
      : new PostgresDatabase(config.db.url, config.db.poolMax);
  return database;
}

/** Explicit embedded database factory used by tests and local tooling. */
export async function createEmbeddedDatabase(dataDir: string): Promise<Database> {
  return EmbeddedDatabase.create(dataDir);
}

/** Test helper: install an isolated database instance. */
export async function setDatabase(next: Database | undefined) {
  if (database && database !== next) await database.close().catch(() => undefined);
  database = next;
}

export async function closeDatabase() {
  if (database) await database.close();
  database = undefined;
}

/** Convert driver values into canonical money strings (numeric -> text). */
export function num(value: unknown): string {
  if (value === null || value === undefined) return "0.00";
  return String(value);
}
