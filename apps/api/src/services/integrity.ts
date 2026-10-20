import { D, money } from "@duka/shared";
import {
  one,
  requirePermission,
  requireAllBranches,
  type Context,
} from "../db.ts";
import { reconcileInventory } from "./inventory.ts";
export async function verifyIntegrity(ctx: Context) {
  requirePermission(ctx, "accounting.read");
  await requireAllBranches(ctx);
  const inventory = await reconcileInventory(ctx);
  const actual = (
    await ctx.db.query(
      "SELECT a.system_key,coalesce(sum(l.debit-l.credit),0)::text AS amount FROM accounts a LEFT JOIN journal_lines l ON l.company_id=a.company_id AND l.account_id=a.id WHERE a.company_id=$1 GROUP BY a.id",
      [ctx.companyId],
    )
  ).rows;
  const balances = Object.fromEntries(
    actual.map((r) => [r.system_key, r.amount]),
  );
  balances.posted_expense_net = (
    await one(
      ctx,
      "SELECT coalesce(sum(l.debit-l.credit),0)::text AS amount FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND j.source_type IN ('expense','expense_refund','expense_void','expense_reclassification') AND a.type='expense'",
      [ctx.companyId],
    )
  ).amount;
  const expected = await one(
    ctx,
    `SELECT
 ((SELECT coalesce(sum(s.total-s.paid_at_sale-coalesce((SELECT sum(a.amount) FROM customer_allocations a WHERE a.company_id=s.company_id AND a.sale_id=s.id),0)-coalesce((SELECT sum(r.credit_applied) FROM sale_returns r WHERE r.company_id=s.company_id AND r.sale_id=s.id),0)),0) FROM sales s WHERE s.company_id=$1)+(SELECT coalesce(sum(opening_item_balance(i.company_id,i.id)),0) FROM opening_items i WHERE i.company_id=$1 AND i.kind='customer' AND i.direction='debt'))::text AS ar,
 ((SELECT coalesce(sum(supplier_invoice_balance(i.company_id,i.id)),0) FROM supplier_invoices i WHERE i.company_id=$1)+(SELECT coalesce(sum(opening_item_balance(i.company_id,i.id)),0) FROM opening_items i WHERE i.company_id=$1 AND i.kind='supplier' AND i.direction='debt'))::text AS ap,
 (SELECT coalesce(sum(c.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0)),0) FROM advance_credits c WHERE c.company_id=$1 AND c.customer_id IS NOT NULL)::text AS customer_advances,
 (SELECT coalesce(sum(c.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0)),0) FROM advance_credits c WHERE c.company_id=$1 AND c.supplier_id IS NOT NULL)::text AS supplier_advances,
 (SELECT coalesce(sum(g.value),0) FROM goods_receipts g WHERE g.company_id=$1 AND NOT EXISTS(SELECT 1 FROM supplier_invoices i WHERE i.company_id=g.company_id AND i.receipt_id=g.id))::text AS grni,
 (SELECT coalesce(sum(r.amount),0) FROM refund_requests r WHERE r.company_id=$1 AND r.status<>'settled')::text AS refund_payable,
 ((SELECT coalesce(sum(net),0) FROM expenses WHERE company_id=$1 AND status='posted')-(SELECT coalesce(sum(CASE WHEN kind='refund' THEN net ELSE -net END),0) FROM expense_refunds WHERE company_id=$1))::text AS posted_expense_net`,
    [ctx.companyId],
  );
  const credits = new Set([
    "ap",
    "customer_advances",
    "grni",
    "refund_payable",
    "accumulated_depreciation",
  ]);
  const controls = Object.entries(expected).map(([account, value]) => {
    const gl = D(balances[account] ?? 0).times(credits.has(account) ? -1 : 1);
    return {
      account,
      subledger: money(value as string),
      general_ledger: money(gl),
      difference: money(D(value as string).minus(gl)),
      matches: gl.eq(value as string),
    };
  });
  const unbalanced = (
    await ctx.db.query(
      `SELECT j.id,j.number,coalesce(sum(l.debit),0)::text AS debit,coalesce(sum(l.credit),0)::text AS credit FROM journals j LEFT JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_id=j.id WHERE j.company_id=$1 GROUP BY j.id HAVING count(l.id)<2 OR coalesce(sum(l.debit),0)<>coalesce(sum(l.credit),0) OR coalesce(sum(l.debit),0)<=0 LIMIT 50`,
      [ctx.companyId],
    )
  ).rows;
  const tracking = (
    await ctx.db.query(
      `SELECT b.product_id,b.warehouse_id,b.quantity::text,p.batch_tracked,p.serial_tracked,
 coalesce((SELECT sum(quantity) FROM stock_batches t WHERE t.company_id=b.company_id AND t.product_id=b.product_id AND t.warehouse_id=b.warehouse_id),0)::text AS batch_quantity,
 (SELECT count(*) FROM serial_numbers n WHERE n.company_id=b.company_id AND n.product_id=b.product_id AND n.warehouse_id=b.warehouse_id AND n.status='available')::text AS available_serials
 FROM stock_balances b JOIN products p ON p.company_id=b.company_id AND p.id=b.product_id WHERE b.company_id=$1 AND ((p.batch_tracked AND b.quantity<>coalesce((SELECT sum(quantity) FROM stock_batches t WHERE t.company_id=b.company_id AND t.product_id=b.product_id AND t.warehouse_id=b.warehouse_id),0)) OR (p.serial_tracked AND b.quantity<>(SELECT count(*) FROM serial_numbers n WHERE n.company_id=b.company_id AND n.product_id=b.product_id AND n.warehouse_id=b.warehouse_id AND n.status='available'))) LIMIT 50`,
      [ctx.companyId],
    )
  ).rows;
  const missing = (
    await ctx.db.query(
      `SELECT 'sale' AS source_type,s.id,s.number FROM sales s WHERE s.company_id=$1 AND (s.total>0 OR s.cost>0) AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=s.company_id AND j.source_type='sale' AND j.source_id=s.id)
 UNION ALL SELECT 'goods_receipt',g.id,g.number FROM goods_receipts g WHERE g.company_id=$1 AND g.value>0 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=g.company_id AND j.source_type='goods_receipt' AND j.source_id=g.id)
 UNION ALL SELECT 'supplier_invoice',i.id,i.number FROM supplier_invoices i WHERE i.company_id=$1 AND i.total>0 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=i.company_id AND j.source_type='supplier_invoice' AND j.source_id=i.id)
 UNION ALL SELECT 'supplier_credit_settlement',c.id,c.number FROM supplier_credit_settlements c WHERE c.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=c.company_id AND j.source_type='supplier_credit_settlement' AND j.source_id=c.id)
 UNION ALL SELECT 'opening_balance',b.id,b.number FROM opening_batches b WHERE b.company_id=$1 AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=b.company_id AND j.source_type='opening_balance' AND j.source_id=b.id)
 UNION ALL SELECT 'opening_balance_reversal',r.id,r.number FROM opening_batch_reversals r WHERE r.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=r.company_id AND j.source_type='opening_balance_reversal' AND j.source_id=r.id)
 UNION ALL SELECT 'fixed_asset',a.id,a.name FROM fixed_assets a WHERE a.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=a.company_id AND j.source_type=(CASE WHEN a.funding='payment' THEN 'asset_acquisition' ELSE 'asset_opening' END) AND j.source_id=a.id)
 UNION ALL SELECT 'depreciation_run',d.id,d.month::text FROM depreciation_runs d WHERE d.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=d.company_id AND j.source_type='depreciation' AND j.source_id=d.id)
 UNION ALL SELECT 'asset_disposal',s.id,s.number FROM asset_disposals s WHERE s.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=s.company_id AND j.source_type='asset_disposal' AND j.source_id=s.id)
 UNION ALL SELECT 'expense_void',v.id,v.number FROM expense_voids v WHERE v.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=v.company_id AND j.source_type='expense_void' AND j.source_id=v.id)
 UNION ALL SELECT 'expense_reclassification',r.id,r.number FROM expense_reclassifications r WHERE r.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=r.company_id AND j.source_type='expense_reclassification' AND j.source_id=r.id)
 UNION ALL SELECT 'expense_refund',r.id,r.number FROM expense_refunds r WHERE r.company_id=$1 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=r.company_id AND j.source_type='expense_refund' AND j.source_id=r.id)
 UNION ALL SELECT 'expense',e.id,e.number FROM expenses e WHERE e.company_id=$1 AND e.status='posted' AND e.total>0 AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.company_id=e.company_id AND j.source_type='expense' AND j.source_id=e.id) LIMIT 50`,
      [ctx.companyId],
    )
  ).rows;
  return {
    company_id: ctx.companyId,
    matches:
      inventory.matches &&
      controls.every((c) => c.matches) &&
      !unbalanced.length &&
      !tracking.length &&
      !missing.length,
    inventory,
    controls,
    unbalanced_journals: unbalanced,
    tracking_discrepancies: tracking,
    missing_journals: missing,
  };
}
