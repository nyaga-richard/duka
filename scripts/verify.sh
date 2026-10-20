#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if(+process.versions.node.split(".")[0]!==24){console.error("Use the verified Node24 runtime from .nvmrc");process.exit(1)}'
mkdir -p artifacts/verification
npm run typecheck 2>&1 | tee artifacts/verification/typecheck.log
npm test 2>&1 | tee artifacts/verification/tests-node24.log
npm audit --omit=dev --json > artifacts/verification/security-audit.json
DEMO_MODE=false npm run build 2>&1 | tee artifacts/verification/build.log
npm run test:e2e 2>&1 | tee artifacts/verification/e2e.log
printf '\nLocal verification commands passed. This is NOT live provider/host/security/accounting production approval.\n'
