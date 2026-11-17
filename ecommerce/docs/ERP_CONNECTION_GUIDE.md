# Connecting the storefront to Duka ERP

An ordered, copy-pasteable procedure that takes a deployed storefront from
`ERP_ENABLED=false` to a working, verified connection: ERP-side identity and
permissions, the origin the ERP must allow, the six environment values, the
handshake check, the first catalogue and stock pull, customer mapping, web-order
projection, and what to do when each step fails.

Every command below was checked against the code in this repository
(`packages/erp-adapter/src/http-transport.ts`, `packages/erp-adapter/src/adapter.ts`,
`apps/api/src/config.ts`, `apps/api/src/routes/admin.ts`) and against the ERP in
`apps/api/src/{app,routes,services}`. Nothing here was rehearsed against a live
pair of hosts, so treat the "Expect" lines as the contract you are proving, not
as output recorded from a run.

The adapter tracks 27 capabilities: 15 verified against the ERP and 12 missing.
The missing twelve are proposed in
[`ERP_INTEGRATION_CONTRACT.md`](ERP_INTEGRATION_CONTRACT.md) and are **not
implemented in the ERP** — read the status line at the top of that file before
you promise anybody reservations or webhooks.

---

## What this connection actually moves

| Direction  | Data                                                     | Triggered by                                                        | ERP permission                      |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| ERP → shop | products, variants, barcodes, brands, categories, prices | worker every 5 min, or `POST /admin/sync/pull-catalog`              | `catalog.read`                      |
| ERP → shop | stock on hand per warehouse                              | worker every 5 min, or `POST /admin/sync/pull-inventory`            | `inventory.read`                    |
| shop → ERP | customers (created or matched by `WEB-<id>` / email)     | `POST /admin/sync/customers/:id`, or the desk's "Push to ERP"       | `customers.read`, `customers.write` |
| shop → ERP | one `sales_order` document per web order, status `draft` | automatic on order placement, or `POST /admin/sync/orders/:orderId` | `documents.write`                   |

Deliberately **not** part of this connection, because the ERP has no implemented
endpoint for it (contract gaps G1–G9):

- stock reservations (`ERP_RESERVE_ORDERS_IN_ERP` stays `false` — see step 13);
- order status write-back after the document exists (no `integration/orders`);
- payment mirroring that survives (G5, plus an adapter payload gap — step 13.3);
- refunds by external reference (G6), shipments, subscriptions, media, webhooks.

The shop keeps its own PostgreSQL. It never writes to the ERP database, and the
ERP is never a datastore for the shop.

---

## 0. Before you start

On the host that runs the Duka Compose project (the ERP host; the storefront
lives in the same project, see `deploy/ecommerce/README.md`):

```bash
cd /opt/duka

# Tools the commands below use. jq is not optional: steps 1.3 onwards build
# JSON bodies with it and read ids out of responses.
for tool in curl jq docker; do
  command -v "$tool" >/dev/null || echo "missing: $tool"
done
# On a Debian/Ubuntu host:  sudo apt-get update && sudo apt-get install -y jq

# The ERP's public host and the storefront's public host.
export ERP_HOST=$(sudo sed -n 's/^PUBLIC_HOST=//p' deploy/docker/.env.production | head -n1)
export SHOP_HOST=$(sudo sed -n 's/^SHOP_PUBLIC_HOST=//p' deploy/ecommerce/.env.shop | head -n1)
echo "ERP=$ERP_HOST SHOP=$SHOP_HOST"
```

You also need, from whoever owns the ERP:

| Thing                                   | Example             | Where it comes from              |
| --------------------------------------- | ------------------- | -------------------------------- |
| an ERP account with `users.manage`      | `owner@your-domain` | the ERP owner created at go-live |
| the ERP branch the web orders belong to | `Nairobi CBD`       | step 1.3                         |
| the ERP warehouse that ships them       | `Nairobi CBD Store` | step 1.3                         |

Checklist — the order matters, because each step is what makes the next one
possible:

1. ERP is ready (`/health/ready` 200) and its origin allowlist already covers
   the origin the shop presents. **1**
2. A least-privilege ERP role and identity exist, without MFA. **2**
3. That identity can already perform the four reads and one write the adapter
   needs, proven with curl. **3**
4. The six `SHOP_ERP_*` values are in `.env.shop`, and the containers are
   recreated so they read them. **4–5**
5. The shop's probe reports `health.ok` and the right identity. **7**
6. Catalogue, stock, a customer and one order document cross the boundary. **8–11**
7. The worker keeps pulling on its own. **12**

---

## 1. Prove the ERP is ready and will accept the shop's origin

**1.1 — ERP health, from inside its own container** (no TLS, no proxy):

```bash
sudo docker exec duka-api-1 node -e \
  "fetch('http://127.0.0.1:4000/health/ready').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)})"
```

Expect `200 {"status":"ready",...}`. If it is not 200, stop: fix the ERP first
(`bash deploy/go-live.sh` prints its diagnostics; `sudo docker logs duka-api-1`).

**1.2 — Confirm the origin allowlist already covers what the shop will send.**

Both sides of this are in the deployment files, not in a database:

- the shop presents `ERP_ALLOWED_ORIGIN`, which `deploy/ecommerce/compose.shop.yml`
  sets to `https://${PUBLIC_HOST}` — that is `https://$ERP_HOST`;
- the ERP accepts `ALLOWED_ORIGINS`, which `deploy/docker/compose.yml` sets to
  `https://${PUBLIC_HOST}` — the same string.

So for the standard deployment **nothing needs editing here**. Verify the
resolved values rather than trusting them:

```bash
sudo docker inspect duka-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^ALLOWED_ORIGINS='
sudo docker inspect duka-shop-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^ERP_(ALLOWED_ORIGIN|BASE_URL)='
```

