import { getOpeningBatch } from "./opening-balances.ts";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
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
  /** Template identity grid (right block on A4, stacked on thermal). */
  meta?: [string, string][];
  /** "Received from" party cell. */
  customer?: string;
  customerSub?: string;
  /** "Payment reference" party cell. */
  reference?: string;
  referenceSub?: string;
  /** Tax & KRA details panel — real values only, never placeholders. */
  kra?: [string, string][];
  /** Verify strip payload (rendered as QR image). */
  qr?: string;
  /** Lead line of the closing footer band. */
  thanks?: string;
}): Promise<Buffer> {
  return (async () => {
    const thermal = input.thermal;
    const width = input.company.settings?.receiptWidth === 58 ? 164 : 227;
    const cur = input.company.currency.trim();
    const ink = "#172b3a",
      muted = "#647482",
      line = "#dce5e9",
      teal = "#147d78",
      pale = "#eff7f6";
    // Thermal rolls: page height approximates the cut position, so estimate
    // content height tightly (deficit would clip, surplus only wastes paper).
    const totalsRows = Object.keys(input.totals ?? {}).length;
    const noteLines = input.notes
      ? input.notes
          .split("\n")
          .reduce((acc, t) => acc + Math.max(1, Math.ceil(t.length / 56)), 0)
      : 0;
    const thermalHeight = Math.max(
      360,
      92 +
        (input.meta?.length ?? 0) * 10.5 +
        (input.customer ? 34 : 0) +
        18 +
        input.lines.length * 29 +
        (32 + totalsRows * 11.5) +
        noteLines * 9 +
        (input.kra?.length || input.qr
          ? 24 + (input.kra?.length ?? 0) * 8.5 + (input.qr ? 58 : 0)
          : 0) +
        56,
    );
    const doc = new PDFDocument({
      size: thermal ? [width, thermalHeight] : "A4",
      margin: thermal ? 12 : 45,
      info: {
        Title: `${input.title} ${input.number}`,
        Author: input.company.name,
      },
    });
    const buffers: Buffer[] = [];
    doc.on("data", (b) => buffers.push(b));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(buffers)));
    });

    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const m = doc.page.margins.left;
    const hr = (weight = 0.8, color = line, gap = 0.35) => {
      const y = doc.y;
      doc.moveTo(m, y).lineTo(m + w, y).lineWidth(weight).strokeColor(color).stroke().moveDown(gap);
    };
    const qtyText = (q: any) => {
      try {
        return D(q).toFixed(6).replace(/\.?0+$/, "") || "0";
      } catch {
        return String(q);
      }
    };
    const dashed = (gap = 0.3) => {
      const y = doc.y;
      doc.dash(2, { space: 3 }).moveTo(m, y).lineTo(m + w, y).lineWidth(0.7).strokeColor("#777").stroke().undash().moveDown(gap);
    };

    const initials = String(input.company.name ?? "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((t) => t[0]!.toUpperCase())
      .join("");
    const companyLines = [
      input.company.address,
      [input.company.phone ? `+254 ${String(input.company.phone).replace(/^\+?254/, "")}`.replace("+254 +254", "+254 ") : null, input.company.email]
        .filter(Boolean)
        .join(" · "),
    ].filter(Boolean) as string[];
    const metaGrid: [string, string][] =
      input.meta ??
      ([
        ["Document no.", input.number],
        ...(input.date ? [["Date", input.date] as [string, string]] : []),
      ] as [string, string][]);

    if (thermal) {
      // ================= THERMAL (80 / 58 mm) =================
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(14).text(
        String(input.company.name).toUpperCase(),
        { align: "center" },
      );
      doc.fillColor(muted).font("Helvetica").fontSize(8);
      for (const t of companyLines) doc.text(t, { align: "center" });
      if (input.company.tax_pin) doc.text(`Tax PIN: ${input.company.tax_pin}`, { align: "center" });
      doc.moveDown(0.35);
      dashed();
      doc
        .fillColor(ink)
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .text(input.title.toUpperCase(), { align: "center", characterSpacing: 1.6 });
      doc.moveDown(0.25);
      for (const [label, value] of metaGrid) {
        const y = doc.y;
        doc.font("Helvetica").fontSize(8).fillColor(muted).text(label, m, y, { width: w * 0.42 });
        doc.font("Helvetica-Bold").fillColor(ink).text(value, m + w * 0.42, y, {
          width: w * 0.58,
          align: "right",
        });
      }
      doc.moveDown(0.35);
      dashed();
      if (input.customer) {
        const rcy = doc.y + 1;
        doc
          .font("Helvetica-Bold")
          .fontSize(7)
          .fillColor("#444")
          .text("RECEIVED FROM", m, rcy, { width: w, characterSpacing: 0.6 });
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(ink)
          .text(
            [input.customer, input.customerSub].filter(Boolean).join("\n"),
            m,
            doc.y + 2,
            { width: w },
          );
        doc.y += 4;
        dashed();
      }
      // items: bold name, calc row (qty × unit → amount)
      const ih = doc.y;
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#444")
        .text("ITEM / QTY × PRICE", m, ih, { width: w * 0.62, characterSpacing: 0.6 });
      doc.text("AMOUNT", m + w * 0.62, ih, { width: w * 0.38, align: "right", characterSpacing: 0.6 });
      doc.y = ih + 9;
      input.lines.forEach((l, idx) => {
        const sep = doc
          .moveTo(m, doc.y)
          .lineTo(m + w, doc.y)
          .lineWidth(idx === 0 ? 0.9 : 0.5)
          .strokeColor(idx === 0 ? "#777" : "#9a9a9a");
        if (idx !== 0) sep.dash(1, { space: 2 });
        sep.stroke().undash();
        doc.y += 3;
        doc
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor(ink)
          .text(String(l.name ?? l.description ?? l.account ?? l.code ?? "Item"), m, doc.y, {
            width: w,
          });
        const calc = [
          l.quantity !== undefined && l.unit_price !== undefined
            ? `${qtyText(l.quantity)}${l.unit ? " " + l.unit : ""} × ${money(l.unit_price)}`
            : l.unit_cost !== undefined
              ? `@ ${money(l.unit_cost)}`
              : [l.sku, l.debit !== undefined ? `Dr ${l.debit} / Cr ${l.credit}` : null]
                  .filter(Boolean)
                  .join(" · "),
        ].filter(Boolean)[0];
        const value = l.total ?? l.amount ?? l.value ?? l.revenue ?? l.balance;
        const cy = doc.y + 1;
        if (calc)
          doc.font("Helvetica").fontSize(7.5).fillColor("#333").text(calc, m, cy, {
            width: w * 0.56,
          });
        if (value !== undefined)
          doc
            .font("Helvetica-Bold")
            .fontSize(8.5)
            .fillColor(ink)
            .text(`${cur} ${money(value)}`, m + w * 0.52, cy, {
              width: w * 0.48,
              align: "right",
            });
        doc.y = Math.max(doc.y, cy + 10) + 3;
      });
      // totals
      const totals = Object.entries(input.totals ?? {});
      if (totals.length) {
        doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.9).strokeColor("#777").stroke().moveDown(0.25);
        for (const [label, value] of totals) {
          const isTotal = label.toLowerCase() === "total";
          const y = doc.y;
          doc
            .font(isTotal ? "Helvetica-Bold" : "Helvetica")
            .fontSize(isTotal ? 10 : 8)
            .fillColor(ink)
            .text(label === "Total" ? "TOTAL PAID" : label, m, isTotal ? y + 4 : y, { width: w * 0.5 });
          doc
            .text(`${cur} ${money(value)}`, m + w * 0.5, isTotal ? y + 4 : y, { width: w * 0.5, align: "right" });
          if (isTotal) {
            const gy = doc.y + 1;
            doc.moveTo(m, gy).lineTo(m + w, gy).lineWidth(0.9).strokeColor("#777").stroke();
            doc.moveDown(0.35);
          }
          doc.moveDown(0.12);
        }
      }
      if (input.notes) {
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(7).fillColor(muted).text(input.notes, m, doc.y + 2, { width: w });
      }
      if (input.kra?.length || input.qr) {
        doc.moveDown(0.2);
        const boxY = doc.y;
        let bh = 12;
        if (input.kra?.length) bh += 10 + input.kra.length * 8;
        if (input.qr) bh += 54;
        doc.rect(m, boxY, w, bh).lineWidth(0.8).strokeColor("#888").stroke();
        doc.y = boxY + 6;
        doc.x = m + 6;
        if (input.kra?.length) {
          doc
            .font("Helvetica-Bold")
            .fontSize(6.5)
            .fillColor(ink)
            .text("TAX / KRA DETAILS", { width: w - 12, characterSpacing: 0.6 });
          for (const [k, v] of input.kra)
            doc
              .font("Helvetica")
              .fontSize(7)
              .fillColor(muted)
              .text(`${k}: `, { continued: true, width: w - 12 })
              .font("Helvetica-Bold")
              .fillColor(ink)
              .text(v, { width: w - 12 });
        }
        if (input.qr) {
          const png = await QRCode.toBuffer(input.qr, { type: "png", scale: 5, margin: 0 });
          const side = 44;
          doc.image(png, m + 6, doc.y + 2, { width: side });
          doc
            .font("Helvetica-Bold")
            .fontSize(6.5)
            .fillColor(ink)
            .text("SCAN TO VERIFY", m + 6 + side + 8, doc.y + 12, { width: w - side - 22 });
          doc
            .font("Helvetica")
            .fontSize(6.5)
            .fillColor(muted)
            .text("Document verification code", { width: w - side - 22 });
          doc.y += side + 6;
        }
        doc.y = boxY + bh + 8;
      }
      doc.font("Helvetica-Bold").fontSize(8).fillColor(ink).text(
        input.footer ?? input.company.settings?.receiptFooter ?? "Thank you for your business!",
        { align: "center" },
      );
      doc
        .font("Helvetica")
        .fontSize(6.5)
        .fillColor(muted)
        .text("Please keep this receipt for your records.", { align: "center" });
      doc.y += 6;
      dashed(0.05);
      doc.y += 7;
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#999")
        .text("- - - - - - CUT - - - - - -", m, doc.y, { width: w, align: "center" });
      doc.end();
      return done;
    }

    // ================= A4 (template layout) =================
    doc.rect(0, 0, doc.page.width, 6).fillColor(teal).fill();
    const headY = doc.y;
    if (initials)
      doc.roundedRect(m, headY, 50, 50, 10).fillColor(pale).fill();
    doc
      .fillColor(teal)
      .font("Helvetica-Bold")
      .fontSize(19)
      .text(initials, m, headY + 14, { width: 50, align: "center" });
    let ly = headY + 2;
    doc
      .fillColor(ink)
      .font("Helvetica-Bold")
      .fontSize(19)
      .text(input.company.name, m + 64, ly, { width: w - 300 });
    ly = doc.y;
    doc.fillColor(muted).font("Helvetica").fontSize(9);
    for (const t of companyLines) {
      doc.text(t, m + 64, ly, { width: w - 300 });
      ly = doc.y;
    }
    // doc identity block (right)
    const rx = m + w - 236;
    let ry = headY;
    doc
      .fillColor(teal)
      .font("Helvetica-Bold")
      .fontSize(17)
      .text(input.title.toUpperCase(), rx, ry, {
        width: 236,
        align: "right",
        characterSpacing: 2.4,
      });
    ry = doc.y + 8;
    for (const [label, value] of metaGrid) {
      doc.font("Helvetica").fontSize(9).fillColor(muted).text(label, rx, ry, { width: 106 });
      doc.font("Helvetica-Bold").fillColor(ink).fontSize(9).text(value, rx + 106, ry, {
        width: 130,
        align: "right",
      });
      ry = doc.y + 4;
    }
    doc.y = Math.max(ly, ry) + 8;
    hr(1, line);

    // parties row
    if (input.customer || input.reference) {
      const py = doc.y + 2;
      const colW = (w - 24) / 2;
      const party = (x: number, eyebrow: string, name?: string, sub?: string) => {
        if (!name) return 0;
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(muted).text(eyebrow.toUpperCase(), x, py, {
          width: colW,
          characterSpacing: 1,
        });
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor(ink).text(name, x, doc.y + 3, { width: colW });
        if (sub) doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(sub, x, doc.y + 2, { width: colW });
        return doc.y;
      };
      const e1 = party(m, "Received from", input.customer, input.customerSub);
      const e2 = party(m + colW + 24, "Payment reference", input.reference, input.referenceSub);
      doc.y = Math.max(e1 || doc.y, e2 || doc.y) + 6;
      hr(0.8, line);
    }

    // items table header (uppercase, light band)
    doc.moveDown(0.25);
    const thY = doc.y + 2;
    const colItemW = w * 0.46,
      colQtyW = w * 0.1,
      colUnitW = w * 0.2,
      colAmtW = w * 0.24;
    const colUnit = input.lines.some((l) => l.unit_price !== undefined || l.unit_cost !== undefined);
    doc.rect(m, thY, w, 16).fillColor("#f3f7f8").fill();
    doc.moveTo(m, thY).lineTo(m + w, thY).lineWidth(0.7).strokeColor(line).stroke();
    doc.moveTo(m, thY + 16).lineTo(m + w, thY + 16).lineWidth(0.7).strokeColor(line).stroke();
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#4d606d")
      .text("DESCRIPTION", m + 4, thY + 4.5, { width: colItemW - 4, characterSpacing: 0.8 });
    doc.text("QTY", m + colItemW + 4, thY + 4.5, { width: colQtyW - 4, align: "right", characterSpacing: 0.8 });
    doc.text("UNIT PRICE", m + colItemW + colQtyW + 4, thY + 4.5, {
      width: colUnitW - 4,
      align: "right",
      characterSpacing: 0.8,
    });
    doc.text("AMOUNT", m + colItemW + colQtyW + colUnitW + 4, thY + 4.5, {
      width: colAmtW - 4,
      align: "right",
      characterSpacing: 0.8,
    });
    doc.y = thY + 20;

    const amountX = m + colItemW + colQtyW + colUnitW;
    for (const l of input.lines) {
      if (doc.y > doc.page.height - 208) {
        doc.addPage();
        doc.y = doc.page.margins.top;
      }
      const yL = doc.y + 2;
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor("#223b4a")
        .text(String(l.name ?? l.description ?? l.account ?? l.code ?? "Item"), m + 4, yL, {
          width: colItemW - 8,
        });
      if (l.quantity !== undefined)
        doc.font("Helvetica").fontSize(9).fillColor(ink).text(
          `${qtyText(l.quantity)}${l.unit ? " " + l.unit : ""}`,
          m + colItemW + 4,
          yL,
          { width: colQtyW - 4, align: "right" },
        );
      const unitVal = l.unit_price ?? l.unit_cost;
      if (unitVal !== undefined)
        doc.font("Helvetica").fontSize(9).fillColor(ink).text(
          `${cur} ${money(unitVal)}`,
          m + colItemW + colQtyW + 4,
          yL,
          { width: colUnitW - 4, align: "right" },
        );
      const value = l.total ?? l.amount ?? l.value ?? l.revenue ?? l.balance;
      if (value !== undefined)
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ink).text(
          `${cur} ${money(value)}`,
          amountX + 4,
          yL,
          { width: colAmtW - 4, align: "right" },
        );
      const subMeta = [
        l.sku,
        l.debit !== undefined ? `Dr ${l.debit} / Cr ${l.credit}` : null,
        l.tax !== undefined ? `Incl. tax ${cur} ${money(l.tax)}` : null,
        l.batch_number ? `Batch ${l.batch_number}` : null,
      ]
        .filter(Boolean)
        .join("   ·   ");
      if (subMeta)
        doc.font("Helvetica").fontSize(7.5).fillColor(muted).text(subMeta, m + 4, doc.y + 2, {
          width: w - 8,
        });
      doc.moveDown(0.35);
      const ruleY = doc.y;
      doc.moveTo(m, ruleY).lineTo(m + w, ruleY).lineWidth(0.4).strokeColor(line).stroke().moveDown(0.25);
    }

    // totals — right column, grand in pale band
    const totals = Object.entries(input.totals ?? {});
    if (totals.length) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      const tw = 250,
        tx = m + w - tw;
      doc.moveDown(0.3);
      for (const [label, value] of totals) {
        const isTotal = label.toLowerCase() === "total";
        if (isTotal) {
          const gy = doc.y + 4;
          doc.rect(tx - 11, gy, tw + 11, 24).fillColor(pale).fill();
          doc.rect(tx - 14, gy, 3, 24).fillColor(teal).fill();
          doc.font("Helvetica-Bold").fontSize(12.5).fillColor(ink).text("Total paid", tx, gy + 5.5, {
            width: tw * 0.48,
          });
          doc.text(`${cur} ${money(value)}`, tx + tw * 0.48, gy + 5.5, {
            width: tw * 0.52,
            align: "right",
          });
          doc.y = gy + 30;
        } else {
          const ty = doc.y + 2;
          doc.font("Helvetica").fontSize(9.5).fillColor("#536572").text(label, tx, ty, { width: tw * 0.48 });
          doc.fillColor(ink).text(
            /^-?\d+(\.\d+)?$/.test(String(value).replaceAll(",", "")) ? `${cur} ${money(value)}` : String(value),
            tx + tw * 0.48,
            ty,
            { width: tw * 0.52, align: "right" },
          );
          doc.moveDown(0.2);
        }
      }
      doc.moveDown(0.3);
    }

    if (input.notes) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(input.notes, m + 2, doc.y + 2, { width: w - 4 });
      doc.moveDown(0.3);
    }

    // tax / KRA panel — real values only
    if (input.kra?.length) {
      if (doc.y > doc.page.height - 170) doc.addPage();
      const ky = doc.y + 6;
      const rows = Math.ceil(input.kra.length / 2);
      doc.lineWidth(0.8).roundedRect(m + 2, ky, w - 4, 26 + rows * 17, 6).fillAndStroke("#f7f9fa", line);
      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .fillColor(teal)
        .text("TAX & KRA DETAILS", m + 14, ky + 9, {
          width: w - 28,
          characterSpacing: 1,
        });
      const cellW = (w - 44) / 2;
      let ky2 = ky + 24;
      input.kra.forEach(([k, v], i) => {
        const x = m + 14 + (i % 2) * (cellW + 16);
        const yy = ky2 + Math.floor(i / 2) * 17;
        doc.font("Helvetica").fontSize(6.8).fillColor(muted).text(k.toUpperCase(), x, yy, {
          width: cellW,
          characterSpacing: 0.6,
        });
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(ink).text(v, x, yy + 7, { width: cellW });
      });
      doc.y = ky + 30 + rows * 17;
    }

    // verify strip with QR
    if (input.qr) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      const vy = doc.y + 8;
      doc.dash(3, { space: 2 }).roundedRect(m + 2, vy, w - 4, 66, 6).lineWidth(0.8).strokeColor("#c5d2d8").stroke().undash();
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(ink)
        .text("Document verification", m + 14, vy + 14, { width: w - 130 });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(muted)
        .text("Scan the QR code to record or verify this document.", { width: w - 130 });
      const png = await QRCode.toBuffer(input.qr, { type: "png", scale: 5, margin: 0 });
      doc.image(png, m + w - 64 - 12, vy + 6, { width: 54 });
      doc.y = vy + 74;
    }

    // payment + footer band
    if (doc.y > doc.page.height - 120) doc.addPage();
    const py = doc.y + 6;
    doc.moveTo(m, py).lineTo(m + w, py).lineWidth(0.8).strokeColor(line).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(ink)
      .text("Payment received", m, py + 9, { width: w * 0.5 });
    let paidSub = input.customer ? "Settled as invoiced" : "Thank you.";
    const outRaw = input.totals?.["Balance due"] ?? input.totals?.["Outstanding"];
    if (outRaw !== undefined) {
      try {
        paidSub = D(outRaw).lte(0) ? "Paid in full" : "Balance outstanding";
      } catch {
        /* non-numeric totals */
      }
    }
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(muted)
      .text(paidSub, { width: w * 0.5 });
    const helpPhone = [input.company.phone, input.company.email].filter(Boolean).join(" · ");
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(ink)
      .text("Need help?", m + w * 0.55, py + 9, { width: w * 0.45, align: "right" });
    if (helpPhone)
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(muted)
        .text(helpPhone, m + w * 0.55, doc.y + 1, { width: w * 0.45, align: "right" });
    const fy = doc.moveDown(0.8).y + 6;
    doc.moveTo(m, fy).lineTo(m + w, fy).lineWidth(0.4).strokeColor(line).stroke();
    doc.roundedRect(m, fy + 8, w, 40, 6).fillColor(ink).fill();
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .fillColor("#ffffff")
      .text(
        input.thanks ?? input.company.settings?.receiptFooter ?? "Thank you for your business.",
        m + 14,
        fy + 16,
        { width: w - 28, align: "center" },
      );
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#c7d4da")
      .text(
        input.footer ??
          `Generated by Duka Business OS · ${input.title} ${input.number}`,
        m + 14,
        fy + 32,
        { width: w - 28, align: "center" },
      );
    doc.end();
    return done;
  })();
}

