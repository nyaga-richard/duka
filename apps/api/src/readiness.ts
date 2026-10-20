import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pool } from "./db.ts";
export async function assertDatabaseReady() {
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication
  )
    throw new Error(
      "API role must not have superuser, BYPASSRLS, CREATEDB, CREATEROLE or replication authority",
    );
  if (
    process.env.NODE_ENV === "production" &&
    (
      await pool.query(
        "SELECT 1 FROM pg_tables WHERE schemaname='public' AND pg_has_role(current_user,tableowner,'MEMBER') LIMIT 1",
      )
    ).rowCount
  )
    throw new Error(
      "Production API must use a non-owning runtime role, separate from the migrator",
    );
  if (process.env.NODE_ENV === "production") {
    const privileges = (
      await pool.query(
        "SELECT has_schema_privilege(current_user,'public','CREATE') AS schema_create,pg_has_role(current_user,(SELECT datdba FROM pg_database WHERE datname=current_database()),'MEMBER') AS database_owner,EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_checkpoint','pg_create_subscription') AND pg_has_role(current_user,r.oid,'MEMBER')) AS server_authority",
      )
    ).rows[0];
    if (
      privileges.schema_create ||
      privileges.database_owner ||
      privileges.server_authority
    )
      throw new Error(
        "Production runtime must not own the database, create schema objects or hold server-administration roles",
      );
  }
  const files = (await readdir("database/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const applied = (
    await pool.query(
      "SELECT name,checksum FROM schema_migrations ORDER BY name",
    )
  ).rows;
  if (applied.length !== files.length)
    throw new Error(
      "Database/code migration versions differ. Apply the reviewed migrations explicitly before startup.",
    );
  for (let i = 0; i < files.length; i++)
    if (
      applied[i].name !== files[i] ||
      applied[i].checksum !==
        createHash("sha256")
          .update(await readFile("database/migrations/" + files[i], "utf8"))
          .digest("hex")
    )
      throw new Error("Database migration checksums differ from this release");
  const names = [
    "companies",
    "products",
    "journals",
    "journal_lines",
    "stock_balances",
    "stock_movements",
    "sales",
    "purchase_orders",
    "supplier_invoices",
    "supplier_credit_settlements",
    "cancelled_commands",
    "expense_refunds",
    "opening_items",
    "opening_batches",
    "opening_allocations",
    "opening_cutovers",
    "opening_batch_reversals",
  ];
  const tables = (
    await pool.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])",
      [names],
    )
  ).rows;
  if (
    tables.length !== names.length ||
    tables.some((r) => !r.relrowsecurity || !r.relforcerowsecurity)
  )
    throw new Error(
      "Required tenant tables must have FORCE ROW LEVEL SECURITY",
    );
  return { migrations: files.length };
}
