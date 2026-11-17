import Link from "next/link";
import { money, priceFrom, primaryImage, stockOf, type ProductSummary } from "@/lib/server-api";

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) return <span className="badge danger">Sold out</span>;
  if (stock <= 5) return <span className="badge warn">Low stock</span>;
  return null;
}

/**
 * Catalogue card. Server-rendered: the whole card is one link, the image falls
 * back to a monogram when the ERP has no photo, and the stock badge only
 * appears when it carries information worth the attention.
 */
export function ProductCard({ product }: { product: ProductSummary }) {
  const image = primaryImage(product);
  const price = priceFrom(product);
  const stock = stockOf(product);
  const monogram = product.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <Link className="pcard" href={`/p/${product.slug}`}>
      <div className="media">
        {image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt={image.alt ?? product.name} loading="lazy" />
        ) : (
          <span className="monogram" aria-hidden="true">
            {monogram || "·"}
          </span>
        )}
        <div className="badge-row">
          {product.category ? <span className="badge solid">{product.category}</span> : null}
          <StockBadge stock={stock} />
        </div>
      </div>
      <div className="body">
        <span className="name">{product.name}</span>
        {product.summary ? <span className="summary">{product.summary}</span> : null}
        <div className="foot">
          <span className="price">{price ? money(price) : "See options"}</span>
          {product.brand ? <span className="small muted">{product.brand}</span> : null}
        </div>
      </div>
    </Link>
  );
}
