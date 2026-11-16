import Link from "next/link";
import { notFound } from "next/navigation";
import { AddToCart } from "@/components/AddToCart";
import { getProduct } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  return (
    <main>
      <p className="muted">
        <Link href="/">← Back to the shop</Link>
      </p>
      <div className="split">
        <div>
          <h1>{product.name}</h1>
          <p className="lede">{product.summary ?? ""}</p>
          <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--accent)" }}>
            {product.images?.[0]?.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={product.images[0].image_url} alt={product.images[0].alt_text ?? product.name} style={{ maxWidth: "100%" }} />
            ) : (
              <span style={{ fontWeight: 600 }}>{product.name}</span>
            )}
          </div>
          {product.description ? (
            <>
              <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Details</h2>
              <p className="muted" style={{ whiteSpace: "pre-line" }}>{product.description}</p>
            </>
          ) : null}
        </div>
        <aside className="card" style={{ padding: "1.1rem" }}>
          <h3 style={{ marginTop: 0 }}>Choose an option</h3>
          {product.variants.map((variant) => (
            <div key={variant.variant_id} style={{ borderTop: "1px solid var(--line)", padding: "0.9rem 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                <strong>{variant.options?.map((option) => option.value).join(" / ") || variant.sku}</strong>
                <span className="price">KES {Number(variant.price).toLocaleString("en-KE")}</span>
              </div>
              <p className="muted" style={{ margin: "0.25rem 0 0.6rem" }}>
                {variant.available > 0 ? `${variant.available} available` : "Out of stock"}
              </p>
              <AddToCart variantId={variant.variant_id} available={variant.available} />
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            Adding an item holds stock for 15 minutes.
          </p>
        </aside>
      </div>
    </main>
  );
}
