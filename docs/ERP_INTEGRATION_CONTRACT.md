# ERP Integration Contract — requested additions

Status: **proposal, not implemented in the ERP.** The e-commerce adapter treats each item
below as an `unsupported` capability and never calls a route that does not exist.

These contracts support the gaps identified in
[`ERP_INTEGRATION_CAPABILITY_REPORT.md`](./ERP_INTEGRATION_CAPABILITY_REPORT.md). They are
written to fit the ERP's existing conventions (`/api/v1`, `{data, meta.request_id}`, decimal
strings, `Idempotency-Key`, permission checks, `FOR UPDATE` locking, audit logging), so they
can be implemented without changing existing behaviour.

---

## G1 — Machine authentication

`POST /api/v1/integration/tokens`

```json
{
  "client_id": "shop-prod",
  "client_secret": "<secret>",
  "scope": ["catalog.read", "inventory.read"]
}
```

Response `201`:

```json
{
  "data": {
    "access_token": "<opaque>",
    "token_type": "Bearer",
    "expires_in": 900,
    "scope": ["catalog.read", "inventory.read"]
  },
  "meta": { "request_id": "..." }
}
```

Requirements: scopes are intersected with the identity's roles; tokens are hashed at rest;
`Authorization: Bearer …` accepted **alongside** the existing session path; audit every
issuance; support rotation and revocation (`DELETE /api/v1/integration/tokens/current`).
Interim option (no ERP change): session login + cookie + CSRF + `Origin`, as implemented.

## G2 — Capabilities

`GET /api/v1/integration/capabilities` → `{ data: { version, capabilities: ["catalog.read.v1", …], limits: { page_max: 100 } } }`

The adapter uses this to decide whether reservation, order posting or webhooks are available
instead of guessing.

## G3 — TTL reservations

`POST /api/v1/integration/reservations` (idempotent)

```json
{
  "channel": "web",
  "warehouse_id": "uuid",
  "ttl_seconds": 900,
  "lines": [{ "product_id": "uuid", "quantity": 2 }]
}
```

`201` → `{ "data": { "reservation_id": "uuid", "expires_at": "2026-11-16T10:15:00Z",
"lines": [{ "product_id": "uuid", "quantity": 2, "available_after": 8 }] } }`

`DELETE /api/v1/integration/reservations/{id}` releases; expiry is swept by the ERP worker
and recorded as a stock movement of type `reservation_expired`. Errors: `409 INSUFFICIENT_STOCK`
with per-line availability.

`GET /api/v1/integration/availability?warehouse_id=&product_ids=csv` →
`{ data: [{ product_id, on_hand, reserved, available, version }] }`.

## G4 — Channel orders (no cashier shift)

`POST /api/v1/integration/orders` (idempotent)

```json
{
  "external_ref": "EC-20261116-000123",
  "channel": "web",
  "branch_id": "uuid",
  "warehouse_id": "uuid",
  "customer": { "erp_customer_id": "uuid" },
  "lines": [{ "product_id": "uuid", "quantity": 2, "unit_price": "1250.00" }],
  "shipping": { "method": "countrywide", "amount": "500.00" },
  "totals": {
    "subtotal": "2500.00",
    "discount": "0.00",
    "shipping": "500.00",
    "total": "3000.00"
  },
  "reservation_id": "uuid"
}
```

`201` → `{ "data": { "order_id": "uuid", "number": "WEB-000123", "status": "placed" } }`

Semantics: server re-prices, consumes an existing reservation (or reserves), posts no cash
tender, sets the order to a channel-appropriate status, and writes an audit entry naming the
e-commerce actor. `GET /api/v1/integration/orders/{id}` returns status, payment and shipment
state; `POST …/{id}/cancel` reverses reservations and (if unpaid) cancels.

Interim option (no ERP change): `POST /documents` + `approve` + POS conversion, which needs
`documents.write`, `sales.price_override`, an approval limit and a second approving identity
or `allowSelfApproval=true`.

## G5 — Payments by external reference

`POST /api/v1/integration/payments` (idempotent)

