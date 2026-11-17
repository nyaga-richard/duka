import Link from "next/link";
import {
  money,
  priceFrom,
  primaryImage,
  stockOf,
  type ProductSummary,
} from "@/lib/server-api";

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) return <span className="badge danger">Sold out</span>;
  if (stock <= 5) return <span className="badge warn">{stock} left</span>;
  return null;
}

function monogram(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Catalogue tile — the ERP's `.product-tile`, the same box the POS uses to sell
 * from: art panel, monogram fallback when the ERP has no photo, badges pinned to
 * the art, copy block with price and brand. Server-rendered; the whole tile is
 * one link.
 */
export function ProductCard({ product }: { product: ProductSummary }) {
  const image = primaryImage(product);
  const price = priceFrom(product);
  const stock = stockOf(product);

  return (
    <Link className="product-tile" href={`/p/${product.slug}`}>
      <div className="product-tile-art">
        {image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt={image.alt ?? product.name} loading="lazy" />
        ) : (
          <span className="product-avatar" aria-hidden="true">
            {monogram(product.name) || "·"}
          </span>
        )}
        <div className="tile-badges">
          {product.category ? (
            <span className="badge">{product.category}</span>
          ) : (
            <span />
          )}
          <StockBadge stock={stock} />
        </div>
      </div>
      <div className="product-tile-copy">
        <small>{product.brand ?? "Duka"}</small>
        <strong>{product.name}</strong>
        {product.summary ? (
          <span
            className="tile-sku"
            style={{ display: "block", lineHeight: 1.6 }}
          >
            {product.summary}
          </span>
        ) : null}
        <div className="tile-foot">
          <span className="tile-price">
            {price ? money(price) : "See options"}
          </span>
          {stock > 0 ? <span className="badge ok">In stock</span> : null}
        </div>
      </div>
    </Link>
  );
}
