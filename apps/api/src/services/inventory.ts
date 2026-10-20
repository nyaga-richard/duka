import { D, money, qty, sum } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  warehouseAccess,
  audit,
  nextNumber,
  accountingDate,
  uniqueIds,
  type Context,
  pageArgs,
} from "../db.ts";
import { lockStock, moveStock } from "@duka/inventory";
import { postJournal } from "@duka/accounting";
export async function postStockDocument(ctx: Context, input: any) {
  requirePermission(
    ctx,
    input.type === "transfer"
      ? "inventory.transfer"
      : input.type === "count"
        ? "inventory.count"
        : "inventory.write",
  );
  const warehouse = await warehouseAccess(ctx, input.warehouse_id),
    dest = input.destination_id
      ? await warehouseAccess(ctx, input.destination_id)
      : null;
  if (input.type === "transfer" && (!dest || dest.id === warehouse.id))
    fail(
      422,
      "TRANSFER_DESTINATION",
      "Select a different destination warehouse",
    );
  if (input.type !== "transfer" && dest)
    fail(
      422,
      "UNEXPECTED_DESTINATION",
      "A destination is only valid for transfers",
    );
  uniqueIds(
    input.lines.map(
      (l: any) => `${l.product_id}:${l.batch_id ?? l.batch_number ?? ""}`,
    ),
  );
  const date = await accountingDate(ctx, input.accounting_date),
    id = randomUUID(),
    number = await nextNumber(
      ctx,
      input.type === "transfer"
        ? "TRF"
        : input.type === "count"
          ? "CNT"
          : "ADJ",
    );
  await lockStock(
    ctx,
    input.lines.flatMap((l: any) => [
      { productId: l.product_id, warehouseId: warehouse.id },
      ...(dest ? [{ productId: l.product_id, warehouseId: dest.id }] : []),
    ]),
  );
  await ctx.db.query(
    "INSERT INTO stock_documents(id,company_id,branch_id,warehouse_id,destination_id,type,number,reason,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      id,
      ctx.companyId,
      warehouse.branch_id,
      warehouse.id,
      dest?.id ?? null,
      input.type,
      number,
      input.reason,
      ctx.actor.id,
      date,
    ],
  );
  const results: any[] = [];
  let value = D(0);
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const p = await one(
      ctx,
      "SELECT * FROM products WHERE company_id=$1 AND id=$2 AND active",
      [ctx.companyId, l.product_id],
    );
    const b = await one(
      ctx,
      "SELECT * FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE",
      [ctx.companyId, l.product_id, warehouse.id],
    );
    let delta = D(l.quantity);
    if (input.type === "opening") {
      if (delta.lte(0))
        fail(422, "OPENING_QUANTITY", "Opening quantity must be positive");
      const old = await ctx.db.query(
        "SELECT 1 FROM stock_movements WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 LIMIT 1",
        [ctx.companyId, l.product_id, warehouse.id],
      );
      if (old.rowCount)
        fail(
          409,
          "OPENING_EXISTS",
          "Use an adjustment for an item that already has stock history",
        );
    }
    if (input.type === "count") {
      if (p.batch_tracked || p.serial_tracked)
        fail(
          422,
          "TRACKED_COUNT",
          "Tracked items require batch/serial-specific adjustments, not aggregate counts",
        );
      if (
        l.expected_version === undefined ||
        Number(b.version) !== l.expected_version
      )
        fail(
          409,
          "STOCK_COUNT_CONFLICT",
          "Stock changed since this count was started; refresh and recount",
        );
      if (delta.lt(0))
        fail(422, "COUNT_NEGATIVE", "Counted quantity cannot be negative");
      delta = delta.minus(b.quantity);
    }
    if (input.type === "transfer") {
      if (delta.lte(0))
        fail(422, "TRANSFER_QUANTITY", "Transfer quantity must be positive");
      delta = delta.neg();
    }
    let movement: any = null;
    if (!delta.eq(0)) {
      movement = await moveStock(ctx, {
        productId: l.product_id,
        warehouseId: warehouse.id,
        quantity: qty(delta),
        unitCost: l.unit_cost,
        type: input.type === "transfer" ? "transfer_out" : input.type,
        sourceType: "stock_document",
        sourceId: id,
        lineKey: String(i),
        reason: input.reason,
        batchId: l.batch_id,
        batchNumber: l.batch_number,
        expiryDate: l.expiry_date,
        serials: l.serials,
        allowExpired: input.type === "adjustment" && delta.lt(0),
      });
      value = value.plus(movement.value);
      if (dest) {
        let batchNumber: string | undefined, expiryDate: string | undefined;
        if (p.batch_tracked) {
          const batch = await one(
            ctx,
            "SELECT * FROM stock_batches WHERE company_id=$1 AND id=$2",
            [ctx.companyId, movement.batch_id],
          );
          batchNumber = batch.batch_number;
          expiryDate = batch.expiry_date?.toISOString().slice(0, 10);
        }
        await moveStock(ctx, {
          productId: l.product_id,
          warehouseId: dest.id,
          quantity: qty(delta.abs()),
          unitCost: movement.cost,
          exactValue: money(D(movement.value).abs()),
          type: "transfer_in",
          sourceType: "stock_document",
          sourceId: id,
          lineKey: String(i),
          reason: input.reason,
          batchNumber,
          expiryDate,
          serials: l.serials,
        });
      }
    }
    await ctx.db.query(
      "INSERT INTO stock_document_lines(company_id,document_id,product_id,quantity,unit_cost,system_quantity,counted_quantity,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ctx.companyId,
        id,
        l.product_id,
        qty(delta),
        movement?.cost ?? "0",
        b.quantity,
        input.type === "count" ? l.quantity : null,
        movement?.batch_id ?? null,
      ],
    );
    results.push({
      product_id: l.product_id,
      delta: qty(delta),
      value: movement?.value ?? "0.00",
    });
  }
  const amount = money(value.abs());
  if (!value.eq(0)) {
    if (dest && dest.branch_id !== warehouse.branch_id) {
      await postJournal(ctx, {
        branchId: warehouse.branch_id,
        date,
        sourceType: "stock_transfer_out",
        sourceId: id,
        description: `${number} · Transfer out`,
        lines: [
          { account: "interbranch", debit: amount },
          { account: "inventory", credit: amount },
        ],
      });
      await postJournal(ctx, {
        branchId: dest.branch_id,
        date,
        sourceType: "stock_transfer_in",
        sourceId: id,
        description: `${number} · Transfer in`,
        lines: [
          { account: "inventory", debit: amount },
          { account: "interbranch", credit: amount },
        ],
      });
    } else if (!dest) {
      const offset = input.type === "opening" ? "equity" : "stock_loss";
      await postJournal(ctx, {
        branchId: warehouse.branch_id,
        date,
        sourceType: "stock_document",
        sourceId: id,
        description: `${number} · ${input.reason}`,
        lines: value.gt(0)
          ? [
              { account: "inventory", debit: amount },
              { account: offset, credit: amount },
            ]
          : [
              { account: offset, debit: amount },
              { account: "inventory", credit: amount },
            ],
      });
    }
  }
  await audit(
    ctx,
    "post",
    "stock_document",
    id,
    null,
    { number, type: input.type, lines: results },
    input.reason,
  );
  return { id, number, type: input.type, value: money(value), lines: results };
}
export async function inventoryBalances(ctx: Context, q: any) {
  requirePermission(ctx, "inventory.read");
  const { page, limit, offset } = pageArgs(q),
    warehouses = q.warehouse_id ? [q.warehouse_id] : ctx.actor.warehouse_ids;
  if (q.warehouse_id) await warehouseAccess(ctx, q.warehouse_id);
  const r = await ctx.db.query(
    `SELECT b.*,p.name,p.sku,p.reorder_level,p.max_stock,u.symbol AS unit,w.name AS warehouse,CASE WHEN b.quantity>0 THEN b.value/b.quantity ELSE 0 END::numeric(24,6)::text AS average_cost,(b.quantity-b.reserved)::text AS available,count(*) OVER()::int AS _count FROM stock_balances b JOIN products p ON p.company_id=b.company_id AND p.id=b.product_id JOIN units u ON u.company_id=p.company_id AND u.id=p.unit_id JOIN warehouses w ON w.company_id=b.company_id AND w.id=b.warehouse_id WHERE b.company_id=$1 AND b.warehouse_id=ANY($2::uuid[]) AND (p.name ILIKE $3 OR p.sku ILIKE $3) AND ($4::boolean=false OR b.quantity<=p.reorder_level) ORDER BY p.name,w.name LIMIT $5 OFFSET $6`,
    [
      ctx.companyId,
      warehouses,
      `%${String(q.q ?? "").slice(0, 120)}%`,
      q.low === "true",
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function stockLedger(ctx: Context, q: any) {
  requirePermission(ctx, "inventory.read");
  const { page, limit, offset } = pageArgs(q),
    ws = q.warehouse_id ? [q.warehouse_id] : ctx.actor.warehouse_ids;
  if (q.warehouse_id) await warehouseAccess(ctx, q.warehouse_id);
  const r = await ctx.db.query(
    `SELECT m.*,p.name,p.sku,w.name AS warehouse,u.name AS actor,count(*) OVER()::int AS _count FROM stock_movements m JOIN products p ON p.company_id=m.company_id AND p.id=m.product_id JOIN warehouses w ON w.company_id=m.company_id AND w.id=m.warehouse_id JOIN identities u ON u.company_id=m.company_id AND u.id=m.actor_id WHERE m.company_id=$1 AND m.warehouse_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR m.product_id=$3) AND ($4::date IS NULL OR m.created_at >=$4::date) AND ($5::date IS NULL OR m.created_at <$5::date+interval '1 day') ORDER BY m.created_at DESC,m.id LIMIT $6 OFFSET $7`,
    [
      ctx.companyId,
      ws,
      q.product_id ?? null,
      q.from ?? null,
      q.to ?? null,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function reconcileInventory(ctx: Context) {
  requirePermission(ctx, "accounting.read");
  const missing = await ctx.db.query(
    "SELECT id FROM warehouses WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND NOT(id=ANY($3::uuid[])) LIMIT 1",
    [ctx.companyId, ctx.actor.branch_ids, ctx.actor.warehouse_ids],
  );
  if (missing.rowCount)
    fail(
      403,
      "COMPLETE_WAREHOUSE_SCOPE_REQUIRED",
      "Inventory/GL reconciliation requires all warehouses in each selected branch. Ask an authorized all-location accountant.",
    );
  const stock = await ctx.db.query(
    `WITH ledger AS(SELECT company_id,product_id,warehouse_id,sum(quantity) AS quantity,sum(value) AS value FROM stock_movements WHERE company_id=$1 AND warehouse_id=ANY($2::uuid[]) GROUP BY company_id,product_id,warehouse_id)
   SELECT coalesce(b.product_id,m.product_id) AS product_id,coalesce(b.warehouse_id,m.warehouse_id) AS warehouse_id,coalesce(b.quantity,0)::text AS quantity,coalesce(b.value,0)::text AS value,coalesce(m.quantity,0)::text AS ledger_quantity,coalesce(m.value,0)::text AS ledger_value FROM stock_balances b FULL JOIN ledger m ON b.company_id=m.company_id AND b.product_id=m.product_id AND b.warehouse_id=m.warehouse_id WHERE coalesce(b.company_id,m.company_id)=$1 AND coalesce(b.warehouse_id,m.warehouse_id)=ANY($2::uuid[]) AND (coalesce(b.quantity,0)<>coalesce(m.quantity,0) OR coalesce(b.value,0)<>coalesce(m.value,0))`,
    [ctx.companyId, ctx.actor.warehouse_ids],
  );
  const value = (
    await ctx.db.query(
      "SELECT coalesce(sum(value),0)::text AS n FROM stock_balances WHERE company_id=$1 AND warehouse_id=ANY($2::uuid[])",
      [ctx.companyId, ctx.actor.warehouse_ids],
    )
  ).rows[0].n;
  const ledger = (
    await ctx.db.query(
      "SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND a.system_key='inventory' AND j.branch_id=ANY($2::uuid[])",
      [ctx.companyId, ctx.actor.branch_ids],
    )
  ).rows[0].n;
  return {
    movement_discrepancies: stock.rows,
    stock_value: money(value),
    inventory_gl: money(ledger),
    difference: money(D(value).minus(ledger)),
    matches: stock.rowCount === 0 && D(value).eq(ledger),
  };
}