```json
{
  "external_ref": "mpesa:QK12AB34CD",
  "order_id": "uuid",
  "amount": "3000.00",
  "currency": "KES",
  "method": "mpesa",
  "provider": "mpesa",
  "provider_reference": "QK12AB34CD",
  "received_at": "2026-11-16T09:59:00Z"
}
```

`201` → `{ "data": { "payment_id": "uuid", "allocated": "3000.00", "unapplied": "0.00" } }`

Duplicate `(provider, provider_reference)` returns the original payment (`200`), never a
second posting. Reject amount/currency mismatches with `422`.

## G6 — Refunds by external reference

`POST /api/v1/integration/refunds` (idempotent)

```json
{
  "external_ref": "refund:<uuid>",
  "order_id": "uuid",
  "payment_reference": "QK12AB34CD",
  "amount": "500.00",
  "reason": "Damaged item",
  "restock": true,
  "lines": [{ "product_id": "uuid", "quantity": 1 }]
}
```

`201` → `{ "data": { "refund_id": "uuid", "credit_note": "CN-000042", "status": "succeeded" } }`

## G7 — Shipments

`POST /api/v1/integration/shipments` → `{ order_id, carrier, tracking_number, tracking_url,
lines: [{ order_line_id, quantity }] }`; `PATCH …/{id}` with `status` in
`dispatched|in_transit|delivered|failed|returned` and timestamps. Creates/links a
`delivery_note` document in the ERP.

## G8 — Outbound events

`POST /api/v1/integration/subscriptions`

```json
{
  "url": "https://shop-api.example/api/v1/webhooks/erp",
  "events": [
    "product.updated",
    "stock.changed",
    "order.paid",
    "shipment.updated"
  ],
  "secret": "<HMAC secret>"
}
```

Delivery: `POST` with headers `X-ERP-Event`, `X-ERP-Delivery` (uuid), `X-ERP-Signature:
t=<unix>,v1=<hex hmac-sha256(t + "." + body)>`; retries with exponential backoff for 24 h;
each delivery idempotent by `X-ERP-Delivery`. The e-commerce side already stores inbound
webhooks with a unique `(provider, event_id)` constraint and replays safely.

## G9 — Public media

`GET /api/v1/integration/media/{attachment_id}` → `{ data: { url: "https://…signed…", expires_at } }`
or documented public object URLs. Required because `GET /attachments/:id` is authenticated
and cannot be embedded by a public storefront.

## G10 — Variant/option read model

Extend product payloads with:

```json
{
  "id": "uuid",
  "sku": "TS-BLK-M",
  "price": "1250.00",
  "options": [
    { "name": "Colour", "value": "Black" },
    { "name": "Size", "value": "M" }
  ],
  "attributes": [{ "key": "material", "label": "Material", "value": "Cotton" }],
  "images": [{ "url": "https://…", "sort_order": 1 }]
}
```

## G11 — Incremental catalogue

`GET /api/v1/integration/products?updated_since=2026-11-16T00:00:00Z&cursor=…&limit=100` →
`{ data: { items: […], next_cursor: "…" } }`. Today only page/limit ≤ 100 exists and there is
no `updated_since` filter, so full paging is required.

## G12 — Channel shift automation (alternative to G4)

`POST /api/v1/integration/registers/{register_id}/shifts` with
`{ "channel": "web", "opening_float": "0.00", "reason": "Web fulfilment channel" }` creates a
system-owned shift so `POST /sales` can run unchanged. This requires an explicit ERP product
decision (a shift with no cashier is a control change) and is therefore listed as an
alternative, not a recommendation.

---

## How the adapter represents these today

`packages/erp-adapter/src/contract.ts` exports `ERP_CAPABILITIES`, with each entry marked
`verified` (exists in the ERP source, with its route and permission) or `unsupported`
(requested above). The admin API exposes this list at
`GET /api/v1/admin/erp/capabilities`, and sync jobs that would need an unsupported capability
fail with `ERP_CONTRACT_UNSUPPORTED` and a readable reason instead of pretending to succeed.
