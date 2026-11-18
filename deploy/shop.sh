#!/usr/bin/env bash
# Operate the storefront stack, which runs INSIDE the Duka (ERP) Compose project.
#
# This repository is the shop. The Compose project, the edge proxy and the
# generated ERP configuration live in the ERP checkout, found at `../duka` by
# default or wherever `ERP_DIR` points:
#
#   ERP_DIR=/opt/duka bash deploy/shop.sh status
#
#   bash deploy/shop.sh status
#   bash deploy/shop.sh up            # build + start + migrate (safe to re-run)
#   bash deploy/shop.sh logs [service]
#   bash deploy/shop.sh proxy        # force-recreate the edge proxy (re-reads the Caddyfile)
#   bash deploy/shop.sh diag         # read-only: who answers the shop hostname, and why
#   bash deploy/shop.sh tunnel       # read-only: is the public hostname bound to this tunnel?
#   bash deploy/shop.sh migrate       # forward-only, reviewed migrations
#   bash deploy/shop.sh seed          # settings + first admin (needs ADMIN_BOOTSTRAP_*)
#   bash deploy/shop.sh backup        # encrypted custom-format dump + verification
#   bash deploy/shop.sh restore FILE  # decrypt + restore into the shop database
#   bash deploy/shop.sh psql          # interactive SQL as the shop role
#
# It reuses the ERP's deploy/docker/.env.production and this repo's
# deploy/.env.shop; it never prints secret values, and it never touches the Duka
# (ERP) database.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$(cd "$here/.." && pwd)

