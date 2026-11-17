/**
 * Optional demo catalogue.
 *
 * The storefront is only legible with something in it, and the real shop starts
 * empty on purpose (products come from the ERP, or from the store desk). This
 * script publishes a handful of products — some with photos from `public/seed`,
 * one deliberately without, so the monogram fallback is visible too — plus a
 * staff account and a shopper account. It creates nothing that exists already.
 *
 * Run: DATABASE_URL=... npm run demo:catalogue
 */
import { getDatabase, closeDatabase } from "../apps/api/src/db/index.ts";
import { migrate } from "../apps/api/src/db/migrate.ts";
import {
  provisionAdmin,
  registerCustomer,
} from "../apps/api/src/services/auth.ts";
import {
  createProduct,
  setProductImage,
} from "../apps/api/src/services/catalog-admin.ts";

const db = await getDatabase();
await migrate(db);

const categories: Array<[string, string]> = [
  ["Kitchen & Table", "kitchen-table"],
  ["Apparel", "apparel"],
  ["Bags", "bags"],
  ["Home", "home"],
];
const categoryIds: Record<string, number> = {};
for (const [name, slug] of categories) {
  const existing = await db.query<{ category_id: number }>(
    "SELECT category_id FROM category WHERE category_name = $1",
    [name],
  );
  categoryIds[slug] =
    existing.rows[0]?.category_id ??
    (
      await db.query<{ category_id: number }>(
        "INSERT INTO category(category_name, slug) VALUES($1,$2) RETURNING category_id",
        [name, slug],
      )
    ).rows[0]!.category_id;
}

// Credentials for looking around; change them anywhere real.
await provisionAdmin(db, {
  email: "owner@duka.local",
  password: "DukaPreview!2026",
  displayName: "Store Owner",
  role: "owner",
});

try {
  await registerCustomer(
    db,
    {
      email: "amina@example.test",
      password: "ShopperPassword2026!",
      fullName: "Amina Wanjiru",
    } as any,
    { ip: "127.0.0.1" } as any,
  );
} catch {
  /* already there */
}

const catalogue = [
  {
    product_name: "Sand Ceramic Mug",
    slug: "sand-ceramic-mug",
    summary: "Stoneware, dipped in a warm sand glaze. Holds 350ml.",
    description:
      "Thrown in small batches and finished by hand, so no two are identical. Dishwasher safe, but it prefers to be washed by hand.",
    category: "kitchen-table",
    brand: "Duka Studio",
    image: "/seed/mug.jpg",
    featured: true,
    variants: [
      {
        sku: "MUG-SAND",
        price: "450.50",
        qty_in_stock: 24,
        options: [{ option: "Colour", value: "Sand" }],
      },
      {
        sku: "MUG-CHAR",
        price: "470.00",
        qty_in_stock: 3,
        options: [{ option: "Colour", value: "Charcoal" }],
      },
    ],
  },
  {
    product_name: "White Kanzu Shirt",
    slug: "white-kanzu-shirt",
    summary: "Long-staple cotton with hand-stitched collar embroidery.",
    description:
      "Cut for a straight fall, pressed and ready to wear. Made in Mombasa.",
    category: "apparel",
    brand: "Duka Studio",
    image: "/seed/kanzu.jpg",
    featured: true,
    variants: [
      {
        sku: "KANZU-M",
        price: "1250.00",
        qty_in_stock: 6,
        options: [{ option: "Size", value: "M" }],
      },
      {
        sku: "KANZU-L",
        price: "1250.00",
        qty_in_stock: 4,
        options: [{ option: "Size", value: "L" }],
      },
      {
        sku: "KANZU-XL",
        price: "1350.00",
        qty_in_stock: 2,
        options: [{ option: "Size", value: "XL" }],
      },
    ],
  },
  {
    product_name: "Full-Grain Leather Tote",
    slug: "full-grain-leather-tote",
    summary: "Vegetable-tanned leather, unlined, with a hand-stitched handle.",
    description:
      "It will darken where you carry it. One inside pocket, brass hardware, no lining so it keeps its shape.",
    category: "bags",
    brand: "Kariuki Leather",
    image: "/seed/tote.jpg",
    featured: true,
    variants: [{ sku: "TOTE-TAN", price: "4800.00", qty_in_stock: 2 }],
  },
  {
    product_name: "Soy Candle, No. 4",
    slug: "soy-candle-no-4",
    summary: "Cedar, vetiver and a little smoke. Burns for 45 hours.",
    description: "Poured in Nairobi into a reusable frosted glass vessel.",
    category: "home",
    brand: "Duka Home",
    image: "/seed/candle.jpg",
    featured: false,
    variants: [{ sku: "CANDLE-4", price: "1200.00", qty_in_stock: 12 }],
  },
  {
    // Deliberately photo-less: this is the monogram fallback, on the front page.
    product_name: "Linen Napkin Set",
    slug: "linen-napkin-set",
    summary: "Four washed-linen napkins, hemmed by hand.",
    category: "kitchen-table",
    brand: "Duka Home",
    image: null,
    featured: true,
    variants: [{ sku: "NAPKIN-4", price: "900.00", qty_in_stock: 0 }],
  },
  {
    product_name: "Cotton Tea Towel",
    slug: "cotton-tea-towel",
    summary: "Heavy cotton twill with a hanging loop.",
    category: "kitchen-table",
    brand: "Duka Home",
    image: null,
    featured: false,
    variants: [{ sku: "TOWEL-01", price: "650.00", qty_in_stock: 8 }],
  },
];

for (const entry of catalogue) {
  const existing = await db.query<{ product_id: number }>(
    "SELECT product_id FROM product WHERE slug = $1",
    [entry.slug],
  );
  if (existing.rows[0]) {
    console.log(`skip ${entry.slug}`);
    continue;
  }
  const product = await createProduct(db, {
    product_name: entry.product_name,
    slug: entry.slug,
    summary: entry.summary,
    description: entry.description,
    status: "active",
    is_featured: entry.featured,
    category_id: categoryIds[entry.category]!,
    brand_name: entry.brand,
    variants: entry.variants as any,
  });
  if (entry.image) await setProductImage(db, product.product_id, entry.image);
  console.log(`created ${entry.slug}`);
}

console.log("demo catalogue ready");
await closeDatabase();