Expect the first line to contain `https://$ERP_HOST` and the second to show the
same origin, plus (`ERP_BASE_URL=https://$ERP_HOST` once step 4 is done).

> If, and only if, the storefront runs on a **different host** from the ERP:
> the shop must present an origin the ERP already lists, or the ERP operator
> must add it to `ALLOWED_ORIGINS` in `deploy/docker/.env.production`'s Compose
> environment. Production requires exact HTTPS origins, and the list must
> include `WEB_ORIGIN` (`apps/api/src/index.ts` refuses to boot otherwise).
> Do not widen the allowlist to a wildcard: it is the ERP's CSRF boundary.

**1.3 — Sign in as the ERP owner and read the branch, warehouse and payment
method ids.** Mutations need the origin header plus the CSRF token; keep the
cookie jar for the next steps.

```bash
read -rsp 'ERP owner email: ' ERP_OWNER_EMAIL; echo
read -rsp 'ERP owner password: ' ERP_OWNER_PASS; echo

curl -sS -c /tmp/erp.cookies \
  -H 'content-type: application/json' \
  -H "origin: https://$ERP_HOST" \
  -d "$(jq -nc --arg e "$ERP_OWNER_EMAIL" --arg p "$ERP_OWNER_PASS" '{email:$e,password:$p}')" \
  "https://$ERP_HOST/api/v1/auth/login" | jq '.data'

export ERP_CSRF=$(curl -sS -b /tmp/erp.cookies "https://$ERP_HOST/api/v1/auth/me" \
  | jq -r '.data.csrf_token')

curl -sS -b /tmp/erp.cookies "https://$ERP_HOST/api/v1/metadata" | jq '{
  company:  .data.company | {id, name, currency},
  branches: [.data.branches[]  | {id, name}],
  warehouses:[.data.warehouses[]| {id, name, branch_id}],
  payment_methods: [.data.payment_methods[] | {id, name, kind}],
  roles: [.data.roles[]? | {id, name}]
}'
```

Expect `signed_in: true`, then one JSON object with at least one branch, one
warehouse **inside that branch**, an active payment method, and the roles list
(the owner holds `users.manage`, so `/metadata` includes them).

Pick the two ids the shop will default to, and record the branch they belong to:

```bash
export ERP_BRANCH_ID=          # paste branches[].id
export ERP_WAREHOUSE_ID=       # paste warehouses[].id where branch_id = ERP_BRANCH_ID
```

> The warehouse must belong to that branch: the ERP rejects a sales order whose
> warehouse sits in a different branch (`BRANCH_MISMATCH`), and it rejects a
> _sales order with no warehouse at all_ (`WAREHOUSE_REQUIRED`). This is why
> `ERP_DEFAULT_WAREHOUSE_ID` is not optional even with reservations off.
>
> An ERP with several branches is fine, but every web order posts to the **one**
> pair configured here — the adapter sends `ERP_DEFAULT_BRANCH_ID` and
> `ERP_DEFAULT_WAREHOUSE_ID` on `POST /documents` and nothing routes an order by
> destination. If two shops must ship from two branches, that needs a code change,
> not a second environment variable.

---

## 2. Create the ERP role and the integration identity

Create them with curl so the ids are unambiguous. The ERP's own UI does the same
thing under **Administration → Team & access** (`https://$ERP_HOST/team`) if you
prefer to click; the JSON below is what that screen posts.

**2.1 — The role.** Six permissions, zero approval limit, nothing else.

- `catalog.read` — catalogue pull
- `inventory.read` — stock pull
- `customers.read` — the adapter searches before it creates
- `customers.write` — create the customer
- `documents.write` — create the `sales_order` document (the ERP gates both
  `GET` and `POST /documents` on this one permission)
- `payments.receive` — **omit for now**; add it only if payment mirroring is
  fixed (step 13.3). The adapter calls it, but the ERP would reject the payload.

```bash
curl -sS -b /tmp/erp.cookies -X POST "https://$ERP_HOST/api/v1/roles" \
  -H 'content-type: application/json' \
  -H "origin: https://$ERP_HOST" \
  -H "x-csrf-token: $ERP_CSRF" \
  -H "Idempotency-Key: shop-integration-role-v1" \
  -d '{
    "name": "E-commerce integration",
    "description": "Storefront: read catalogue and stock, map customers, create web sales orders. No POS, no pricing, no stock writes.",
    "approval_limit": "0",
    "permissions": ["catalog.read", "inventory.read", "customers.read", "customers.write", "documents.write"]
  }' | jq '.data | {id, name, permissions}'

export ERP_ROLE_ID=            # paste data.id
```

Expect `status`-less JSON with the five permissions echoed back. Notes:

- Every ERP mutation needs `Idempotency-Key` (8–160 characters), and the same
  key with a different body is a `409`. The static keys above are intentional:
  re-running a step returns the original result instead of creating a duplicate
  role or user.
- `approval_limit: "0"` keeps the identity unable to approve anything — a web
  order document stays `draft`.
- If `/metadata` already lists a role named _E-commerce integration_, skip this
  and reuse its id.

**2.2 — The identity.** No MFA enrolment: the ERP only asks for a TOTP code when
`identities.mfa_enabled` is true (default false), and the deployed Compose file
has no mapping for `ERP_INTEGRATION_TOTP_SECRET`. Enrolling this account would
break the login the moment the shop tried it.