die() { echo "shop: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

erp=${ERP_DIR:-$stage/../duka}
[[ -d "$erp" ]] || die "no ERP checkout at $erp — clone nyaga-richard/duka beside this repo, or set ERP_DIR to its path"
erp=$(cd "$erp" && pwd)
docker_dir="$erp/deploy/docker"
tunnel_file="$erp/deploy/cloudflare/compose.tunnel.yml"
env_file="$docker_dir/.env.production"
shop_env="$here/.env.shop"
key_file="$here/secrets/shop-backup.key"
backup_dir="$here/backups"

dc() { SHOP_REPO_DIR="$stage" docker compose --env-file "$env_file" --env-file "$shop_env" -p duka \
  -f "$docker_dir/compose.yml" -f "$tunnel_file" \
  -f "$here/compose.shop.yml" "$@"; }

[[ -e "$env_file" ]] || die "no $env_file — install Duka (the ERP) with its deploy/go-live.sh first"
[[ -e "$shop_env" ]] || die "no $shop_env — provision the shop with deploy/init-shop-env.sh"
docker ps >/dev/null 2>&1 || die "Docker is not reachable"
SHOP_PUBLIC_HOST=$(sed -n 's/^SHOP_PUBLIC_HOST=//p' "$shop_env" | head -n1)

wait_healthy() { # wait_healthy container attempts
  local container=$1 attempts=${2:-40} waited=0 status
  while :; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && return 0
    ((waited < attempts)) || { echo "shop: $container is $status" >&2; return 1; }
    sleep 3
    waited=$((waited + 1))
  done
}

# The one acceptance check that catches a *routing* mistake: ask the loopback
# origin for the storefront hostname and require the storefront's HTML. A JSON
# 404 here means Caddy matched the shop host to the API instead of shop-web.
verify_route() {
  command -v curl >/dev/null 2>&1 || return 0
  local attempt=0 out code ctype
  while :; do
    out=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --max-time 8 \
      -H "Host: $SHOP_PUBLIC_HOST" http://127.0.0.1:8080/ 2>/dev/null) || out='000'
    [[ "$out" != 000* ]] && break
    ((attempt++ , attempt < 6)) || {
      # Direct-TLS deployments publish 80/443, not a loopback :8080.
      echo "  note: no loopback :8080 listener (direct-TLS mode) — skipped the route check"
      return 0
    }
    sleep 1
  done
  code=${out%% *}
  ctype=${out#* }
  if [[ "$code" == 200 && "$ctype" == text/html* ]]; then
    echo "  ok   $SHOP_PUBLIC_HOST/ -> 200 $ctype (storefront route)"
    return 0
  fi
  printf '  FAIL %s/ -> %s %s (expected 200 text/html)\n' "$SHOP_PUBLIC_HOST" "$code" "$ctype"
  if [[ "$code" == 404 && "$ctype" == application/json* ]]; then
    echo "        the API answered, so the storefront route is not matching. Run"
    echo "        'bash deploy/shop.sh diag' — it prints the compiled routes."
  fi
  return 1
}

cmd=${1:-status}
shift || true
case "$cmd" in
  status)
    dc ps
    # This is the private health endpoint; it is not reachable from the internet
    # except through the storefront hostname.
    dc exec -T shop-api node -e \
      "fetch('http://127.0.0.1:4100/health/ready').then(async r=>{console.log('ready', r.status); process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
    ;;
  up)
    step "Building storefront images"
    dc --profile ops build shop-api shop-web
    step "Starting the storefront database"
    dc up -d shop-db
    wait_healthy duka-shop-db-1 30 || die "the storefront database did not become healthy"
    step "Applying storefront migrations"
    dc --profile ops run --rm shop-migrate
    step "Starting API, worker and web"
    dc up -d shop-api shop-worker shop-web proxy
    wait_healthy duka-shop-api-1 40 || die "the storefront API did not become healthy; check 'shop.sh logs shop-api'"
    wait_healthy duka-shop-web-1 40 || die "the storefront web app did not become healthy; check 'shop.sh logs shop-web'"
    step "Checking the storefront route at the origin"
    verify_route || exit 1
    echo "Storefront is up behind the proxy on host $SHOP_PUBLIC_HOST."
    ;;
  logs)
    dc logs --tail=100 "${1:-shop-api}"
    ;;
  migrate)
    dc --profile ops run --rm shop-migrate
    ;;
  seed)
    [[ -n "${ADMIN_BOOTSTRAP_EMAIL:-}" && -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]] ||
      die "export ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (12+ chars) for the first storefront administrator"
    dc --profile ops run --rm \
      -e ADMIN_BOOTSTRAP_EMAIL -e ADMIN_BOOTSTRAP_PASSWORD \
      shop-seed
    ;;
  backup)
    [[ -e "$key_file" ]] || die "missing $key_file (created by init-shop-env.sh); generate a new key only if you accept losing the ability to read older dumps"
    docker inspect duka-shop-db-1 >/dev/null 2>&1 || die "the storefront database is not running"
    mkdir -p "$backup_dir"
    chmod 700 "$backup_dir"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    out="$backup_dir/shop-$stamp.dump.enc"
    step "Dumping the storefront database (custom format, encrypted with $key_file)"
    if ! dc exec -T shop-db pg_dump -U shop_app -Fc ecommerce |
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$key_file" -out "$out"; then
      rm -f "$out"
      die "the storefront dump failed; nothing was verified"
    fi
    chmod 600 "$out"
    step "Verifying the dump decrypts into a readable archive"
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$key_file" -in "$out" |
      dc exec -T shop-db pg_restore --list >/dev/null; then
      die "the storefront dump did not verify; treat it as unusable and investigate"
    fi
    echo "Verified encrypted storefront dump: $out ($(du -h "$out" | cut -f1))"
    echo "Custody: this key is SEPARATE from deploy/docker/secrets/backup.key. Store both offline."
    ;;
  restore)
    file=${1:-}
    [[ -n "$file" && -e "$file" ]] || die "usage: shop.sh restore /path/to/shop-YYYYMMDDTHHMMSSZ.dump.enc"
    [[ -e "$key_file" ]] || die "missing $key_file; the dump cannot be decrypted without it"
    step "Restoring $file into the shop database (drops and recreates owned objects)"
    echo "This overwrites the current storefront data. Five seconds to abort (Ctrl-C)..."
    sleep 5
    openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$key_file" -in "$file" |
      dc exec -T shop-db pg_restore -U shop_app -d ecommerce --clean --if-exists --no-owner
    ;;
  psql)
    dc exec shop-db psql -U shop_app -d ecommerce
    ;;
  diag)
    # Read-only forensics for "the storefront hostname answers with the wrong
    # app". Every block prints facts, never guesses, and nothing is modified.
    tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
    diag_public=$(sed -n 's/^PUBLIC_HOST=//p' "$env_file" | head -n1)
    probe() { # probe container port path
      local name=$1 port=$2 path=$3 ip out
      ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$name" 2>/dev/null |
        awk '{print $1}')
      if [[ -z "$ip" ]]; then printf '  %-11s not running\n' "$name"; return 0; fi
      out=$(curl -sS -o "$tmp/body" -D "$tmp/head" -w '%{http_code} %{content_type}' \
        --max-time 6 "http://$ip:$port$path" 2>/dev/null || echo 'unreachable')
      printf '  %-11s %s:%s%s -> %s\n' "$name" "$ip" "$port" "$path" "$out"
      if [[ -s "$tmp/body" ]]; then
        printf '              body: '
        head -c 90 "$tmp/body" | tr -d '\r\n' | sed 's/[^[:print:]]/./g'
        printf '\n'
      fi
    }

    step "1/5 the Caddyfile the running proxy actually has mounted"
    host_hash=$(sha256sum "$erp/deploy/cloudflare/Caddyfile" 2>/dev/null | awk '{print $1}')
    cont_hash=$(docker exec duka-proxy-1 sha256sum /etc/caddy/Caddyfile 2>/dev/null | awk '{print $1}')
    printf '  host   %s  %s\n' "$erp/deploy/cloudflare/Caddyfile" "${host_hash:-unreadable}"
    printf '  proxy  /etc/caddy/Caddyfile         %s\n' "${cont_hash:-unreadable}"
    if [[ -n "$host_hash" && -n "$cont_hash" && "$host_hash" != "$cont_hash" ]]; then
      echo "  MISMATCH — the container is serving an older file (bind mount still on the old inode)."
      echo "  fix: bash deploy/shop.sh proxy"
    fi
    for v in PUBLIC_HOST SHOP_PUBLIC_HOST; do
      printf '  env %-16s %s\n' "$v" "$(docker exec duka-proxy-1 printenv "$v" 2>/dev/null || echo '<unset>')"
    done

    step "2/5 compiled routes on :8080 (order matters: first match wins)"
    if docker exec duka-proxy-1 caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
      >"$tmp/caddy.json" 2>"$tmp/caddy.err"; then
      if command -v python3 >/dev/null 2>&1; then
        python3 - "$tmp/caddy.json" <<'PY'
