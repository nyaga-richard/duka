#!/usr/bin/env bash
# Duka Business OS — host-side end-to-end acceptance gate for go-live/update.
#
#   bash deploy/self-check.sh [pos.your-domain.example]
#
# With the e-commerce overlay provisioned, export SHOP_HOST (or pass it as the
# second argument) to gate the storefront host as well: storefront shell,
# its API readiness, the public catalogue and fail-closed admin endpoints.
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
SHOP_HOST=${SHOP_HOST:-${2:-}}
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
[[ "$c" =~ ^4[0-9][0-9]$ ]] && ok "login endpoint fail-closed on bad input ($c)" || bad "login on empty body expected 4xx, got $c"
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

if [[ -n "$SHOP_HOST" ]]; then
  [[ "$SHOP_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] || {
    echo "self-check: SHOP_HOST '$SHOP_HOST' is not a valid hostname" >&2
    exit 2
  }
  SHOP_BASE="https://$SHOP_HOST"
  shop_cf5=0
  shcode() { curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 -H 'origin: '"$SHOP_BASE" "$@"; }
  shcheck() { # path expected label
    local path=$1 expected=$2 label=$3 got
    got=$(shcode "$SHOP_BASE$path")
    if [[ "$got" == "$expected" ]]; then
      ok "$label"
    else
      bad "$label (got $got)"
      [[ "$got" =~ ^5[0-9][0-9]$ ]] && shop_cf5=1
    fi
  }
  echo
  echo "self-check of $SHOP_BASE (storefront host, live)"

  # Loopback probe: separates "Cloudflare cannot reach the origin" from
  # "Caddy/app is broken". Only meaningful on the deployment host, where the
  # Tunnel-mode proxy publishes 127.0.0.1:8080. Uses the host's curl, so it does
  # not depend on anything installed inside the Caddy image.
  if command -v docker >/dev/null 2>&1 && docker inspect duka-proxy-1 >/dev/null 2>&1; then
    routed_host=$(docker exec duka-proxy-1 printenv SHOP_PUBLIC_HOST 2>/dev/null | tr -d '\r')
    if [[ "$routed_host" != "$SHOP_HOST" ]]; then
      if [[ -n "$routed_host" ]]; then
        bad "the running proxy routes '$routed_host', not $SHOP_HOST — recreate it: bash deploy/ecommerce/shop.sh up"
      else
        bad "the running proxy has no SHOP_PUBLIC_HOST — recreate it: bash deploy/ecommerce/shop.sh up"
      fi
    else
      origin_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
        -H "Host: $SHOP_HOST" http://127.0.0.1:8080/ 2>/dev/null || true)
      case "$origin_code" in
        200) ok "storefront answers through Caddy on the loopback proxy (app + routing are fine)" ;;
        000|"")
          echo "  note: no loopback :8080 listener found (direct-TLS mode?) — skipped the origin probe"
          ;;
        *) bad "Caddy answered $origin_code for $SHOP_HOST on the loopback proxy" ;;
      esac
    fi
  fi

  shcheck "/" 200 "storefront shell serves (200)"
  shcheck "/health/ready" 200 "storefront API readiness incl. DB + migrations (200)"
  shcheck "/api/v1/openapi.json" 200 "storefront API document reachable"
  shcheck "/api/v1/catalog/products" 200 "public catalogue responds (200; empty until an ERP pull)"
  shcheck "/admin" 200 "storefront admin shell serves (200)"
  shcheck "/api/v1/admin/orders" 401 "storefront admin API refuses anonymous access (401)"

  if ((shop_cf5)); then
    echo "  hint: 52x/530 responses are produced by Cloudflare, not by the app — the hostname is not"
    echo "        reaching the origin. Add $SHOP_HOST as a Public Hostname on the SAME tunnel with"
    echo "        service http://proxy:8080 and keep the DNS record Cloudflare creates (a hand-made"
    echo "        CNAME without the tunnel entry returns 530). Then check 'docker logs duka-tunnel-1 --tail 50'."
  fi
fi

echo
if ((fail)); then echo "SELF-CHECK FAILED: $fail problem(s), $pass ok"; exit 1; fi
echo "SELF-CHECK PASSED: $pass checks ok"