```bash
read -rsp 'New integration password (12+ chars, letters and numbers): ' ERP_INT_PASS; echo
export ERP_INT_EMAIL="ecommerce@$ERP_HOST"

curl -sS -b /tmp/erp.cookies -X POST "https://$ERP_HOST/api/v1/users" \
  -H 'content-type: application/json' \
  -H "origin: https://$ERP_HOST" \
  -H "x-csrf-token: $ERP_CSRF" \
  -H "Idempotency-Key: shop-integration-user-v1" \
  -d "$(jq -nc \
        --arg p "$ERP_INT_PASS" --arg e "$ERP_INT_EMAIL" \
        --arg r "$ERP_ROLE_ID" --arg b "$ERP_BRANCH_ID" --arg w "$ERP_WAREHOUSE_ID" \
        '{name:"E-commerce integration", email:$e, password:$p,
          role_ids:[$r], branch_ids:[$b], warehouse_ids:[$w]}')" \
  | jq '.data | {id, email, status, role_ids, branch_ids, warehouse_ids}'

export ERP_INT_USER_ID=        # paste data.id
```

Expect `status: "active"` and your three ids back. The password never appears in
the response or the audit trail.

> Delegation rules the ERP enforces here: the caller can only grant permissions
> it holds and an `approval_limit` no higher than its own
> (`DELEGATION_LIMIT`, 403). An owner satisfies both; a delegated manager may
> not. Store this password in the password manager now — step 4 is the only
> place it is written down.

---

## 3. Prove the identity before the shop ever uses it

Sign in as the integration identity itself. This is exactly the login the
adapter performs: `POST /api/v1/auth/login` with an `Origin` header, expecting a
`duka_session` cookie and a `csrf_token` in the body.

```bash
curl -sS -c /tmp/shop-erp.cookies \
  -H 'content-type: application/json' \
  -H "origin: https://$ERP_HOST" \
  -d "$(jq -nc --arg e "$ERP_INT_EMAIL" --arg p "$ERP_INT_PASS" '{email:$e,password:$p}')" \
  "https://$ERP_HOST/api/v1/auth/login" | jq '.data'

export ERP_INT_CSRF=$(curl -sS -b /tmp/shop-erp.cookies "https://$ERP_HOST/api/v1/auth/me" \
  | jq -r '.data.csrf_token')
```

Expect `{"signed_in":true,"csrf_token":"…"}`. Then prove the grants:

```bash
# Identity, permissions and locations, as the shop will see them.
curl -sS -b /tmp/shop-erp.cookies "https://$ERP_HOST/api/v1/auth/me" \
  | jq '.data.actor | {email, permissions, branch_ids, warehouse_ids}'

# catalogue.read
curl -sS -b /tmp/shop-erp.cookies "https://$ERP_HOST/api/v1/products?limit=1" \
  | jq '{total: .data.total, first: (.data.items[0] // null | {id, sku})}'

# inventory.read at the default warehouse
curl -sS -b /tmp/shop-erp.cookies \
  "https://$ERP_HOST/api/v1/inventory/balances?limit=1&warehouse_id=$ERP_WAREHOUSE_ID" \
  | jq '{total: .data.total}'

# documents.write (the ERP gates this read on the write permission)
curl -sS -b /tmp/shop-erp.cookies "https://$ERP_HOST/api/v1/documents?limit=1" \
  | jq '{total: .data.total}'

# customers.read
curl -sS -b /tmp/shop-erp.cookies "https://$ERP_HOST/api/v1/customers?limit=1" \
  | jq '{total: .data.total}'
```

Expect `permissions` to be exactly the five you granted, the branch and warehouse
ids to include the ones you will configure, and every call to answer `200` with a
`total`. A `403 FORBIDDEN` here means the role is missing that permission — fix
the role (`PUT /api/v1/roles/:id`) before going further, because the shop will
surface the same failure later as `ERP_FORBIDDEN` on a sync job.

Do not create a test document to prove the write permission; the `GET` above is
gated on the same permission, and real documents would land in the ERP's
numbering sequence.

---

## 4. Write the shop's configuration

The shop reads six values out of `deploy/ecommerce/.env.shop`. Everything else
(`ERP_ALLOWED_ORIGIN`, timeouts, retry counts) is derived in
`compose.shop.yml`/`apps/api/src/config.ts` and needs no operator input.

Back up first, then rewrite only the ERP lines, keeping mode `0600`:

> Run steps 4–5 in the **same shell** as step 2, or re-export
> `ERP_INT_EMAIL`, `ERP_INT_PASS`, `ERP_BRANCH_ID` and `ERP_WAREHOUSE_ID`
> first — the block below reads them from the environment.

```bash
cd /opt/duka
sudo cp -a deploy/ecommerce/.env.shop "deploy/ecommerce/.env.shop.bak-$(date +%F)"

sudo env \
  SHOP_ERP_PASSWORD="$ERP_INT_PASS" \
  SHOP_ERP_EMAIL="$ERP_INT_EMAIL" \
  SHOP_ERP_BRANCH_ID="$ERP_BRANCH_ID" \
  SHOP_ERP_WAREHOUSE_ID="$ERP_WAREHOUSE_ID" \
  SHOP_ERP_PUBLIC_URL="https://$ERP_HOST" \
  python3 - <<'PY'
import os, pathlib
path = pathlib.Path('deploy/ecommerce/.env.shop')
updates = {
    'SHOP_ERP_ENABLED':     'true',
    'SHOP_ERP_BASE_URL':    os.environ['SHOP_ERP_PUBLIC_URL'],
    'SHOP_ERP_EMAIL':       os.environ['SHOP_ERP_EMAIL'],
    'SHOP_ERP_PASSWORD':    os.environ['SHOP_ERP_PASSWORD'],
    'SHOP_ERP_BRANCH_ID':   os.environ['SHOP_ERP_BRANCH_ID'],
    'SHOP_ERP_WAREHOUSE_ID':os.environ['SHOP_ERP_WAREHOUSE_ID'],
}
lines, seen = [], set()
for line in path.read_text().splitlines():
    key = line.split('=', 1)[0]
    if key in updates:
        lines.append(f'{key}={updates[key]}'); seen.add(key)
    else:
        lines.append(line)
for key, value in updates.items():
    if key not in seen:
        lines.append(f'{key}={value}')
path.write_text('\n'.join(lines) + '\n')
path.chmod(0o600)
print('rewrote:', ', '.join(sorted(updates)))
PY
```