import json, sys

cfg = json.load(open(sys.argv[1]))

# Registered Caddy matcher names. If one of these shows up as a *value* inside
# another matcher's list, the Caddyfile line held two matchers and the second one
# was swallowed as arguments (e.g. host: [shop…, path, /api/*, /health/*]).
MATCHER_NAMES = {
    "host", "path", "method", "query", "header", "header_regexp", "path_regexp",
    "expression", "file", "protocol", "remote_ip", "client_ip", "vars", "named",
    "not", "form", "json", "tls", "match",
}


def walk(routes, depth):
    for route in routes:
        match = route.get("match")
        for handler in route.get("handle", []):
            dials = [u.get("dial") for u in handler.get("upstreams", [])]
            label = json.dumps(match, separators=(",", ":")) if match else "(no matcher: catch-all)"
            for matcher_set in match or []:
                if not isinstance(matcher_set, dict):
                    continue
                for key, values in matcher_set.items():
                    if not isinstance(values, list):
                        continue
                    rogue = sorted({v for v in values
                                    if isinstance(v, str) and v in MATCHER_NAMES and v != key})
                    if rogue:
                        print("  " * (depth + 1) +
                              "  !! MALFORMED MATCHER: %r contains matcher name(s) %s as values\n"
                              % (key, ", ".join(rogue)) +
                              "  " * (depth + 1) +
                              "  !! a named-matcher line can hold ONE matcher; put each on its own line")
            print("  " * (depth + 1) + "%s -> %s %s" % (
                label, handler.get("handler", "?"), " ".join(d for d in dials if d)))
            if handler.get("routes"):
                walk(handler["routes"], depth + 1)


