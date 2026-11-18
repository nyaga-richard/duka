import test from "node:test";
import assert from "node:assert/strict";
import {
  ERP_CAPABILITIES,
  MISSING_CAPABILITIES,
  VERIFIED_CAPABILITIES,
  ErpAdapter,
  ErpError,
  erpIdempotencyKey,
} from "@ecom/erp-adapter";

test("every capability is documented with evidence and a unique id", () => {
  const ids = new Set<string>();
  for (const capability of ERP_CAPABILITIES) {
    assert.ok(capability.id.length > 2, "capability id");
    assert.ok(!ids.has(capability.id), `duplicate capability ${capability.id}`);
    ids.add(capability.id);
    assert.ok(capability.endpoint.startsWith("/"), "endpoint path");
    assert.ok(capability.evidence.length > 10, `evidence for ${capability.id}`);
    if (capability.support === "unsupported") {
      assert.match(
        capability.contract ?? "",
        /^G\d+$/,
        `contract reference for ${capability.id}`,
      );
    } else {
      assert.equal(
        capability.contract,
        undefined,
        `verified capability ${capability.id} must not cite a missing contract`,
      );
    }
  }
});

test("verified and missing capabilities are both non-empty (inspection found real gaps)", () => {
  assert.ok(VERIFIED_CAPABILITIES.length >= 12);
  assert.ok(MISSING_CAPABILITIES.length >= 10);
  assert.ok(MISSING_CAPABILITIES.some((c) => c.id === "inventory.reserve"));
  assert.ok(MISSING_CAPABILITIES.some((c) => c.id === "orders.channel"));
  assert.ok(MISSING_CAPABILITIES.some((c) => c.id === "events.subscribe"));
});

test("adapter refuses unsupported capabilities instead of faking success", async () => {
  const adapter = new ErpAdapter({
    async request() {
      throw new Error("must not call the ERP for unsupported capabilities");
    },
    async health() {
      return { ok: true, live: true, ready: true };
    },
  } as any);

  for (const method of [
    "reserveInventory",
    "createChannelOrder",
    "postPaymentByReference",
    "createRefundByReference",
    "createShipment",
    "subscribeEvents",
  ] as const) {
    await assert.rejects(
      () => (adapter as any)[method](),
      (error: any) =>
        error instanceof ErpError && error.code === "ERP_CONTRACT_UNSUPPORTED",
      method,
    );
  }
});

test("ERP idempotency keys are deterministic and safe", () => {
  assert.equal(erpIdempotencyKey("order", 42), "ecommerce:order:42");
  assert.equal(erpIdempotencyKey("order", 42), erpIdempotencyKey("order", 42));
  assert.match(
    erpIdempotencyKey("customer", "a/b c"),
    /^ecommerce:customer:a-b-c$/,
  );
  assert.ok(erpIdempotencyKey("x", "y".repeat(500)).length <= 150);
});
