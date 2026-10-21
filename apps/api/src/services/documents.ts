import { getOpeningBatch } from "./opening-balances.ts";
import PDFDocument from "pdfkit";
import { money, D } from "@duka/shared";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  audit,
  type Context,
} from "../db.ts";
import { getSale } from "./sales.ts";
import { getPurchaseOrder, getGoodsReceipt } from "./procurement.ts";
import {
  contactStatement,
  trialBalance,
  reportScope,
  profitAndLoss,
  balanceSheet,
} from "./reports.ts";
function renderPdf(input: {
  company: any;
  title: string;
  number: string;
  date?: string;
  lines: any[];
  totals?: Record<string, string>;
  notes?: string;
  thermal?: boolean;
  footer?: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const thermal = input.thermal;
    const width = input.company.settings?.receiptWidth === 58 ? 164 : 227;
    const doc = new PDFDocument({
      size: thermal
        ? [width, Math.max(450, 260 + input.lines.length * 45)]
        : "A4",
      margin: thermal ? 12 : 45,
      info: {
        Title: `${input.title} ${input.number}`,
        Author: input.company.name,
      },
    });
    const buffers: Buffer[] = [];
    doc.on("data", (b) => buffers.push(b));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const m = doc.page.margins.left;
    const cur = input.company.currency.trim();
    const brand = "#153e35",
      muted = "#5d6f67",
      rule = "#d8dcd4";
    const hr = (weight = 0.8, color = rule) => {
      const y = doc.y;
      doc
        .moveTo(m, y)
        .lineTo(m + w, y)
        .lineWidth(weight)
        .strokeColor(color)
        .stroke()
        .moveDown(0.35);
    };
    // ---- header -------------------------------------------------------------
    if (!thermal)
      doc.rect(0, 0, doc.page.width, 6).fillColor(brand).fill();
    doc
      .fillColor(brand)
      .font("Helvetica-Bold")
      .fontSize(thermal ? 15 : 20)
      .text(input.company.name, { align: thermal ? "center" : "left" });
    doc.fillColor(muted).font("Helvetica").fontSize(thermal ? 8 : 9.5);
    if (input.company.address)
      doc.text(input.company.address, { align: thermal ? "center" : "left" });
    if (input.company.phone)
      doc.text(`Tel: ${input.company.phone}`, {
        align: thermal ? "center" : "left",
      });
    if (input.company.tax_pin)
      doc.text(`Tax PIN: ${input.company.tax_pin}`, {
        align: thermal ? "center" : "left",
      });
    doc.moveDown(0.5);
    if (!thermal) hr(1.4, brand);
    // ---- title + document identity block -----------------------------------
    const titleY = doc.y;
    doc
      .fillColor(brand)
      .font("Helvetica-Bold")
      .fontSize(thermal ? 11 : 15)
      .text(input.title, m, titleY, { width: w * 0.62 });
    doc
      .font("Helvetica")
      .fontSize(thermal ? 8 : 9.5)
      .fillColor("#263b33")
      .text(input.number, m + w * 0.62, titleY + 2, {
        width: w * 0.38,
        align: "right",
      });
    if (input.date)
      doc
        .fillColor(muted)
        .fontSize(thermal ? 8 : 9)
        .text(input.date, m + w * 0.62, doc.y + 1, {
          width: w * 0.38,
          align: "right",
        });
    doc.y = Math.max(doc.y, titleY + (thermal ? 18 : 26));
    hr();
    // ---- itemized lines ------------------------------------------------------
    const hasMoney = input.lines.some(
      (l) =>
        (l.total ?? l.amount ?? l.value ?? l.revenue ?? l.balance) !==
        undefined,
    );
    const amountX = m + w * 0.76,
      amountW = w * 0.24;
    if (hasMoney && !thermal) {
      doc
        .fillColor(muted)
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .text("ITEM", m, doc.y, { width: w * 0.52 });
      const hy = doc.y - doc.currentLineHeight();
      doc.text("AMOUNT", amountX, hy, { width: amountW, align: "right" });
      doc.moveDown(0.1);
      hr(0.6);
    }
    input.lines.forEach((l, idx) => {
      if (doc.y > doc.page.height - 130 && !thermal) {
        doc.addPage();
        hr(0.6);
      }
      const linesMeta = [
        l.sku,
        l.quantity !== undefined
          ? `Qty ${l.quantity}${l.unit ? " " + l.unit : ""}`
          : null,
        l.unit_price !== undefined
          ? `@ ${money(l.unit_price)}`
          : l.unit_cost !== undefined
            ? `@ ${money(l.unit_cost)}`
            : null,
        l.debit !== undefined ? `Dr ${l.debit} / Cr ${l.credit}` : null,
      ]
        .filter(Boolean)
        .join("   ·   ");
      const ly = doc.y;
      doc
        .fillColor("#1c2f28")
        .font("Helvetica-Bold")
        .fontSize(thermal ? 9 : 10)
        .text(
          String(l.name ?? l.description ?? l.account ?? l.code ?? "Item"),
          m,
          ly,
          { width: amountX - m - 12 },
        );
      const value = l.total ?? l.amount ?? l.value ?? l.revenue ?? l.balance;
      if (value !== undefined)
        doc
          .fillColor("#1c2f28")
          .fontSize(thermal ? 9 : 10)
          .text(`${cur} ${money(value)}`, amountX, ly, {
            width: amountW,
            align: "right",
          });
      if (linesMeta)
        doc
          .fillColor(muted)
          .font("Helvetica")
          .fontSize(thermal ? 7.5 : 8.5)
          .text(linesMeta, m, doc.y + 2, { width: amountX - m - 12 });
      if (l.tax !== undefined)
        doc
          .fillColor(muted)
          .fontSize(thermal ? 7.5 : 8.5)
          .text(`Incl. tax ${cur} ${money(l.tax)}`, amountX, doc.y + 1, {
            width: amountW,
            align: "right",
          });
      doc.moveDown(0.45);
      if (!thermal && idx < input.lines.length - 1) hr(0.4);
    });
    if (thermal && input.lines.length) hr(0.6);
    doc.moveDown(0.4);
    // ---- totals block ---------------------------------------------------------
    const totals = Object.entries(input.totals ?? {});
    if (totals.length) {
      if (!thermal) hr(1, brand);
      for (const [label, value] of totals) {
        const isTotal = label.toLowerCase() === "total";
        const ly = doc.y;
        doc
          .font(isTotal ? "Helvetica-Bold" : "Helvetica")
          .fontSize(isTotal ? (thermal ? 11 : 13) : thermal ? 9 : 10)
          .fillColor(isTotal ? brand : "#263b33")
          .text(label, thermal ? m + w * 0.3 : m + w * 0.55, ly, {
            width: thermal ? w * 0.3 : w * 0.21,
          });
        doc.text(`${cur} ${money(value)}`, thermal ? m + w * 0.6 : m + w * 0.76, ly, {
          width: thermal ? w * 0.4 : w * 0.24,
          align: "right",
        });
        doc.moveDown(0.15);
      }
    }
    if (input.notes) {
      doc.moveDown(0.4);
      if (!thermal) hr(0.6);
      doc
        .font("Helvetica")
        .fontSize(thermal ? 8 : 9)
        .fillColor(muted)
        .text(input.notes, { width: w });
    }
    doc.moveDown(0.6);
    hr(0.6);
    doc
      .font("Helvetica")
      .fontSize(thermal ? 8 : 9)
      .fillColor(brand)
      .text(input.footer ?? input.company.settings?.receiptFooter ?? "", {
        align: thermal ? "center" : "left",
        width: w,
      });
    if (!thermal)
      doc
        .moveDown(0.3)
        .fontSize(7.5)
        .fillColor(muted)
        .text("Generated by Duka Business OS", { align: "left" });
    if (thermal) {
      doc.moveDown(0.8);
      doc
        .fontSize(8)
        .fillColor(rule)
        .text("- - - - - - - - - - - - - - - - -", { align: "center" });
    }
    doc.end();
  });
}
export async function salePdf(ctx: Context, id: string, thermal: boolean) {
  const s = await getSale(ctx, id, true);
  const confirmed = s.fiscal?.status === "successful";
  const notes = [
    `Payments: ${s.payments.map((p: any) => `${p.method} ${p.amount}${p.reference ? " (" + p.reference + ")" : ""}`).join(", ")}`,
    D(s.customer_credit_used).gt(0)
      ? `Customer account credit: ${s.customer_credit_used}`
      : "",
    confirmed
      ? `Fiscal reference: ${s.fiscal.fiscal_id}`
      : `NOT A KRA FISCAL INVOICE. Fiscal status: ${s.fiscal?.status ?? "not submitted"}.`,
    s.company.settings.returnPolicy ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return renderPdf({
    company: s.company,
    title: thermal ? "Sales receipt" : "Sales invoice",
    number: s.number,
    date: s.accounting_date.toISOString().slice(0, 10),
    lines: s.lines,
    totals: {
      Subtotal: s.subtotal,
      VAT: s.tax,
      Total: s.total,
      "Paid at checkout": s.paid_at_sale,
      Outstanding: s.outstanding,
    },
    notes,
    thermal,
  });
}
export async function businessPdf(ctx: Context, kind: string, id: string) {
  const company = await one(ctx, "SELECT * FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  let doc: any, lines: any[], title: string;
  switch (kind) {
    case "purchase-order":
      doc = await getPurchaseOrder(ctx, id);
      lines = doc.lines;
      title = "Purchase order";
      break;
    case "goods-receipt":
      doc = await getGoodsReceipt(ctx, id);
      lines = doc.lines;
      title = "Goods received note";
      break;
    case "document":
      requirePermission(ctx, "documents.write");
      doc = await one(
        ctx,
        "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2",
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = doc.lines;
      title = doc.kind.replaceAll("_", " ");
      break;
    case "expense":
      requirePermission(ctx, "expenses.read");
      doc = await one(
        ctx,
        "SELECT * FROM expenses WHERE company_id=$1 AND id=$2",
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = [
        { description: doc.description, total: doc.total, tax: doc.tax },
      ];
      title = "Expense voucher";
      break;
    case "opening-balance":
      doc = await getOpeningBatch(ctx, id);
      lines = doc.items.map((i: any) => ({
        description: `${i.direction === "credit" ? (i.kind === "customer" ? "Customer advance" : "Supplier advance") : i.kind === "customer" ? "Receivable" : "Payable"} · ${i.contact} · ${i.reference} · due ${String(i.due_date).slice(0, 10)}`,
        total: i.amount,
      }));
      title = "Opening AR/AP carry-forward (not a new tax invoice)";
      doc.printTotals = {
        "Opening receivables": doc.receivables,
        "Opening payables": doc.payables,
        "Legacy customer advances": doc.customer_credits,
        "Legacy supplier advances": doc.supplier_credits,
        "Net opening equity": money(
          D(doc.receivables)
            .plus(doc.supplier_credits)
            .minus(doc.payables)
            .minus(doc.customer_credits),
        ),
      };
      doc.notes = `State: ${doc.state}. Cutover: ${doc.accounting_date}. Source: ${doc.reference}. No sales, VAT, stock or cash is generated. Legacy credits are allocatable advances, not new fiscal documents. ${doc.notes ?? ""}`;
      break;
    case "expense-refund":
      requirePermission(ctx, "expenses.read");
      doc = await one(
        ctx,
        "SELECT r.*,r.amount AS total,e.number AS expense_number,m.name AS method,p.reference FROM expense_refunds r JOIN expenses e ON e.company_id=r.company_id AND e.id=r.expense_id JOIN payments p ON p.company_id=r.company_id AND p.id=r.payment_id JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE r.company_id=$1 AND r.id=$2",
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = [
        {
          description: `${doc.kind === "refund" ? "Refund received for" : "Refund repaid for"} ${doc.expense_number}`,
          total: doc.amount,
          tax: doc.tax,
        },
      ];
      title =
        doc.kind === "refund"
          ? "Expense refund received"
          : "Expense refund repayment";
      doc.notes = `Original voucher: ${doc.expense_number}. Tender: ${doc.method}. Reference: ${doc.reference ?? "cash drawer"}. ${doc.reason}. This bookkeeping record does not initiate/cancel a bank transfer and is not a KRA fiscal invoice.`;
      break;
    case "customer-receipt":
    case "supplier-payment": {
      const customer = kind === "customer-receipt";
      requirePermission(ctx, customer ? "customers.read" : "suppliers.read");
      doc = await one(
        ctx,
        `SELECT * FROM ${customer ? "customer_receipts" : "supplier_payments"} WHERE company_id=$1 AND id=$2`,
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = (
        await ctx.db.query(
          "SELECT p.*,m.name AS name,p.amount AS total FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.source_id=$2",
          [ctx.companyId, id],
        )
      ).rows;
      title = customer ? "Customer receipt" : "Supplier payment voucher";
      break;
    }
    case "credit-note":
      requirePermission(ctx, "sales.read");
      doc = await one(
        ctx,
        "SELECT * FROM sale_returns WHERE company_id=$1 AND id=$2",
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = (
        await ctx.db.query(
          "SELECT r.*,l.description,(r.net+r.tax)::text AS total FROM sale_return_lines r JOIN sale_lines l ON l.company_id=r.company_id AND l.id=r.sale_line_id WHERE r.company_id=$1 AND r.return_id=$2",
          [ctx.companyId, id],
        )
      ).rows;
      title = "Credit note (fiscal status separate)";
      break;
    case "stock-document":
      requirePermission(ctx, "inventory.read");
      doc = await one(
        ctx,
        "SELECT * FROM stock_documents WHERE company_id=$1 AND id=$2",
        [ctx.companyId, id],
      );
      branchAccess(ctx, doc.branch_id);
      lines = (
        await ctx.db.query(
          "SELECT l.*,p.name,(l.quantity*l.unit_cost)::text AS value FROM stock_document_lines l JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id WHERE l.company_id=$1 AND l.document_id=$2",
          [ctx.companyId, id],
        )
      ).rows;
      title = "Stock " + doc.type;
      break;
    default:
      fail(404, "NOT_FOUND", "Document type not found");
  }
  await audit(ctx, "print", kind, id);
  return renderPdf({
    company,
    title,
    number: doc.number,
    date: (doc.accounting_date ?? doc.created_at)?.toISOString?.().slice(0, 10),
    lines,
    totals:
      doc.printTotals ??
      (doc.total
        ? { Total: doc.total }
        : doc.value
          ? { Value: doc.value }
          : undefined),
    notes:
      doc.notes ??
      doc.reason ??
      (doc.status ? `Status: ${doc.status}` : undefined),
  });
}
export async function reportPdf(ctx: Context, name: string, q: any) {
  requirePermission(ctx, "accounting.read");
  const company = await one(ctx, "SELECT * FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  let lines: any[] = [],
    totals: Record<string, string> = {},
    title = name;
  if (name === "trial-balance") {
    const r = await trialBalance(ctx, q);
    lines = r.items;
    totals = { Debits: r.debits, Credits: r.credits, Difference: r.difference };
    title = "Trial balance";
  } else if (name === "pnl") {
    const r = await profitAndLoss(ctx, q);
    lines = [...r.income, ...r.expenses];
    totals = {
      Revenue: r.revenue,
      "Gross profit": r.gross_profit,
      "Net profit": r.net_profit,
    };
    title = "Profit and loss";
  } else if (name === "balance-sheet") {
    const r = await balanceSheet(ctx, q);
    lines = [...r.assets, ...r.liabilities, ...r.equity];
    totals = {
      Assets: r.total_assets,
      Liabilities: r.total_liabilities,
      Equity: r.total_equity,
      "Current earnings": r.current_earnings,
    };
    title = "Balance sheet";
  } else fail(404, "NOT_FOUND", "Printable report not found");
  return renderPdf({
    company,
    title,
    number: `As of ${(await reportScope(ctx, q)).to}`,
    lines,
    totals,
  });
}
export async function statementPdf(
  ctx: Context,
  kind: "customer" | "supplier",
  id: string,
  q: any,
) {
  const r = await contactStatement(ctx, kind, id, { ...q, limit: 100 });
  if (r.total > 100)
    fail(
      422,
      "PRINT_PAGINATION",
      "Statement exceeds 100 lines; narrow the date range or export pages",
    );
  const company = await one(ctx, "SELECT * FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  await audit(ctx, "print", kind + "_statement", id);
  return renderPdf({
    company,
    title: `${kind === "customer" ? "Customer" : "Supplier"} statement`,
    number: r.contact.name,
    lines: r.items,
    totals: { Opening: r.opening },
    notes: r.convention,
  });
}