for name, server in cfg.get("apps", {}).get("http", {}).get("servers", {}).items():
    print("  server %s listen=%s" % (name, ",".join(server.get("listen", []))))
    walk(server.get("routes", []), 0)
PY
      else
        echo "  python3 not present; raw compiled config: $tmp/caddy.json (kept until this command exits)"
        cp "$tmp/caddy.json" /tmp/duka-caddy-adapted.json
        echo "  saved a copy at /tmp/duka-caddy-adapted.json"
      fi
    else
      echo "  'caddy adapt' failed — the file on disk does not parse:"
      sed -n '1,4p' "$tmp/caddy.err" | sed 's/^/  /'
    fi

    step "3/5 the upstream containers, asked directly (bypasses Caddy)"
    probe duka-shop-web-1 3100 /
    probe duka-shop-api-1 4100 /health/ready

    step "4/5 what the origin answers per Host header on 127.0.0.1:8080"
    for h in "${diag_public:-duka.invalid}" "${SHOP_PUBLIC_HOST:-shop.invalid}"; do
      for p in / /api/v1/catalog/products; do
        out=$(curl -sS -o "$tmp/body" -D "$tmp/head" -w '%{http_code} %{content_type}' \
          --max-time 6 -H "Host: $h" "http://127.0.0.1:8080$p" 2>/dev/null || echo 'unreachable')
        printf '  %-28s %-24s -> %s\n' "$h" "$p" "$out"
      done
    done
    echo "  (a JSON 404 on '/' means the API answered; 'shop-api' also logs the GET with its request_id)"

    step "5/5 tunnel container"
    docker ps --filter name=duka-tunnel-1 --format '  {{.Names}}  {{.Status}} {{.Ports}}' || true
    docker logs duka-tunnel-1 --tail 6 2>&1 | sed 's/^/  /' || true
    echo
    echo "A 530 on the public hostname is Cloudflare's: bind $SHOP_PUBLIC_HOST as a Public Hostname"
    echo "on the SAME tunnel (service http://proxy:8080). This command changes nothing."
    ;;
  tunnel)
    # Read-only: is the public hostname bound to THIS tunnel? A 530 is decided in
    # Cloudflare, so the useful facts are the tunnel's own ingress config, the
    # UUID a DNS record has to point at, and what each public name answers.
    tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
    diag_public=$(sed -n 's/^PUBLIC_HOST=//p' "$env_file" | head -n1)
    cat > "$tmp/uuid.py" <<'PY'
import base64, json, sys

raw = sys.stdin.read().strip()
raw += "=" * (-len(raw) % 4)
try:
    print(json.loads(base64.b64decode(raw, altchars=b"-_")).get("t", ""))
except Exception:
    print("")
PY
    cat > "$tmp/ingress.py" <<'PY'
import re, sys

raw = sys.stdin.read()
pairs = re.findall(r'\\"hostname\\":\\"([^\\"]+)\\",\\"service\\":\\"([^\\"]+)\\"', raw)
if not pairs:
    print("  could not parse the ingress list; raw line:")
    print("  " + raw.strip()[:400])
for host, service in pairs:
    print("  %-32s -> %s" % (host, service))
if pairs:
    print("  (the connector accepted this config, so these are this tunnel's routes)")