Why these values:

| Key                            | Value                    | Why                                                                                                                                                   |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHOP_ERP_ENABLED`             | `true`                   | turns the adapter on; without it every `/admin/sync/*` route answers `503 ERP_UNAVAILABLE` and the worker never queues a pull                         |
| `SHOP_ERP_BASE_URL`            | `https://$ERP_HOST`      | **no path, no `/api/v1` suffix** — the adapter appends `/api/v1/...` and `/health/live` to this origin. Must be `https://`: see the defect note below |
| `SHOP_ERP_EMAIL` / `_PASSWORD` | the identity from step 2 | the shop's only ERP credential; only `shop-api` and `shop-worker` see it                                                                              |
| `SHOP_ERP_BRANCH_ID`           | from step 1.3            | required for every order document                                                                                                                     |
| `SHOP_ERP_WAREHOUSE_ID`        | from step 1.3            | required by the ERP for a `sales_order`                                                                                                               |

> **Known deployment defect — read before choosing the base URL.**
> `apps/api/src/config.ts` refuses to boot a _production_ API whose
> `ERP_BASE_URL` is not `https://` (`Production ERP integration requires
ERP_BASE_URL to use https`). The shipped defaults —
> `SHOP_ERP_BASE_URL=http://api:4000` in `deploy/ecommerce/init-shop-env.sh` and
> in `deploy/ecommerce/compose.shop.yml` — therefore cannot start once
> `SHOP_ERP_ENABLED=true`. Until that default is corrected, use
> `https://$ERP_HOST`: Caddy already routes `/api/*` **and** `/health/*` on that
> host to `api:4000` (`deploy/docker/Caddyfile`), so every adapter call works
> over the public name, with a real certificate and the same origin the ERP's
> allowlist already contains.
>
> The cost is that these calls leave the container, resolve the public host and
> come back through Caddy (or the Cloudflare tunnel). If you would rather keep
> the hop private on the `edge` network, that needs a deliberate one-line change
> to the production rule — allow plain `http://` for the in-network `api` host —
> together with `SHOP_ERP_BASE_URL=http://api:4000`. Do not make that change
> just to avoid reading this note.

Confirm the containers will resolve the values (secrets redacted):

```bash
sudo docker compose \
  --env-file deploy/docker/.env.production \
  --env-file deploy/ecommerce/.env.shop \
  -p duka \
  -f deploy/docker/compose.yml \
  -f deploy/cloudflare/compose.tunnel.yml \
  -f deploy/ecommerce/compose.shop.yml \
  config 2>/dev/null \
  | sed -n '/^  shop-api:/,/^  shop-worker:/p' \
  | grep -E 'ERP_(ENABLED|BASE_URL|ALLOWED_ORIGIN|INTEGRATION_EMAIL|INTEGRATION_PASSWORD|DEFAULT_(BRANCH|WAREHOUSE)_ID)' \
  | sed -E 's/(ERP_INTEGRATION_PASSWORD)([:=] ?).*/\1\2<redacted>/'
```

Expect `ERP_ENABLED: "true"`, `ERP_BASE_URL: https://$ERP_HOST`,
`ERP_ALLOWED_ORIGIN: https://$ERP_HOST`, your email, your two uuid values, and
`ERP_INTEGRATION_PASSWORD: <redacted>`.

---

## 5. Recreate the shop's API and worker

`docker restart` would not help: container environments are fixed at creation, so
the two ERP-aware services must be **recreated**.

First a pre-flight, because with an `https://` base URL the shop reaches the ERP
over its public name, through whatever sits in front of it (Caddy, or a Cloudflare
tunnel). Run this from **inside the shop API container**:

```bash
sudo docker exec duka-shop-api-1 node -e \
  "fetch('https://$ERP_HOST/health/ready').then(r=>console.log(r.status)).catch(e=>console.log('ERR', e.message))"
```

`200` and you are ready to recreate. Two failure modes are worth naming:

- `ERR …` — no egress, or DNS inside the container cannot resolve the public host.
  That is the case the private-hop note above exists for.
- `403`, a `text/html` body, or an access-login page instead of JSON — something
  in front of the ERP (Cloudflare Access, a WAF rule) is intercepting
  server-to-server calls. The shop's adapter cannot answer an HTML challenge; put
  a bypass rule in place for the shop's egress or use the private hop.

```bash
sudo bash deploy/ecommerce/shop.sh up
```

That rebuilds the images, re-runs migrations (forward-only, safe to re-run),
restarts `shop-api`, `shop-worker`, `shop-web` and the proxy, waits for healthy
status, and checks the storefront route answers HTML at the origin. If you only
changed `.env.shop` and the images are already current, this is the quicker
equivalent:

```bash
sudo docker compose \
  --env-file deploy/docker/.env.production \
  --env-file deploy/ecommerce/.env.shop \
  -p duka \
  -f deploy/docker/compose.yml \
  -f deploy/cloudflare/compose.tunnel.yml \
  -f deploy/ecommerce/compose.shop.yml \
  up -d --no-deps --force-recreate shop-api shop-worker
```

Then confirm both are up and the API is ready:

```bash
sudo bash deploy/ecommerce/shop.sh status
sudo docker inspect duka-shop-api-1 duka-shop-worker-1 \
  --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}} (no healthcheck){{end}}'
```

