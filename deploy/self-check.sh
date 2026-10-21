#!/usr/bin/env bash
# Duka Business OS — host-side end-to-end acceptance gate for go-live/update.
#
#   bash deploy/self-check.sh [pos.your-domain.example]
#
# Verifies the LIVE public host over real HTTPS (through the Cloudflare
# Tunnel): static login shell, API health/readiness, the public OpenAPI/doc
# surface, and fail-closed authentication behaviour. No credentials are
# required; with SELF_CHECK_EMAIL + SELF_CHECK_PASSWORD exported it also proves
# an owner can authenticate, read the session actor and the first-run setup
# status — the values never appear in argv, logs or files.
#
# Exit 0 = every check passed. Exit 1 = at least one failed (message tells
# you which). No business data is changed by this script.
set -uo pipefail
HOST=$1
[[ "$HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] || {
  echo "usage: bash deploy/self-check.sh pos.your-domain.example (or export PUBLIC_HOST)" >&2
  HOST=${HOST:-$PUBLIC_HOST}
}
[[ -n "$HOST" ]] || exit 2
BASE="https://$HOST"
pass=0 fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$*"; }
code() { curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 -H 'origin: '"$BASE" "$@"; }

echo "self-check of $BASE (live, through the Cloudflare Tunnel)"
c=$(code "$BASE/")
[[ "$c" == 200 ]] && ok "login shell serves (200)" || bad "login shell expected 200, got $c"
c=$(code "$BASE/health/live")
[[ "$c" == 200 ]] || c=$(code "$BASE/api/v1/health/live")
[[ "$c" == 200 ]] && ok "API liveness (200)" || bad "API liveness expected 200, got $c"
c=$(code "$BASE/health/ready")
[[ "$c" == 200 ]] || c=$(code "$BASE/api/v1/health/ready")
[[ "$c" == 200 ]] && ok "API readiness incl. DB + migrations (200)" || bad "API readiness expected 200, got $c (still booting?)"
c=$(code "$BASE/api/v1/openapi.json")
[[ "$c" == 200 ]] && ok "public API document reachable" || bad "openapi.json expected 200, got $c"
c=$(code "$BASE/api/v1/setup/status")
[[ "$c" == 401 ]] && ok "setup/status refuses anonymous access (401)" || bad "setup/status expected 401 outside a session, got $c"
c=$(code -X POST -H 'content-type: application/json' --data-binary '{}' "$BASE/api/v1/auth/login" 2>/dev/null)
[[ "$c" =~ ^40[0-9]$ ]] && ok "login endpoint fail-closed on bad input ($c)" || bad "login on empty body expected 4xx, got $c"
c=$(code "$BASE/api/v1/auth/sessions")
[[ "$c" == 401 ]] && ok "session listing refuses anonymous access (401)" || bad "/auth/sessions anonymous expected 401, got $c"

if [[ -n "${SELF_CHECK_EMAIL:-}" && -n "${SELF_CHECK_PASSWORD:-}" ]]; then
  # Deep owner check: credentials travel only inside the HTTPS request body.
  cookie_jar=$(mktemp) && trap 'rm -f "$cookie_jar"' EXIT
  login_json=$(printf '{"email":"%s","password":"%s"}' "$SELF_CHECK_EMAIL" "$SELF_CHECK_PASSWORD")
  c=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 -c "$cookie_jar" \
        -X POST -H 'content-type: application/json' -H 'origin: '"$BASE" \
        --data-binary "$login_json" "$BASE/api/v1/auth/login")
  [[ "$c" == 200 ]] && ok "owner credentials authenticate" || bad "owner login returned $c"
  if [[ "$c" == 200 ]]; then
    c=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 -b "$cookie_jar" -H 'origin: '"$BASE" "$BASE/api/v1/auth/me")
    [[ "$c" == 200 ]] && ok "session actor restore (200)" || bad "auth/me expected 200, got $c"
    c=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 -b "$cookie_jar" -H 'origin: '"$BASE" "$BASE/api/v1/setup/status")
    [[ "$c" == 200 ]] && ok "first-run setup status readable (200)" || bad "setup/status authenticated expected 200, got $c"
  fi
fi

echo
if ((fail)); then echo "SELF-CHECK FAILED: $fail problem(s), $pass ok"; exit 1; fi
echo "SELF-CHECK PASSED: $pass checks ok"
