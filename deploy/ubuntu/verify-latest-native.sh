#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_DIR:?Set the private backup directory}"
: "${RESTORE_ADMIN_DATABASE_URL:?Set the disposable-database maintenance URL}"
latest=$(/usr/bin/node --input-type=module -e '
 import fs from "node:fs";import path from "node:path";
 const names=fs.readdirSync(process.env.BACKUP_DIR).filter(n=>/^duka-[0-9TZ.a-f-]+\.enc$/.test(n)).sort();
 if(!names.length)process.exit(1);console.log(path.join(process.env.BACKUP_DIR,names.at(-1)));
')
exec /usr/bin/node artifacts/server/restore-test.mjs "$latest"
