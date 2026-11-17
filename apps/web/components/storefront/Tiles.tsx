import Link from "next/link";
import {
  money,
  priceFrom,
  primaryImage,
  stockOf,
  type ProductSummary,
} from "@/lib/server-api";

function monogram(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/** Shared art slot: the ERP photo when there is one, the monogram when not. */
function TileArt({
  product,
  className,
}: {
  product: ProductSummary;
  className: string;
}) {
  const image = primaryImage(product);
  return (
    <div className={className}>
      {image?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.url} alt={image.alt ?? product.name} loading="lazy" />
      ) : (
        <span className="product-avatar" aria-hidden="true">
          {monogram(product.name) || "·"}
        </span>
      )}
    </div>
  );
}

/**
 * The big tile: apple.com's half-page panel — kicker, headline, one line of
 * copy, a price and a blue way in, with the product's own photo underneath on
 * the pale panel. The whole tile is the link, so the affordances are decorative.
 */
export function FeatureTile({ product }: { product: ProductSummary }) {
  const price = priceFrom(product);
  const soldOut = stockOf(product) <= 0;
  return (
    <Link className="sf-tile" href={`/p/${product.slug}`}>
      <p className="sf-tile-kicker">
        {product.brand ?? product.category ?? "Duka"}
      </p>
      <h3>{product.name}</h3>
      {product.summary ? (
        <p className="sf-tile-sub">{product.summary}</p>
      ) : null}
      <div className="sf-tile-links">
        <span className="sf-link">{soldOut ? "Sold out" : "Shop ›"}</span>
        {price ? <span className="sf-price">{money(price)}</span> : null}
      </div>
      <TileArt product={product} className="sf-tile-art" />
    </Link>
  );
}

/** The compact tile: photo first, name and price beneath, no chrome. */
export function ShelfItem({ product }: { product: ProductSummary }) {
  const price = priceFrom(product);
  return (
    <Link className="sf-shelf-item" href={`/p/${product.slug}`}>
      <TileArt product={product} className="sf-shelf-art" />
      <span className="sf-shelf-name">{product.name}</span>
      <span className="sf-shelf-price">
        {price ? money(price) : "See options"}
        {stockOf(product) <= 0 ? " · Sold out" : ""}
      </span>
    </Link>
  );
}