Expect `ready 200`, `duka-shop-api-1 healthy`, and `duka-shop-worker-1 running (no
healthcheck)` — the worker deliberately has none, so treat its heartbeat as the
health signal:

```bash
sudo docker exec duka-shop-api-1 node -e \
  "fetch('http://127.0.0.1:4100/health/ready').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.checks.worker)))"
```

Expect `stale: false` with an `age_seconds` under 120. `/health/ready` also
reports `checks.erp_enabled` — if it still says `false`, the container was not
recreated or `.env.shop` was not the file Compose read.

---

## 6. Get a storefront admin session for the checks

The desk and these checks use the shop's own identity realm, not the ERP's.

```bash
read -rsp 'Shop admin email: ' SHOP_ADMIN_EMAIL; echo
read -rsp 'Shop admin password: ' SHOP_ADMIN_PASS; echo

export SHOP_CSRF=$(curl -sS -c /tmp/shop.cookies \
  -H 'content-type: application/json' \
  -H "origin: https://$SHOP_HOST" \
  -d "$(jq -nc --arg e "$SHOP_ADMIN_EMAIL" --arg p "$SHOP_ADMIN_PASS" '{email:$e,password:$p}')" \
  "https://$SHOP_HOST/api/v1/admin/auth/login" \
  | jq -r '.data.csrf_token')

echo "${SHOP_CSRF:0:8}…"   # never print the whole token
```

Shop rules that apply to every call below:

- the `Origin` header must be in `ALLOWED_ORIGINS` (`https://$SHOP_HOST`), even
  for the login itself;
- every non-GET needs `x-csrf-token: $SHOP_CSRF` from that login;
- the signed-in admin needs `sync.manage` (the seeded `owner` role has it) — a
  support or auditor role will get `403` and should not be used for this.

---

## 7. Probe: the handshake

```bash
curl -sS -b /tmp/shop.cookies -X POST "https://$SHOP_HOST/api/v1/admin/erp/probe" \
  -H "origin: https://$SHOP_HOST" -H "x-csrf-token: $SHOP_CSRF" | jq
```

Expect:

```json
{
  "data": {
    "enabled": true,
    "probed": true,
    "health": { "ok": true, "live": true, "ready": true },
    "identity": {
      "id": "…",
      "email": "ecommerce@…",
      "permissions": ["catalog.read", "…"]
    },
    "error": null
  }
}
```

Read it in three parts:

- `enabled: false, probed: false` → the API process still has
  `ERP_ENABLED=false`. Go back to step 5.
- `health.ok: false` → the container cannot reach `ERP_BASE_URL`. Test the same
  URL from inside it, substituting your value:
  `sudo docker exec duka-shop-api-1 node -e "fetch('https://$ERP_HOST/health/ready').then(r=>console.log(r.status))"`.
  A DNS failure here means the container has no route to the public name — the
  reason the private-hop variant exists at all (see the defect note in step 4).
- `error` non-null with `identity: null` → the credential or origin handshake
  failed; `error` carries the ERP's code (see the troubleshooting table).

Also worth one glance, so you know what this deployment expects from the ERP:

```bash
curl -sS -b /tmp/shop.cookies -H "origin: https://$SHOP_HOST" \
  "https://$SHOP_HOST/api/v1/admin/erp/capabilities" \
  | jq '{enabled: .data.enabled, verified: [.data.capabilities[] | select(.support=="verified") | .id] | length,
         missing: [.data.capabilities[] | select(.support!="verified") | .id] }'
```

That table is **static** — it is the adapter's compiled contract view (15
verified, 12 missing), not a live measurement of your ERP. Never read it as a
probe; the probe in step 7 is the live one.

---

## 8. Pull the catalogue

```bash
curl -sS -b /tmp/shop.cookies -X POST "https://$SHOP_HOST/api/v1/admin/sync/pull-catalog" \
  -H "origin: https://$SHOP_HOST" -H "x-csrf-token: $SHOP_CSRF" | jq '.data'
```

Expect `{"run_id":"catalog-…","products":N,"variants":M,"brands":…,"categories":…}`.

What this does, and what to watch for:

- every **active** ERP product and its variants are created in the shop database
  with the ERP's price, barcode and on-hand quantity, and mapped in
  `erp_entity_map`; mapped rows are updated in place, and a product the ERP has
  deactivated becomes `archived`;
- products you created by hand in the shop (no ERP mapping) are left alone;
- the first pull therefore publishes the ERP's catalogue on the storefront.
  Review it before customers see it. Anything you do not want live can be
  archived from **Catalogue** on the desk, or with
  `PATCH /admin/products/:productId/status {"status":"draft"}`.

Verify the mapping, not just the counters:

```bash
curl -sS -b /tmp/shop.cookies -H "origin: https://$SHOP_HOST" \
  "https://$SHOP_HOST/api/v1/admin/erp/mappings?entity_type=variant&limit=5" \
  | jq '.data | {total, items: [.items[] | {local_id, erp_id}]}'
```

Expect one row per ERP SKU. `total: 0` after a successful pull means the ERP
returned no products (check the ERP's `active` filter and that the catalogue is
not empty) — the shop will not invent products.

The pull also records `erp.last_catalog_sync` in `app_setting`, which is what the
desk's ERP sync tab shows as "last catalogue".

---

## 9. Pull stock

```bash
curl -sS -b /tmp/shop.cookies -X POST "https://$SHOP_HOST/api/v1/admin/sync/pull-inventory" \
  -H "origin: https://$SHOP_HOST" -H "x-csrf-token: $SHOP_CSRF" | jq '.data'
```

