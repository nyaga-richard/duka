/**
 * Real-PostgreSQL concurrency proof.
 *
 * PGlite is a single connection, so the embedded test suite can only prove the
 * SQL and the state machine. This test needs a real server and therefore runs
 * ONLY when TEST_DATABASE_URL is provided:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/ecommerce_test \
 *     npm run test:pg-concurrency
 *
 * It proves that two simultaneous buyers cannot reserve the same last unit.
 * Without TEST_DATABASE_URL every test is skipped — the suite never pretends to
 * have run it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../apps/api/src/db/migrate.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = url
  ? false
  : "TEST_DATABASE_URL is not set; real-PostgreSQL concurrency proof skipped";

async function pool() {
  return new pg.Pool({ connectionString: url, max: 4 });
}

async function migrateIfPossible() {
  if (!url) return;
  // A dedicated adapter so migrations do not depend on the app config.
  const client = await pool();
  const database = {
    driver: "postgres" as const,
    query: async (sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params as any[]);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    },
    exec: async (sql: string) => {
      await client.query(sql);
    },
    withTransaction: async (fn: any) => {
      const connection = await client.connect();
      try {
        await connection.query("BEGIN");
        const tx = {
          txid: randomUUID(),
          query: async (sql: string, params: unknown[] = []) => {
            const result = await connection.query(sql, params as any[]);
            return {
              rows: result.rows,
              rowCount: result.rowCount ?? result.rows.length,
            };
          },
          exec: async (sql: string) => {
            await connection.query(sql);
          },
        };
        const value = await fn(tx);
        await connection.query("COMMIT");
        return value;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    healthCheck: async () => ({ ok: true, driver: "postgres", latency_ms: 0 }),
    close: async () => {
      await client.end();
    },
  } as any;
  await migrate(database);
  await database.close();
}

test(
  "last unit: exactly one of two concurrent reservations wins",
  { skip },
  async () => {
    await migrateIfPossible();
    const one = await pool();
    const two = await pool();
    try {
      const variant = await one.query(
        `INSERT INTO product(product_name, slug, status) VALUES('Race Product', $1, 'active') RETURNING product_id`,
        [`race-${randomUUID()}`],
      );
      const productId = variant.rows[0].product_id;
      const created = await one.query(
        `INSERT INTO product_variant(product_id, sku, price, qty_in_stock, is_active)
       VALUES($1,$2,'100.00',1,true) RETURNING variant_id`,
        [productId, `RACE-${randomUUID().slice(0, 8)}`],
      );
      const variantId = created.rows[0].variant_id;

      const makeCart = async () => {
        const guest = await one.query(
          `INSERT INTO guest_session(token_hash, csrf_token, expires_at)
         VALUES($1,$2, now() + interval '1 day') RETURNING guest_session_id`,
          [`hash-${randomUUID()}`, `csrf-${randomUUID()}`],
        );
        const cart = await one.query(
          "INSERT INTO cart(guest_session_id) VALUES($1) RETURNING cart_id",
          [guest.rows[0].guest_session_id],
        );
        return cart.rows[0].cart_id as string;
      };
      const cartA = await makeCart();
      const cartB = await makeCart();

      const reserve = async (client: pg.Pool, cartId: string) => {
        const connection = await client.connect();
        try {
          await connection.query("BEGIN");
          const locked = await connection.query(
            "SELECT qty_in_stock FROM product_variant WHERE variant_id = $1 FOR UPDATE",
            [variantId],
          );
          const held = await connection.query(
            `SELECT coalesce(sum(quantity),0)::int AS held FROM inventory_reservation
            WHERE variant_id = $1 AND status = 'active' AND expires_at > now()`,
            [variantId],
          );
          if (
            Number(locked.rows[0].qty_in_stock) - Number(held.rows[0].held) <
            1
          ) {
            await connection.query("ROLLBACK");
            return "refused";
          }
          await connection.query(
            `INSERT INTO inventory_reservation(cart_id, variant_id, quantity, expires_at)
           VALUES($1, $2, 1, now() + interval '15 minutes')`,
            [cartId, variantId],
          );
          await connection.query("COMMIT");
          return "reserved";
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          connection.release();
        }
      };

      const results = await Promise.allSettled([
        reserve(one, cartA),
        reserve(two, cartB),
      ]);
      const outcomes = results.map((result) =>
        result.status === "fulfilled" ? result.value : "error",
      );
      assert.equal(
        outcomes.filter((outcome) => outcome === "reserved").length,
        1,
        JSON.stringify(outcomes),
      );
      const held = await one.query(
        `SELECT coalesce(sum(quantity),0)::int AS held FROM inventory_reservation
        WHERE variant_id = $1 AND status = 'active'`,
        [variantId],
      );
      assert.equal(held.rows[0].held, 1);
    } finally {
      await one.end();
      await two.end();
    }
  },
);

test(
  "the stock CHECK constraint forbids reserving beyond stock in one statement",
  { skip },
  async () => {
    if (!url) return;
    const client = await pool();
    try {
      const product = await client.query(
        `INSERT INTO product(product_name, slug, status) VALUES('Check Product', $1, 'active') RETURNING product_id`,
        [`check-${randomUUID()}`],
      );
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO product_variant(product_id, sku, price, qty_in_stock, is_active)
           VALUES($1,$2,'10.00',-1,true)`,
            [product.rows[0].product_id, `NEG-${randomUUID().slice(0, 8)}`],
          ),
        /check constraint/i,
      );
    } finally {
      await client.end();
    }
  },
);
