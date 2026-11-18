import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  startTestContext,
  seedCatalogue,
  type TestContext,
  type CatalogueFixture,
} from "../helpers.ts";

let ctx: TestContext;
let catalogue: CatalogueFixture;
let customerId: number;

const insertCustomer = async (email = "constraints@example.test") => {
  const row = await ctx.db.query<{ customer_id: number }>(
    `INSERT INTO customer(email, password_hash, first_name, last_name) VALUES($1,'x','Test','Shopper')
     RETURNING customer_id`,
    [email],
  );
  return row.rows[0]!.customer_id;
};

const insertCart = async (owner: {
  customerId?: number;
  guestSessionId?: string;
}) => {
  const row = await ctx.db.query<{ cart_id: string }>(
    "INSERT INTO cart(customer_id, guest_session_id) VALUES($1,$2) RETURNING cart_id",
    [owner.customerId ?? null, owner.guestSessionId ?? null],
  );
  return row.rows[0]!.cart_id;
};

const insertOrder = async (
  statusId = 2,
  subtotal = "100.00",
  discount = "0.00",
  shipping = "0.00",
  totalOverride?: string,
) => {
  const total =
    totalOverride ??
    (Number(subtotal) - Number(discount) + Number(shipping)).toFixed(2);
  const row = await ctx.db.query<{ order_id: number }>(
    `INSERT INTO customer_order(customer_id, order_status_id, subtotal, discount_total, shipping_cost, order_total, email)
     VALUES($1,$2,$3,$4,$5,$6,'constraints@example.test') RETURNING order_id`,
    [customerId, statusId, subtotal, discount, shipping, total],
  );
  return row.rows[0]!.order_id;
};

async function expectDbError(
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
) {
  try {
    await promise;
    assert.fail(`expected database error ${code}`);
  } catch (error: any) {
    assert.equal(
      error.code,
      code,
      `expected ${code}, received ${error.code}: ${error.message}`,
    );
    if (message) assert.match(error.message, message);
  }
}

before(async () => {
  ctx = await startTestContext();
  catalogue = await seedCatalogue(ctx.db);
  customerId = await insertCustomer();
});

after(async () => {
  await ctx.cleanup();
});

test("customer email is unique and must be lower case", async () => {
  await expectDbError(insertCustomer("constraints@example.test"), "23505");
  await expectDbError(
    insertCustomer("UPPER@example.test"),
    "23514",
    /ck_customer_email_lower/,
  );
});

test("foreign keys are enforced (order line needs a real order and variant)", async () => {
  await expectDbError(
    ctx.db.query(
      "INSERT INTO order_line(order_id, variant_id, quantity, unit_price) VALUES(999999,$1,1,'10.00')",
      [catalogue.variant_id],
    ),
    "23503",
  );
  const orderId = await insertOrder();
  await expectDbError(
    ctx.db.query(
      "INSERT INTO order_line(order_id, variant_id, quantity, unit_price) VALUES($1,999999,1,'10.00')",
      [orderId],
    ),
    "23503",
  );
});

test("an order cannot contain the same variant twice", async () => {
  const orderId = await insertOrder();
  await ctx.db.query(
    "INSERT INTO order_line(order_id, variant_id, quantity, unit_price) VALUES($1,$2,1,'10.00')",
    [orderId, catalogue.variant_id],
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO order_line(order_id, variant_id, quantity, unit_price) VALUES($1,$2,1,'10.00')",
      [orderId, catalogue.variant_id],
    ),
    "23505",
  );
});

test("order totals must add up and be non-negative", async () => {
  await expectDbError(
    insertOrder(2, "100.00", "0.00", "0.00", "120.00"),
    "23514",
    /ck_order_math/,
  );
  await expectDbError(insertOrder(2, "-1.00", "0.00", "0.00"), "23514");
});

test("reviews are limited to 1–5 stars and one per purchased line", async () => {
  const orderId = await insertOrder();
  const line = await ctx.db.query<{ order_line_id: number }>(
    "INSERT INTO order_line(order_id, variant_id, quantity, unit_price) VALUES($1,$2,1,'10.00') RETURNING order_line_id",
    [orderId, catalogue.variant_id],
  );
  const lineId = line.rows[0]!.order_line_id;
  await expectDbError(
    ctx.db.query("INSERT INTO review(order_line_id, rating) VALUES($1,6)", [
      lineId,
    ]),
    "23514",
    /ck_review_rating/,
  );
  await ctx.db.query("INSERT INTO review(order_line_id, rating) VALUES($1,5)", [
    lineId,
  ]);
  await expectDbError(
    ctx.db.query("INSERT INTO review(order_line_id, rating) VALUES($1,4)", [
      lineId,
    ]),
    "23505",
  );
});

test("a cart has exactly one owner", async () => {
  await expectDbError(
    ctx.db.query(
      "INSERT INTO cart(customer_id, guest_session_id) VALUES(NULL,NULL)",
    ),
    "23514",
  );
  const guest = await ctx.db.query<{ guest_session_id: string }>(
    "INSERT INTO guest_session(token_hash, csrf_token, expires_at) VALUES('hash-1','csrf',now() + interval '1 day') RETURNING guest_session_id",
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO cart(customer_id, guest_session_id) VALUES($1,$2)",
      [customerId, guest.rows[0]!.guest_session_id],
    ),
    "23514",
  );
});