Expect `{"run_id":"inventory-…","updated":N,"skipped":M}`. `skipped` counts ERP
stock rows whose product has no local mapping — if it is not zero, finish step 8
first. Then check the storefront agrees with the ERP: pick a mapped SKU, open
`https://$SHOP_HOST/p/<slug>`, and compare the available quantity with
`GET /api/v1/inventory/balances?warehouse_id=$ERP_WAREHOUSE_ID` on the ERP. The
shop displays ERP stock and never adjusts it: a sale in the shop does not decrement
the ERP, because stock movement still happens in the ERP (reservations are off).

---

## 10. Map and push a customer

Find a registered customer and push it:

```bash
curl -sS -b /tmp/shop.cookies -H "origin: https://$SHOP_HOST" \
  "https://$SHOP_HOST/api/v1/admin/customers?limit=5" \
  | jq '.data.items[] | {customer_id, email, erp_customer_id}'
```

```bash
export SHOP_CUSTOMER_ID=       # paste customer_id

curl -sS -b /tmp/shop.cookies -X POST \
  "https://$SHOP_HOST/api/v1/admin/sync/customers/$SHOP_CUSTOMER_ID" \
  -H "origin: https://$SHOP_HOST" -H "x-csrf-token: $SHOP_CSRF" | jq '.data'
```

Expect `{"erp_customer_id":"…","matched_existing":false}` — or `true` if the ERP
already had a customer with code `WEB-<id>` or the same email (the adapter
searches before it creates, so a repeat push does not duplicate the contact).

Guest orders are a separate matter: their customer id is null, so they cannot be
mapped, and their order document will be created without a customer. That is
valid only while guest checkout stays enabled; see
`storefront.allow_guest_checkout` if you need every web order tied to a contact.

---

## 11. Push an order document (no reservation)

Order placement queues this automatically once the integration is on, but
proving it here — against a known order — is the step that catches mapping
mistakes:

```bash
curl -sS -b /tmp/shop.cookies -H "origin: https://$SHOP_HOST" \
  "https://$SHOP_HOST/api/v1/admin/orders?limit=5" \
  | jq '.data.items[] | {order_id, order_number, status}'
```

```bash
export SHOP_ORDER_ID=          # paste order_id

curl -sS -b /tmp/shop.cookies -X POST \
  "https://$SHOP_HOST/api/v1/admin/sync/orders/$SHOP_ORDER_ID" \
  -H "origin: https://$SHOP_HOST" -H "x-csrf-token: $SHOP_CSRF" | jq '.data'
```

Expect `{"erp_document_id":"…","reserved":false}`. `{"skipped":true,…}` means the
order already has a mapping — nothing was sent twice.

In the ERP, that id is a `sales_order` document in status `draft`: it carries the
lines and the customer, but it moves **no stock** and reserves nothing, because
approval is what does that and `ERP_RESERVE_ORDERS_IN_ERP` is off. Confirm on the
ERP's own **Documents** screen (`https://$ERP_HOST/documents`, which itself needs
`documents.write` to open) before telling anyone "orders are in the ERP".

Two failures worth recognising immediately:

- `Variant N has no ERP mapping. Run the catalogue sync before pushing orders.`
  → step 8 has not run, or the shop product is hand-made and has no ERP SKU.
  Map it or archive it; do not push the order.
- `ERP_DEFAULT_BRANCH_ID is not configured` → step 4 wrote an empty value.

---

## 12. Confirm the worker keeps it in sync

```bash
curl -sS -b /tmp/shop.cookies -H "origin: https://$SHOP_HOST" \
  "https://$SHOP_HOST/api/v1/admin/sync/overview" | jq '.data | {enabled, jobs, settings, recent: [.recent_logs[] | {operation, status, error_code}]}'
```

Expect `enabled: true`, `jobs` counted by status (`succeeded` growing;
`dead: 0`), and recent logs for `pull_catalog` / `pull_inventory` roughly every
five minutes — `ERP_SYNC_INTERVAL_MS` defaults to `300000` and the worker tick
runs every five seconds, enqueueing one pull per interval bucket.

If nothing appears: check the worker is the ERP-aware container
(`sudo docker logs --tail=50 duka-shop-worker-1` should log
`erp_enabled: true` at startup), and that `shop-api` and `shop-worker` were both
recreated in step 5.

Keep the queue honest:

| `jobs` key            | Meaning                                             | Action                                                                           |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `succeeded`           | applied                                             | none                                                                             |
| `pending` / `running` | queued, claimed                                     | wait one tick; `POST /admin/sync/process` forces a pass                          |
| `retry`               | transport/5xx/429                                   | transient — watch it clear; investigate if it climbs                             |
| `dead`                | permanent (validation, permission, missing mapping) | read `recent_logs[].error_message`, fix the cause, then re-run the specific push |

---

## 13. Go-live checklist

**13.1 — Keep reservations off.** `ERP_RESERVE_ORDERS_IN_ERP=false` is the
default in `apps/api/src/config.ts`, and the deployed Compose file does not
expose it at all, so there is nothing to set. It must stay off until the ERP
implements a reservation contract (G3): approving a document is a POS-shaped
action that would take stock away from the till without a release path.

**13.2 — What the ERP will and will not see.**

| Shop event                  | Reaches the ERP                     | Notes                                           |
| --------------------------- | ----------------------------------- | ----------------------------------------------- |
| new product / price / stock | pulls only                          | the shop is a read-only mirror of ERP catalogue |
| new order placed            | yes, `sales_order` document `draft` | queued at placement                             |
| payment recorded / webhook  | **no**                              | see 13.3                                        |
| refund                      | **no**                              | G6                                              |
| shipment                    | **no**                              | no `integration/shipments`                      |
| order status change         | **no**                              | the ERP never learns `shipped`/`delivered`      |
| new customer                | only when pushed                    | no automatic push on registration               |