export async function salePdf(ctx: Context, id: string, thermal: boolean) {
  const s = await getSale(ctx, id, true);
  const people = await one(
    ctx,
    `SELECT u.name AS cashier, c.name AS customer_name, c.phone AS customer_phone
     FROM sales s
     JOIN identities u ON u.company_id=s.company_id AND u.id=s.created_by
     LEFT JOIN customers c ON c.company_id=s.company_id AND c.id=s.customer_id
     WHERE s.company_id=$1 AND s.id=$2`,
    [ctx.companyId, id],
  );
  const confirmed = s.fiscal?.status === "successful";
  const paidMethods = s.payments.map((p: any) => p.method);
  const methodSummary = [...new Set(paidMethods)].join(" + ") || "—";
  const receiptReference = s.payments.find(
    (p: any) => p.reference,
  )?.reference as string | undefined;
  const paidStamp = s.created_at ? new Date(s.created_at) : null;
  const dateText = s.accounting_date.toISOString().slice(0, 10);
  const timeText = paidStamp
    ? paidStamp.toLocaleTimeString("en-KE", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: s.company.timezone ?? "Africa/Nairobi",
      })
    : undefined;
  const notes = [
    D(s.customer_credit_used).gt(0)
      ? `Customer account credit: ${s.customer_credit_used}`
      : "",
    confirmed
      ? ""
      : `NOT A KRA FISCAL INVOICE. Fiscal status: ${s.fiscal?.status ?? "not submitted"}.`,
    s.company.settings.returnPolicy ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const meta: [string, string][] = [
    ["Receipt no.", s.number],
    ["Date", dateText],
    ...(timeText ? [["Time", timeText] as [string, string]] : []),
    ["Served by", people.cashier],
    ["Payment", methodSummary],
  ];
  return renderPdf({
    company: s.company,
    title: thermal ? "Sales receipt" : "Sales invoice",
    number: s.number,
    date: dateText,
    lines: s.lines,
    totals: {
      Subtotal: s.subtotal,
      ...(D(s.discount).gt(0) ? { Discount: s.discount } : {}),
      VAT: s.tax,
      Total: s.total,
      "Paid at checkout": s.paid_at_sale,
      "Balance due": s.outstanding,
    },
    notes,
    thermal,
    meta,
    customer: people.customer_name ?? undefined,
    customerSub: people.customer_phone ?? undefined,
    reference: receiptReference,
    referenceSub: receiptReference ? "Provider transaction code" : undefined,
    kra: [
      ["Business KRA PIN", s.company.tax_pin ?? "—"],
      [thermal ? "Tax invoice no." : "Tax invoice number", s.number],
      ...(confirmed
        ? [
            [thermal ? "eTIMS CU no." : "eTIMS CU invoice number", s.fiscal.fiscal_id] as [string, string],
          ]
        : []),
    ],
    qr: `DUKA|${s.company_id}|sale|${id}`,
    thanks: s.company.settings?.receiptFooter ?? undefined,
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