test("one active cart per customer, but a converted cart does not block a new one", async () => {
  const first = await insertCart({ customerId });
  await expectDbError(insertCart({ customerId }), "23505");
  await ctx.db.query(
    "UPDATE cart SET status = 'converted' WHERE cart_id = $1",
    [first],
  );
  const second = await insertCart({ customerId });
  assert.ok(second);
});

test("reservations require a positive quantity and unique active cart+variant", async () => {
  const cartId = await insertCart({
    customerId: await insertCustomer("reservations@example.test"),
  });
  await expectDbError(
    ctx.db.query(
      "INSERT INTO inventory_reservation(cart_id, variant_id, quantity, expires_at) VALUES($1,$2,0, now() + interval '10 minutes')",
      [cartId, catalogue.variant_id],
    ),
    "23514",
  );
  await ctx.db.query(
    "INSERT INTO inventory_reservation(cart_id, variant_id, quantity, expires_at) VALUES($1,$2,2, now() + interval '10 minutes')",
    [cartId, catalogue.variant_id],
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO inventory_reservation(cart_id, variant_id, quantity, expires_at) VALUES($1,$2,1, now() + interval '10 minutes')",
      [cartId, catalogue.variant_id],
    ),
    "23505",
  );
});

test("payments must be positive and provider references are unique per transaction", async () => {
  const orderId = await insertOrder();
  await expectDbError(
    ctx.db.query(
      "INSERT INTO payment(order_id, provider_reference, amount, payment_status) VALUES($1,'ref-1',0,'succeeded')",
      [orderId],
    ),
    "23514",
  );
  const transaction = await ctx.db.query<{ transaction_id: string }>(
    `INSERT INTO payment_transaction(order_id, provider, amount, idempotency_key) VALUES($1,'manual','10.00','key-1') RETURNING transaction_id`,
    [orderId],
  );
  await ctx.db.query(
    "INSERT INTO payment(order_id, provider_reference, amount, payment_status, payment_transaction_id) VALUES($1,'ref-1','10.00','succeeded',$2)",
    [orderId, transaction.rows[0]!.transaction_id],
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO payment(order_id, provider_reference, amount, payment_status, payment_transaction_id) VALUES($1,'ref-2','10.00','succeeded',$2)",
      [orderId, transaction.rows[0]!.transaction_id],
    ),
    "23505",
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO payment_transaction(order_id, provider, amount, idempotency_key) VALUES($1,'manual','10.00','key-1')",
      [orderId],
    ),
    "23505",
  );
});

test("only one default address and one default payment method per customer", async () => {
  await ctx.db.query(
    `INSERT INTO address(customer_id, address_line1, city, country_id, is_default) VALUES($1,'A','Nairobi',1,true)`,
    [customerId],
  );
  await expectDbError(
    ctx.db.query(
      `INSERT INTO address(customer_id, address_line1, city, country_id, is_default) VALUES($1,'B','Nairobi',1,true)`,
      [customerId],
    ),
    "23505",
  );
  await ctx.db.query(
    `INSERT INTO payment_method(customer_id, payment_type_id, provider, provider_token, is_default) VALUES($1,1,'stripe','tok_1',true)`,
    [customerId],
  );
  await expectDbError(
    ctx.db.query(
      `INSERT INTO payment_method(customer_id, payment_type_id, provider, provider_token, is_default) VALUES($1,1,'stripe','tok_2',true)`,
      [customerId],
    ),
    "23505",
  );
});

test("ERP mappings are unique in both directions", async () => {
  await ctx.db.query(
    `INSERT INTO erp_entity_map(entity_type, local_id, erp_id) VALUES('product','1','erp-1')`,
  );
  await expectDbError(
    ctx.db.query(
      `INSERT INTO erp_entity_map(entity_type, local_id, erp_id) VALUES('product','1','erp-2')`,
    ),
    "23505",
  );
  await expectDbError(
    ctx.db.query(
      `INSERT INTO erp_entity_map(entity_type, local_id, erp_id) VALUES('product','2','erp-1')`,
    ),
    "23505",
  );
});

test("promotion windows and discount types are constrained", async () => {
  await expectDbError(
    ctx.db.query(
      `INSERT INTO promotion(promotion_name, discount_type, discount_value, start_date, end_date)
       VALUES('Bad window','percentage',10, now(), now() - interval '1 day')`,
    ),
    "23514",
  );
  await expectDbError(
    ctx.db.query(
      `INSERT INTO promotion(promotion_name, discount_type, discount_value, start_date, end_date)
       VALUES('Bad type','bogus',10, now(), now() + interval '1 day')`,
    ),
    "23514",
  );
});

test("idempotency records are unique per scope and key", async () => {
  const hash = "a".repeat(64);
  await ctx.db.query(
    "INSERT INTO idempotency_key(scope, key, request_hash) VALUES('scope','key',$1)",
    [hash],
  );
  await expectDbError(
    ctx.db.query(
      "INSERT INTO idempotency_key(scope, key, request_hash) VALUES('scope','key',$1)",
      [hash],
    ),
    "23505",
  );
});