**13.3 — Payment mirroring is not usable yet.** Two independent blockers, both
in this repository rather than your configuration:

1. `pushPayment` requires a mapped customer and an `erp.payment_method_id` in
   `app_setting`; neither exists by default, and guest payments are refused
   outright (`ERP_CONTRACT_UNSUPPORTED`).
2. Even with both configured, `ErpAdapter.settleCustomer` posts
   `{payment, allocations?}` to `POST /api/v1/customers/settlements`, while the
   ERP's `settlementSchema` requires `contact_id` and `branch_id` and is
   `.strict()`. The ERP answers `422` (`ERP_VALIDATION`).

So expect `push_payment` jobs to land `dead` with a clear message. That is
intentional failure, not a misconfiguration: recording money against a guessed
method or contact would be worse. Do not configure `erp.payment_method_id` to
"make it green" — fix the adapter payload (or wait for G5) first.

**13.4 — Least privilege and proof.** The integration identity holds five
permissions and no approval limit. It cannot post a sale, change a price, move
stock, or approve its own document. Every push shows up in the ERP's own audit
trail with that identity as the actor, and in the shop's **Activity** tab as
`erp.order_pushed` / `erp.catalog_pulled`.

**13.5 — Backups still cover both sides.** `bash deploy/update.sh` takes the ERP
backup, then an encrypted, verified shop dump. Enabling the integration changes
no backup behaviour, but the shop's dump now contains ERP-mapped foreign ids —
restore both from the same point in time or re-run step 8 to rebuild the map.

---

## 14. Rotation, disabling and rollback

**Rotate the integration password** (ERP-side first, then the shop):

```bash
# As the integration identity: change it and revoke every session it holds.
curl -sS -b /tmp/shop-erp.cookies -X POST "https://$ERP_HOST/api/v1/auth/change-password" \
  -H 'content-type: application/json' -H "origin: https://$ERP_HOST" \
  -H "x-csrf-token: $ERP_INT_CSRF" -H "Idempotency-Key: shop-integration-rotate-$(date +%s)" \
  -d "$(jq -nc --arg c "$ERP_INT_PASS" --arg n "$NEW_ERP_INT_PASS" '{current_password:$c,new_password:$n}')" \
  | jq '.data'
```

Then re-run step 4 with `SHOP_ERP_PASSWORD="$NEW_ERP_INT_PASS"` and recreate the
services (step 5). The adapter re-logs in on its own; there is no cached token to
clear.

**Disable the integration in a hurry** — set `SHOP_ERP_ENABLED=false`, recreate
`shop-api` and `shop-worker` (step 5). The shop keeps selling: checkout, orders
and stock stay local, and `/admin/sync/*` answers `503 ERP_UNAVAILABLE` with an
explanation instead of pretending. Queued jobs simply stop being processed; they
resume when you turn it back on (retries are bounded by each job's
`max_attempts`).

**Suspend the ERP identity instead** — the owner can, without touching the shop:

```bash
curl -sS -b /tmp/erp.cookies -X POST "https://$ERP_HOST/api/v1/users/<integration-id>/access" \
  -H 'content-type: application/json' -H "origin: https://$ERP_HOST" \
  -H "x-csrf-token: $ERP_CSRF" -H "Idempotency-Key: shop-integration-suspend-v1" \
  -d "$(jq -nc --arg r "$ERP_ROLE_ID" --arg b "$ERP_BRANCH_ID" --arg w "$ERP_WAREHOUSE_ID" \
        '{status:"suspended", role_ids:[$r], branch_ids:[$b], warehouse_ids:[$w], reason:"Storefront integration suspended"}')" \
  | jq '.data'
```

That also revokes the identity's ERP sessions — the shop's next call fails at
login with `ERP_AUTH_FAILED`, which is exactly the signal you want in the logs.
Note the same endpoint requires the full role/branch/warehouse triple: it is a
replace, not a patch.

---

## 15. Troubleshooting

Every row is a real code path: the shop's error code first, then the ERP's.

