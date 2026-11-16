import Link from "next/link";
import { listProducts } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const products = await listProducts("?limit=24");

  return (
    <main>
      <h1>Shop the collection</h1>
      <p className="lede">Stock and prices are read live from the ERP. Holds last 15 minutes.</p>

      {products.length === 0 ? (
        <div className="notice info">
          No published products yet. An administrator must enable the ERP integration and run a catalogue pull
          (<code>POST /api/v1/admin/sync/erp/pull/catalog</code>), or create products locally.
        </div>
      ) : (
        <div className="grid">
          {products.map((product) => (
            <Link className="card" key={product.product_id} href={`/p/${product.slug}`}>
              <div className="thumb">{product.image_url ? " " : product.name.slice(0, 2).toUpperCase()}</div>
              <div className="body">
                <h3>{product.name}</h3>
                <span className="price">
                  {product.min_price ? `KES ${Number(product.min_price).toLocaleString("en-KE")}` : "See options"}
                </span>
                {product.summary ? <span className="muted">{product.summary}</span> : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