PY

    step "1/4 tunnel container"
    docker ps --filter name=duka-tunnel-1 --format '  {{.Names}}  {{.Status}}' || true

    step "2/4 the tunnel this token belongs to"
    # The cloudflared image is distroless: no shell, no printenv, so `docker exec`
    # cannot read its environment. Take the token from the private env file the
    # container was created from, and fall back to the container's own Config.Env.
    token=$(sed -n 's/^TUNNEL_TOKEN=//p' "$env_file" | head -n1 | tr -d '\r')
    if [[ -z "$token" ]]; then
      token=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' duka-tunnel-1 2>/dev/null |
        sed -n 's/^TUNNEL_TOKEN=//p' | head -n1 | tr -d '\r')
    fi
    uuid=$(printf '%s' "$token" | python3 "$tmp/uuid.py" 2>/dev/null || true)
    if [[ -n "$uuid" ]]; then
      printf '  tunnel UUID   %s\n' "$uuid"
      printf '  bound CNAME   %s.cfargotunnel.com\n' "$uuid"
      echo "  (only the id is printed, never the token secret)"
    else
      echo "  could not read the tunnel UUID from the container's token"
    fi

    step "3/4 ingress this connector last accepted"
    docker logs duka-tunnel-1 --tail 400 2>&1 |
      grep 'Updated to new configuration' | tail -n1 >"$tmp/ingress.log" || true
    if [[ ! -s "$tmp/ingress.log" ]]; then
      echo "  no 'Updated to new configuration' line in the last 400 lines"
    elif command -v python3 >/dev/null 2>&1; then
      python3 "$tmp/ingress.py" <"$tmp/ingress.log"
    else
      echo "  python3 not present; raw line:"
      cut -c1-400 "$tmp/ingress.log"
    fi

    step "4/4 what the public hostnames answer"
    for h in "${diag_public:-}" "$SHOP_PUBLIC_HOST"; do
      [[ -n "$h" ]] || continue
      # `|| code=000` (not `|| echo 000`): curl already printed its -w output
      # before failing, so appending would yield a bogus "000000".
      code=$(curl -sS -o "$tmp/pub.html" -w '%{http_code}' --max-time 15 "https://$h/" 2>/dev/null) ||
        code=000
      [[ -n "$code" ]] || code=000
      printf '  %-32s %s' "$h" "$code"
      if grep -qiE 'error 1033|argo tunnel error' "$tmp/pub.html" 2>/dev/null; then
        printf '  (Cloudflare 1033: this hostname has no DNS record on an active tunnel)'
      elif grep -qi 'error 1016' "$tmp/pub.html" 2>/dev/null; then
        printf '  (Cloudflare 1016: the DNS record points at a different origin)'
      fi
      printf '\n'
    done
    echo
    if [[ -s "$tmp/ingress.log" ]] && grep -qF "$SHOP_PUBLIC_HOST" "$tmp/ingress.log"; then
      echo "The hostname IS in this tunnel's ingress, so the server side is done: a 5xx here is"
      echo "Cloudflare's DNS record for $SHOP_PUBLIC_HOST. Delete that record under DNS, then"
      echo "re-add the Public Hostname on this tunnel (service http://proxy:8080) so Cloudflare"
      if [[ -n "$uuid" ]]; then
        echo "creates the proxied CNAME to $uuid.cfargotunnel.com for you."
      else
        echo "creates the proxied CNAME for you."
      fi
    else
      echo "The hostname is NOT in this tunnel's ingress: add $SHOP_PUBLIC_HOST as a Public"
      echo "Hostname on this tunnel with service http://proxy:8080, and keep the DNS record"
      echo "Cloudflare creates. Do not create a second tunnel or a second token."
    fi
    echo "This command changes nothing."
    ;;
  proxy)
    # `docker restart duka-proxy-1` is not always enough: if the container's
    # Caddyfile predates the current one on disk, the running config stays stale
    # and the shop host can be served by the wrong upstream (a JSON 404 from the
    # API instead of the storefront). Force-recreating re-adapts the file.
    step "Recreating the edge proxy so Caddy re-reads the ERP's deploy/cloudflare/Caddyfile"
    dc up -d --force-recreate --no-deps proxy
    verify_route || exit 1
    ;;
  down)
    step "Stopping storefront containers (database volume is preserved)"
    dc stop shop-worker shop-web shop-api
    ;;
  *)
    die "unknown command '$cmd' (status|up|logs|proxy|diag|tunnel|migrate|seed|backup|restore|psql|down)"
    ;;
esac
