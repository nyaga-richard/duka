import { D, money, qty } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  warehouseAccess,
  type Context,
} from "../../../apps/api/src/db.ts";
export function weightedReceipt(
  oldQuantity: string,
  oldValue: string,
  incoming: string,
  unitCost: string,
) {
  const q = D(oldQuantity).plus(incoming),
    value = D(oldValue).plus(money(D(incoming).times(unitCost)));
  if (D(incoming).lte(0) || D(unitCost).lt(0))
    throw new Error("Invalid receipt");
  return {
    quantity: qty(q),
    value: money(value),
    average: q.gt(0) ? qty(value.div(q)) : "0.000000",
  };
}
export function weightedIssue(
  oldQuantity: string,
  oldValue: string,
  outgoing: string,
  reserved = "0",
) {
  const q = D(oldQuantity),
    out = D(outgoing);
  if (out.lte(0) || out.gt(q.minus(reserved)))
    throw new Error("Insufficient available stock");
  const value = out.eq(q)
    ? D(oldValue)
    : D(money(D(oldValue).times(out).div(q)));
  return {
    quantity: qty(q.minus(out)),
    value: money(D(oldValue).minus(value)),
    issuedValue: money(value),
    unitCost: qty(value.div(out)),
  };
}
export async function lockStock(
  ctx: Context,
  pairs: { productId: string; warehouseId: string }[],
) {
  const sorted = [
    ...new Map(
      pairs.map((p) => [`${p.productId}:${p.warehouseId}`, p]),
    ).values(),
  ].sort((a, b) =>
    `${a.productId}:${a.warehouseId}`.localeCompare(
      `${b.productId}:${b.warehouseId}`,
    ),
  );
  for (const p of sorted) {
    await ctx.db.query(
      "INSERT INTO stock_balances(company_id,product_id,warehouse_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [ctx.companyId, p.productId, p.warehouseId],
    );
    await ctx.db.query(
      "SELECT product_id FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE",
      [ctx.companyId, p.productId, p.warehouseId],
    );
  }
}
export interface MovementInput {
  productId: string;
  warehouseId: string;
  quantity: string;
  unitCost?: string;
  type: string;
  sourceType: string;
  sourceId: string;
  lineKey: string;
  reason: string;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: string;
  serials?: string[];
  reversalOf?: string;
  allowExpired?: boolean;
  exactValue?: string;
}
export async function moveStock(ctx: Context, input: MovementInput) {
  await warehouseAccess(ctx, input.warehouseId);
  const product = await one(
    ctx,
    "SELECT p.*,u.fractional FROM products p JOIN units u ON u.company_id=p.company_id AND u.id=p.unit_id WHERE p.company_id=$1 AND p.id=$2",
    [ctx.companyId, input.productId],
  );
  if (product.kind !== "stock")
    fail(422, "NOT_STOCK_ITEM", "Only physical stock can have movements");
  const delta = D(input.quantity);
  if (delta.eq(0))
    fail(422, "ZERO_MOVEMENT", "Stock movement quantity cannot be zero");
  if (!product.fractional && !delta.isInteger())
    fail(
      422,
      "WHOLE_QUANTITY_REQUIRED",
      "The base unit does not permit fractional quantities",
    );
  await lockStock(ctx, [
    { productId: input.productId, warehouseId: input.warehouseId },
  ]);
  const balance = await one(
    ctx,
    "SELECT * FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE",
    [ctx.companyId, input.productId, input.warehouseId],
  );
  const chronology = (
    await ctx.db.query(
      "SELECT coalesce(nullif(current_setting('app.accounting_date',true),''),CURRENT_DATE::text)::date < max(accounting_date) AS invalid FROM stock_movements WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3",
      [ctx.companyId, input.productId, input.warehouseId],
    )
  ).rows[0];
  if (chronology.invalid)
    fail(
      409,
      "STOCK_DATE_ORDER",
      "A weighted-average stock movement cannot be backdated before the latest movement for this item/location",
    );
  let nextQuantity: string, nextValue: string, value: string, unitCost: string;
  if (delta.gt(0)) {
    const v =
      input.exactValue !== undefined
        ? money(input.exactValue)
        : money(delta.times(input.unitCost ?? product.purchase_cost));
    if (D(v).lt(0)) fail(422, "INVALID_COST", "Stock value cannot be negative");
    nextQuantity = qty(D(balance.quantity).plus(delta));
    nextValue = money(D(balance.value).plus(v));
    value = v;
    unitCost = qty(D(v).div(delta));
  } else {
    try {
      const n = weightedIssue(
        balance.quantity,
        balance.value,
        delta.abs().toString(),
        balance.reserved,
      );
      nextQuantity = n.quantity;
      nextValue = n.value;
      value = money(D(n.issuedValue).neg());
      unitCost = n.unitCost;
    } catch {
      fail(
        409,
        "INSUFFICIENT_STOCK",
        `Insufficient available stock for ${product.name}`,
        {
          available: qty(D(balance.quantity).minus(balance.reserved)),
          requested: qty(delta.abs()),
        },
      );
    }
  }
  let batchId = input.batchId ?? null;
  if (product.batch_tracked) {
    if (delta.gt(0) && !batchId) {
      if (!input.batchNumber)
        fail(
          422,
          "BATCH_REQUIRED",
          `A batch number is required for ${product.name}`,
        );
      if (product.expiry_tracked && !input.expiryDate)
        fail(
          422,
          "EXPIRY_REQUIRED",
          `Expiry date required for ${product.name}`,
        );
      const b = await ctx.db.query(
        "INSERT INTO stock_batches(company_id,product_id,warehouse_id,batch_number,expiry_date) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,product_id,warehouse_id,batch_number) DO UPDATE SET batch_number=EXCLUDED.batch_number RETURNING *",
        [
          ctx.companyId,
          input.productId,
          input.warehouseId,
          input.batchNumber,
          input.expiryDate ?? null,
        ],
      );
      batchId = b.rows[0].id;
      if (
        input.expiryDate &&
        String(
          b.rows[0].expiry_date?.toISOString?.().slice(0, 10) ??
            b.rows[0].expiry_date,
        ) !== input.expiryDate
      )
        fail(
          409,
          "BATCH_EXPIRY_CONFLICT",
          "Batch already exists with a different expiry date",
        );
    }
    if (!batchId)
      fail(422, "BATCH_REQUIRED", `Select a batch for ${product.name}`);
    const batch = await one(
      ctx,
      "SELECT * FROM stock_batches WHERE company_id=$1 AND id=$2 AND product_id=$3 AND warehouse_id=$4 FOR UPDATE",
      [ctx.companyId, batchId, input.productId, input.warehouseId],
    );
    if (delta.lt(0) && !input.allowExpired && batch.expiry_date) {
      const expired = (
        await ctx.db.query("SELECT $1::date<CURRENT_DATE AS expired", [
          batch.expiry_date,
        ])
      ).rows[0].expired;
      if (expired)
        fail(
          409,
          "EXPIRED_BATCH",
          "Expired stock cannot be sold or transferred as usable goods",
        );
    }
    if (D(batch.quantity).plus(delta).lt(0))
      fail(
        409,
        "INSUFFICIENT_BATCH",
        "Insufficient quantity in selected batch",
      );
    await ctx.db.query(
      "UPDATE stock_batches SET quantity=quantity+$1 WHERE company_id=$2 AND id=$3",
      [qty(delta), ctx.companyId, batchId],
    );
  } else if (batchId || input.batchNumber)
    fail(422, "UNEXPECTED_BATCH", "This product does not use batch tracking");
  const serials = input.serials ?? [];
  if (product.serial_tracked) {
    if (
      !delta.abs().isInteger() ||
      !delta.abs().eq(serials.length) ||
      new Set(serials).size !== serials.length
    )
      fail(
        422,
        "SERIALS_REQUIRED",
        "Supply one distinct serial number per base unit",
      );
    for (const serial of [...serials].sort()) {
      if (delta.lt(0)) {
        const r = await ctx.db.query(
          "UPDATE serial_numbers SET status=$1 WHERE company_id=$2 AND product_id=$3 AND warehouse_id=$4 AND serial=$5 AND status='available' AND batch_id IS NOT DISTINCT FROM $6::uuid RETURNING id",
          [
            input.type === "damage" ? "damaged" : "sold",
            ctx.companyId,
            input.productId,
            input.warehouseId,
            serial,
            batchId,
          ],
        );
        if (!r.rowCount)
          fail(409, "SERIAL_UNAVAILABLE", `Serial ${serial} is unavailable`);
      } else if (["sale_return", "transfer_in"].includes(input.type)) {
        const r = await ctx.db.query(
          "UPDATE serial_numbers SET status='available',warehouse_id=$1,batch_id=$5 WHERE company_id=$2 AND product_id=$3 AND serial=$4 AND status IN ('sold','damaged') AND ($6::boolean OR (warehouse_id=$1 AND batch_id IS NOT DISTINCT FROM $5::uuid)) RETURNING id",
          [
            input.warehouseId,
            ctx.companyId,
            input.productId,
            serial,
            batchId,
            input.type === "transfer_in",
          ],
        );
        if (!r.rowCount)
          fail(
            409,
            "SERIAL_RETURN_CONFLICT",
            `Serial ${serial} is not returnable`,
          );
      } else
        await ctx.db.query(
          "INSERT INTO serial_numbers(company_id,product_id,warehouse_id,serial,status,batch_id) VALUES($1,$2,$3,$4,'available',$5)",
          [ctx.companyId, input.productId, input.warehouseId, serial, batchId],
        );
    }
  } else if (serials.length)
    fail(
      422,
      "UNEXPECTED_SERIALS",
      "This product does not use serial tracking",
    );
  await ctx.db.query(
    "UPDATE stock_balances SET quantity=$1,value=$2,version=version+1 WHERE company_id=$3 AND product_id=$4 AND warehouse_id=$5",
    [
      nextQuantity!,
      nextValue!,
      ctx.companyId,
      input.productId,
      input.warehouseId,
    ],
  );
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO stock_movements(id,company_id,product_id,warehouse_id,quantity,value,cost,type,source_type,source_id,line_key,actor_id,reason,batch_id,serials,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    [
      id,
      ctx.companyId,
      input.productId,
      input.warehouseId,
      qty(delta),
      value!,
      unitCost!,
      input.type,
      input.sourceType,
      input.sourceId,
      input.lineKey,
      ctx.actor.id,
      input.reason,
      batchId,
      JSON.stringify(serials),
      input.reversalOf ?? null,
    ],
  );
  return {
    id,
    value: value!,
    cost: unitCost!,
    batch_id: batchId,
    quantity: nextQuantity!,
    balance_value: nextValue!,
  };
}
