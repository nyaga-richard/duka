import "dotenv/config";
import { createCompany } from "../../scripts/setup.ts";
import { pool, transaction, one, type Actor } from "../../apps/api/src/db.ts";
import {
  productSchema,
  customerSchema,
  supplierSchema,
  stockInputSchema,
  checkoutSchema,
  poSchema,
  grnSchema,
  supplierInvoiceSchema,
  expenseSchema,
} from "@duka/shared";
import { D, money } from "@duka/shared";
import {
  createProduct,
  saveContact,
  priceCart,
} from "../../apps/api/src/services/catalog.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import {
  openShift,
  closeShift,
  expectedShift,
  reviewShift,
} from "../../apps/api/src/services/shifts.ts";
import { checkout } from "../../apps/api/src/services/sales.ts";
import {
  createPurchaseOrder,
  transitionPurchaseOrder,
  receiveGoods,
  recognizeSupplierInvoice,
} from "../../apps/api/src/services/procurement.ts";
import {
  createExpense,
  reviewExpense,
  payExpense,
} from "../../apps/api/src/services/business.ts";
import {
  configureUser,
  userSchema,
} from "../../apps/api/src/services/admin.ts";
import { postJournal } from "@duka/accounting";
import { randomUUID } from "node:crypto";
export async function seedDemo() {
  if (process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production")
    throw new Error(
      "Demo seeding requires DEMO_MODE=true and non-production NODE_ENV",
    );
  if (
    (
      await pool.query(
        "SELECT id FROM identities WHERE email='owner@duka.test'",
      )
    ).rowCount
  ) {
    console.log("Demo already exists; no data changed.");
    return;
  }
  const f = await createCompany({
    name: "Kijani General Stores",
    email: "owner@duka.test",
    ownerName: "Amina Mwangi",
    password: "DukaDemo2026!",
  });
  await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      'UPDATE companies SET address=\'Kilimani, Nairobi · Kenya\',phone=\'+254 712 000 000\',email=\'hello@kijani.example\',settings=settings||\'{"allowSelfApproval":true,"receiptFooter":"Asante for shopping local. See you again!","returnPolicy":"Unopened goods may be returned within 7 days with the original receipt. Demonstration tax rules only; not a fiscal invoice.","overDeliveryPercent":"5"}\'::jsonb WHERE id=$1',
      [f.companyId],
    );
    const roles = (
      await ctx.db.query("SELECT id,name FROM roles WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows;
    for (const [name, email, role] of [
      ["Brian Otieno", "cashier@duka.test", "Cashier"],
      ["Grace Wanjiku", "manager@duka.test", "General manager"],
    ])
      await configureUser(
        ctx,
        userSchema.parse({
          name,
          email,
          password: "DukaDemo2026!",
          role_ids: [roles.find((r) => r.name === role).id],
          branch_ids: [f.branchId],
          warehouse_ids: [f.warehouseId],
        }),
      );
    const branch2 = (
      await ctx.db.query(
        "INSERT INTO branches(company_id,name,code,address) VALUES($1,'Westlands branch','WST','Westlands, Nairobi') RETURNING id",
        [f.companyId],
      )
    ).rows[0].id;
    const warehouse2 = (
      await ctx.db.query(
        "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,'Westlands store','WEST') RETURNING id",
        [f.companyId, branch2],
      )
    ).rows[0].id;
    await ctx.db.query(
      "INSERT INTO user_branches(company_id,user_id,branch_id) SELECT $1,u.id,$2 FROM identities u WHERE u.company_id=$1 AND u.email IN ('owner@duka.test','manager@duka.test')",
      [f.companyId, branch2],
    );
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) SELECT $1,u.id,$2 FROM identities u WHERE u.company_id=$1 AND u.email IN ('owner@duka.test','manager@duka.test')",
      [f.companyId, warehouse2],
    );
    ctx.actor.branch_ids.push(branch2);
    ctx.actor.warehouse_ids.push(warehouse2);
    f.actor.branch_ids = ctx.actor.branch_ids;
    f.actor.warehouse_ids = ctx.actor.warehouse_ids;
    await ctx.db.query(
      "INSERT INTO registers(company_id,branch_id,warehouse_id,name) VALUES($1,$2,$3,'Westlands till')",
      [f.companyId, branch2, warehouse2],
    );
  });
  const meta = await transaction(f.actor, async (ctx) => ({
    units: (
      await ctx.db.query("SELECT * FROM units WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows,
    taxes: (
      await ctx.db.query("SELECT * FROM tax_rules WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows,
    categories: (
      await ctx.db.query("SELECT * FROM categories WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows,
    methods: (
      await ctx.db.query("SELECT * FROM payment_methods WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows,
  }));
  const products: any[] = [],
    customers: any[] = [],
    suppliers: any[] = [];
  const openingDate = new Date(Date.now() - 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  await transaction(f.actor, async (ctx) => {
    for (const [i, name, phone] of [
      [1, "Twiga Wholesale Ltd", "+254 720 100 001"],
      [2, "Nairobi Fresh Distributors", "+254 720 100 002"],
      [3, "East Africa Essentials", "+254 720 100 003"],
    ] as const)
      suppliers.push(
        await saveContact(
          ctx,
          "supplier",
          supplierSchema.parse({
            name,
            code: "SUP00" + i,
            phone,
            credit_days: 30,
          }),
        ),
      );
    for (const [i, name, phone, limit] of [
      [1, "Sarah Kamau", "+254 722 410 380", "50000"],
      [2, "Greenfield Café", "+254 733 291 004", "100000"],
      [3, "Daniel Kiptoo", "+254 711 032 881", "25000"],
      [4, "Oakwood Apartments", "+254 718 882 193", "100000"],
      [5, "Mercy Njeri", "+254 729 349 104", "25000"],
    ] as const)
      customers.push(
        await saveContact(
          ctx,
          "customer",
          customerSchema.parse({
            name,
            code: "CUS00" + i,
            phone,
            credit_limit: limit,
            credit_days: 30,
          }),
        ),
      );
    const rows = [
      [
        "Pembe Maize Flour · 2 kg",
        "PBF-002",
        "180",
        "125",
        "300",
        "Groceries",
        "pc",
      ],
      ["Daawat Rice · 1 kg", "DWR-001", "210", "155", "240", "Groceries", "pc"],
      [
        "Brookside Milk · 1 L",
        "BSM-001",
        "125",
        "88",
        "240",
        "Beverages",
        "pc",
      ],
      [
        "Fresh Fri Cooking Oil · 1 L",
        "FFC-001",
        "340",
        "250",
        "200",
        "Groceries",
        "pc",
      ],
      [
        "Mumias Sugar · 1 kg",
        "MMS-001",
        "185",
        "140",
        "250",
        "Groceries",
        "pc",
      ],
      ["Ketepa Tea · 250 g", "KTP-250", "165", "115", "200", "Beverages", "pc"],
      [
        "Nescafé Classic · 100 g",
        "NSC-100",
        "480",
        "345",
        "150",
        "Beverages",
        "pc",
      ],
      [
        "Aquamist Water · 500 ml",
        "AQM-500",
        "40",
        "20",
        "400",
        "Beverages",
        "pc",
      ],
      ["Coca-Cola · 500 ml", "COC-500", "75", "50", "400", "Beverages", "pc"],
      [
        "Sunlight Detergent · 1 kg",
        "SNL-001",
        "280",
        "195",
        "200",
        "Household",
        "pc",
      ],
      [
        "Geisha Bathing Soap · 125 g",
        "GSH-125",
        "95",
        "60",
        "200",
        "Household",
        "pc",
      ],
      [
        "Royco Mchuzi Mix · 200 g",
        "RYC-200",
        "75",
        "50",
        "250",
        "Groceries",
        "pc",
      ],
      [
        "Bamburi Cement · 50 kg",
        "BMC-050",
        "780",
        "640",
        "200",
        "Hardware",
        "pc",
      ],
      ["Fresh Tomatoes", "TOM-KG", "110", "65", "150", "Groceries", "kg"],
    ];
    for (let i = 0; i < rows.length; i++) {
      const [name, sku, price, purchase_cost, stock, cat, unit] = rows[i];
      const product = await createProduct(
        ctx,
        productSchema.parse({
          name,
          sku,
          barcode: String(6160000000000 + i),
          price,
          purchase_cost,
          min_price: price,
          unit_id: meta.units.find((u) => u.symbol === unit).id,
          tax_rule_id: meta.taxes.find((t) => t.code === "VAT16").id,
          category_id: meta.categories.find((c) => c.name === cat).id,
          supplier_id: suppliers[i % 3].id,
          reorder_level: "20",
        }),
      );
      products.push(product);
      await postStockDocument(
        ctx,
        stockInputSchema.parse({
          type: "opening",
          accounting_date: openingDate,
          warehouse_id: f.warehouseId,
          reason: "Demo opening stock · isolated sample data",
          lines: [
            {
              product_id: product.id,
              quantity: stock,
              unit_cost: purchase_cost,
            },
          ],
        }),
      );
    }
    await postJournal(ctx, {
      branchId: f.branchId,
      date: openingDate,
      sourceType: "opening",
      sourceId: randomUUID(),
      description: "Demo opening cash and bank",
      lines: [
        { account: "cash", debit: "50000.00" },
        { account: "bank", debit: "150000.00" },
        { account: "equity", credit: "200000.00" },
      ],
    });
  });
  const cash = meta.methods.find((m) => m.kind === "cash"),
    mpesa = meta.methods.find((m) => m.kind === "mpesa"),
    bank = meta.methods.find((m) => m.kind === "bank");
  const shift = await transaction(f.actor, (ctx) =>
    openShift(ctx, { register_id: f.registerId, opening_float: "5000" }),
  );
  for (let day = 13; day >= 0; day--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - day);
    const date = d.toISOString().slice(0, 10);
    for (let n = 0; n < 4 + (day % 4); n++) {
      await transaction(f.actor, async (ctx) => {
        const lines = [
          {
            product_id: products[(day + n) % products.length].id,
            quantity: String(1 + (n % 3)),
          },
          {
            product_id: products[(day * 3 + n + 4) % products.length].id,
            quantity: String(1 + ((day + n) % 3)),
          },
        ];
        const c =
          n === 0 && day % 3 === 0
            ? customers[day % customers.length]
            : undefined;
        const cart = checkoutSchema.parse({
          register_id: f.registerId,
          customer_id: c?.id,
          lines,
          payments: [],
          accounting_date: date,
        });
        const priced = await priceCart(ctx, cart, date);
        const paid = c ? money(D(priced.total).times("0.4")) : priced.total;
        const method = [cash, mpesa, cash, bank][n % 4];
        cart.payments = D(paid).gt(0)
          ? [
              {
                method_id: method.id,
                amount: paid,
                ...(method.kind !== "cash"
                  ? { reference: `DEMO-${day}-${n}-${method.kind}` }
                  : {}),
              },
            ]
          : [];
        await checkout(ctx, cart);
      });
    }
  }
  await transaction(f.actor, async (ctx) => {
    const s = await expectedShift(ctx, shift.id);
    await closeShift(ctx, shift.id, {
      counts: Object.fromEntries(s.methods.map((m: any) => [m.id, m.expected])),
    });
    await reviewShift(
      ctx,
      shift.id,
      "approved",
      "Isolated demonstration reconciliation with explicit self-approval policy",
    );
  });
  await transaction(f.actor, (ctx) =>
    openShift(ctx, { register_id: f.registerId, opening_float: "5000" }),
  );
  await transaction(f.actor, async (ctx) => {
    const po = await createPurchaseOrder(
      ctx,
      poSchema.parse({
        warehouse_id: f.warehouseId,
        supplier_id: suppliers[0].id,
        lines: [
          { product_id: products[0].id, quantity: "60", unit_cost: "125" },
          { product_id: products[5].id, quantity: "40", unit_cost: "115" },
        ],
      }),
    );
    await transitionPurchaseOrder(
      ctx,
      po.id,
      "submitted",
      "Replenishment procurement request",
    );
    await transitionPurchaseOrder(
      ctx,
      po.id,
      "approved",
      "Demo owner approval policy explicitly enabled",
    );
    const grn = await receiveGoods(
      ctx,
      grnSchema.parse({
        order_id: po.id,
        lines: po.lines.map((l: any) => ({
          order_line_id: l.id,
          quantity: l.product_id === products[0].id ? "30" : "20",
        })),
      }),
    );
    await recognizeSupplierInvoice(
      ctx,
      supplierInvoiceSchema.parse({
        receipt_id: grn.id,
        supplier_reference: "DEMO-TW-10482",
        due_date: new Date(Date.now() + 30 * 86400000)
          .toISOString()
          .slice(0, 10),
        lines: grn.lines.map((l: any) => ({
          receipt_line_id: l.id,
          net: money(l.value),
          tax_rule_id: l.tax_rule_id,
        })),
      }),
    );
    const category = await one(
      ctx,
      "SELECT id FROM expense_categories WHERE company_id=$1",
      [f.companyId],
    );
    const exp = await createExpense(
      ctx,
      expenseSchema.parse({
        branch_id: f.branchId,
        category_id: category.id,
        description: "October internet and connectivity",
        net: "4500",
        tax_rule_id: meta.taxes.find((t) => t.code === "VAT16").id,
      }),
    );
    await reviewExpense(
      ctx,
      exp.id,
      "approved",
      "Demo owner approval policy explicitly enabled",
    );
    await payExpense(ctx, exp.id, {
      payment: {
        method_id: bank.id,
        amount: exp.total,
        reference: "DEMO-EXP-001",
      },
    });
    for (const [p, target] of [
      [products[6], "8"],
      [products[9], "12"],
      [products[10], "5"],
    ] as const) {
      const b = await one(
        ctx,
        "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3",
        [f.companyId, p.id, f.warehouseId],
      );
      const delta = D(target).minus(b.quantity);
      if (!delta.eq(0))
        await postStockDocument(
          ctx,
          stockInputSchema.parse({
            type: "adjustment",
            warehouse_id: f.warehouseId,
            reason: "Demo stock count variance · illustrative sample",
            lines: [{ product_id: p.id, quantity: delta.toString() }],
          }),
        );
    }
  });
  console.log(
    "Isolated demo created: owner@duka.test, cashier@duka.test, manager@duka.test — development password: DukaDemo2026!",
  );
}
if (process.argv[1]?.endsWith("demo.ts"))
  seedDemo()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