| Symptom                                                                                                 | Cause                                                                    | Fix                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| probe `enabled:false`                                                                                   | the API container still has `ERP_ENABLED=false`                          | step 4, then **recreate** (not restart) `shop-api`                                                                   |
| `shop-api` restarts in a loop, log says `Production ERP integration requires ERP_BASE_URL to use https` | `SHOP_ERP_BASE_URL` is `http://…`                                        | set it to `https://$ERP_HOST` (step 4) and recreate                                                                  |
| `jq: command not found`, or `curl: Failed writing body` after a pipe into jq                            | `jq` is not installed on the host                                        | `sudo apt-get update && sudo apt-get install -y jq` (step 0)                                                         |
| `unknown shorthand flag: 'T' in -T`                                                                     | `docker exec` has no `-T`; that flag belongs to `docker compose exec`    | drop it: `docker exec duka-api-1 node -e …`                                                                          |
| probe answers but `health.ok:false` while every other call works                                        | `/health/*` not routed on the base URL you chose                         | use `https://$ERP_HOST`; its Caddy site routes `/api/*` and `/health/*`                                              |
| `ERP_UNAVAILABLE` on every job                                                                          | `ERP_BASE_URL` unreachable, or it carries a path                         | keep it `https://$ERP_HOST` with no path; test the same URL from inside the container                                |
| `ERP_TIMEOUT`                                                                                           | ERP slow or the first login blocking on something                        | check ERP `/health/ready`; timeouts default to 15 s (`ERP_REQUEST_TIMEOUT_MS`)                                       |
| `ERP_AUTH_FAILED` (`INVALID_CREDENTIALS`)                                                               | wrong password, or the identity is `inactive`/`suspended`                | sign in as the identity with curl (step 3); re-activate via `/users/:id/access`                                      |
| `ERP_AUTH_FAILED` (`MFA_REQUIRED`)                                                                      | the identity has MFA enrolled                                            | create a fresh identity without `mfa.enable`, or add `ERP_INTEGRATION_TOTP_SECRET` support to the Compose file first |
| `ERP_AUTH_FAILED` (`CSRF_INVALID`)                                                                      | a non-GET without a matching `X-CSRF-Token`                              | adapter handles this; if you see it, your own curl is missing the header                                             |
| `ERP_FORBIDDEN` on login / any mutation, message mentions origin                                        | the presented `Origin` is not in the ERP's `ALLOWED_ORIGINS`             | compare step 1.2's two values; add the exact origin on the ERP side                                                  |
| `ERP_FORBIDDEN` on documents                                                                            | branch or warehouse outside the identity's assignments                   | include them in `branch_ids`/`warehouse_ids` (step 2.2)                                                              |
| `ERP_VALIDATION` (`BRANCH_MISMATCH` / `WAREHOUSE_REQUIRED`)                                             | wrong warehouse for the branch, or none configured                       | re-read step 1.3; the pair must match                                                                                |
| `ERP_RATE_LIMITED`                                                                                      | ERP login limit: 10 per email per 15 minutes                             | stop retrying; the adapter backs off, and the limiter clears on its own                                              |
| `ERP_PROTOCOL` "returned no duka_session cookie"                                                        | a proxy or wrong base URL is stripping cookies                           | point `ERP_BASE_URL` at the API origin, not at a static host or a CDN                                                |
| `ERP_NOT_FOUND`                                                                                         | typical for `/api/v1/integration/*`                                      | those endpoints are proposals, not implementations — stop calling them                                               |
| `ERP_CONTRACT_UNSUPPORTED` on orders                                                                    | variant has no ERP mapping                                               | run step 8 first                                                                                                     |
| `ERP_CONTRACT_UNSUPPORTED` on payments                                                                  | guest order, unmapped customer, or no `erp.payment_method_id`            | expected; see 13.3                                                                                                   |
| jobs stuck `retry`                                                                                      | ERP 5xx or network                                                       | watch it; if it persists, probe (step 7) and check the ERP logs                                                      |
| `429`/`403` from the **shop** API                                                                       | missing `Origin`, missing `x-csrf-token`, or admin without `sync.manage` | step 6                                                                                                               |

Logs worth tailing while you work:

```bash
sudo docker logs -f --tail=100 duka-shop-api-1     # sync routes, ERP errors, request ids
sudo docker logs -f --tail=100 duka-shop-worker-1  # periodic pulls, retries
sudo docker logs -f --tail=100 duka-api-1          # the ERP's view of the same calls
```

---

## Appendix A — Capabilities that work today, and the ones that do not

Verified against the ERP in this repository. "Verified" means the endpoint
exists, the permission is enforceable, and the adapter's payload matches the ERP's
schema.

| Capability                                                                                                                                           | Endpoint                                 | Works                                                         | Permission             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| session login                                                                                                                                        | `POST /api/v1/auth/login`                | yes                                                           | none (+ `Origin`)      |
| identity + permissions                                                                                                                               | `GET /api/v1/auth/me`                    | yes                                                           | none                   |
| readiness                                                                                                                                            | `GET /health/live`, `/health/ready`      | yes                                                           | none                   |
| metadata (branch/warehouse ids)                                                                                                                      | `GET /api/v1/metadata`                   | yes                                                           | none (scoped)          |
| catalogue                                                                                                                                            | `GET /api/v1/products`                   | yes                                                           | `catalog.read`         |
| stock                                                                                                                                                | `GET /api/v1/inventory/balances`         | yes                                                           | `inventory.read`       |
| customer search/create/update                                                                                                                        | `GET/POST /api/v1/customers`, `PUT /:id` | yes                                                           | `customers.read/write` |
| sales-order document                                                                                                                                 | `POST /api/v1/documents`                 | yes (`draft`)                                                 | `documents.write`      |
| document approval (reserves stock)                                                                                                                   | `POST /documents/:id/transition`         | yes, but intentionally unused                                 | `documents.write`      |
| payment settlement                                                                                                                                   | `POST /api/v1/customers/settlements`     | **payload mismatch** (adapter omits `contact_id`/`branch_id`) | `payments.receive`     |
| sales, returns, settlements read                                                                                                                     | `/api/v1/sales*`                         | unused by this connection                                     | `sales.read`, …        |
| `integration/*` (tokens, capabilities, reservations, availability, orders, payments, refunds, shipments, subscriptions, media, incremental products) | —                                        | **not implemented** (G1–G9)                                   | —                      |

## Appendix B — The same steps through the two UIs

| Step                           | ERP (`https://$ERP_HOST`)             | Storefront (`https://$SHOP_HOST/admin`)                 |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------- |
| create role + identity         | **Administration → Team & access**    | —                                                       |
| observe branch/warehouse ids   | not shown; use `GET /api/v1/metadata` | —                                                       |
| change `SHOP_ERP_*`            | —                                     | host shell + `deploy/ecommerce/.env.shop` (step 4)      |
| handshake                      | —                                     | **Operations → ERP sync** → Probe                       |
| pull catalogue / stock         | —                                     | **Operations → ERP sync** → Pull catalogue / Pull stock |
| push a customer                | —                                     | **Customers** → Push to ERP                             |
| process the queue              | —                                     | **Operations → ERP sync** → Process queue               |
| settings and capability counts | —                                     | **Operations → Settings**, **Operations → ERP sync**    |
| audit of every push            | **Administration → Audit trail**      | **Operations → Activity**                               |

The UI and the curl steps call the same routes with the same permissions, so
either direction is a valid check on the other.
