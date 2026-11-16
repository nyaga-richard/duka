#!/usr/bin/env node
/** CLI: apply or inspect migrations. Usage: tsx scripts/migrate.ts [--status] */
import { closeDatabase, getDatabase } from "../apps/api/src/db/index.ts";
import { migrate, migrationStatus } from "../apps/api/src/db/migrate.ts";
import { describeConfig } from "../apps/api/src/config.ts";

const status = process.argv.includes("--status");
const db = await getDatabase();

try {
  console.log(JSON.stringify(describeConfig(), null, 2));
  if (status) {
    const rows = await migrationStatus(db);
    for (const row of rows) {
      console.log(
        `${row.applied ? "applied" : "pending"}  ${row.version}  ${row.name}` +
          (row.applied && row.checksum_matches === false ? "  CHECKSUM MISMATCH" : ""),
      );
    }
    if (rows.some((r) => r.applied && r.checksum_matches === false)) process.exitCode = 1;
  } else {
    const result = await migrate(db, { log: (line) => console.log(line) });
    console.log(
      `migrations complete: ${result.applied.length} applied, ${result.alreadyApplied} already applied`,
    );
  }
} finally {
  await closeDatabase();
}
