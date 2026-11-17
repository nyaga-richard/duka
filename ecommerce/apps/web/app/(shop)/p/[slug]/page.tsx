import Link from "next/link";
import { notFound } from "next/navigation";
import { AddToCart } from "@/components/AddToCart";
import { ChevronRightIcon } from "@/components/icons";
import { getProduct, listReviews, money, priceFrom } from "@/lib/server-api";

export const dynamic = "force-dynamic";

function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <span className="stars" aria-label={`${rating} out of 5`}>
      {"★".repeat(Math.max(0, Math.min(5, full)))}
      <span style={{ opacity: 0.25 }}>{"★".repeat(Math.max(0, 5 - full))}</span>
    </span>
  );
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  const reviews = await listReviews(slug, 8);
  const images = product.images ?? [];
  const primary = images.find((image) => image.is_primary) ?? images[0] ?? null;
  const price = priceFrom(product);
  const totalStock = (product.variants ?? []).reduce(
    (sum, variant) => sum + (variant.available ?? 0),
    0,
  );
  const monogram = product.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <main>
      <nav
        className="breadcrumbs"
        aria-label="Breadcrumb"
        style={{ marginBottom: 16 }}
      >
        <Link href="/">Shop</Link>
        {product.category ? (
          <>
            <ChevronRightIcon size={12} />
            <Link
              href={`/?category=${encodeURIComponent(product.category_slug ?? "")}`}
            >
              {product.category}
            </Link>
          </>
        ) : null}
        <ChevronRightIcon size={12} />
        <strong>{product.name}</strong>
      </nav>

      <div className="product-hero">
        <div className="gallery">
          <div className="main">
            {primary?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primary.url} alt={primary.alt ?? product.name} />
            ) : (
              <span className="product-avatar" aria-hidden="true">
                {monogram || "·"}
              </span>
            )}
          </div>
          {images.length > 1 ? (
            <div className="thumbs">
              {images.slice(0, 6).map((image) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={image.url}
                  src={image.url}
                  alt={image.alt ?? product.name}
                  loading="lazy"
                />
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginBottom: 2,
            }}
          >
            {product.brand ? (
              <span className="badge">{product.brand}</span>
            ) : null}
            {totalStock > 0 ? (
              <span className="badge ok">
                <span className="status-dot" />
                {totalStock <= 5 ? `Only ${totalStock} left` : "In stock"}
              </span>
            ) : (
              <span className="badge danger">Sold out</span>
            )}
            {product.featured ? (
              <span className="badge accent">Featured</span>
            ) : null}
          </div>

          <h1 className="product-title">{product.name}</h1>
          {product.summary ? (
            <p className="product-lede">{product.summary}</p>
          ) : null}

          <div className="product-price">
            {price ? money(price) : "See options"}
            {(product.variants?.length ?? 0) > 1 ? (
              <small>from, cheapest option</small>
            ) : null}
          </div>

          <div className="card">
            <div className="card-heading">
              <div>
                <h3>Choose an option</h3>
                <p>Adding an item holds stock for 15 minutes.</p>
              </div>
            </div>
            <div className="card-content">
              {(product.variants ?? []).length === 0 ? (
                <p className="muted small">
                  This product has no purchasable options yet.
                </p>
              ) : (
                (product.variants ?? []).map((variant) => (
                  <div className="variant" key={variant.variant_id}>
                    <div className="variant-head">
                      <strong>
                        {variant.options
                          ?.map((option) => option.value)
                          .join(" / ") || variant.sku}
                      </strong>
                      <span className="price small">
                        {money(variant.price)}
                      </span>
                    </div>
                    <div className="variant-note">
                      {variant.available > 0
                        ? `${variant.available} available`
                        : "Out of stock"}
                      {variant.compare_at_price &&
                      Number(variant.compare_at_price) >
                        Number(variant.price) ? (
                        <s>{money(variant.compare_at_price)}</s>
                      ) : null}
                    </div>
                    <AddToCart
                      variantId={variant.variant_id}
                      available={variant.available}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {product.description ? (
            <div className="card">
              <div className="card-heading">
                <h3>Details</h3>
              </div>
              <div className="card-content">
                <p
                  className="muted"
                  style={{ whiteSpace: "pre-line", fontSize: 12 }}
                >
                  {product.description}
                </p>
              </div>
            </div>
          ) : null}

          {(product.attributes?.length ?? 0) > 0 ? (
            <div className="card">
              <div className="card-heading">
                <h3>Specifications</h3>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <tbody>
                    {(product.attributes ?? []).map((attribute) => (
                      <tr key={`${attribute.key}-${attribute.value}`}>
                        <th
                          scope="row"
                          style={{ width: "45%", background: "transparent" }}
                        >
                          {attribute.label}
                        </th>
                        <td>{attribute.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginTop: 22 }}>
        <div className="card-heading">
          <div>
            <h3>Reviews</h3>
            <p>
              Verified purchases only. Reviews open once an order is delivered.
            </p>
          </div>
          {reviews.average_rating ? (
            <span className="muted small">
              <Stars rating={Number(reviews.average_rating)} />{" "}
              {Number(reviews.average_rating).toFixed(1)} · {reviews.total}{" "}
              review{reviews.total === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="muted small">No reviews yet</span>
          )}
        </div>
        <div className="card-content">
          {reviews.items.length === 0 ? (
            <div className="empty" style={{ padding: "24px 8px" }}>
              <p>
                Nothing published yet. Bought something? Review it from your
                order once it is delivered.
              </p>
            </div>
          ) : (
            <div>
              {reviews.items.map((review) => (
                <article className="review" key={review.review_id}>
                  <div className="review-head">
                    <span className="avatar" aria-hidden="true">
                      {(review.first_name?.[0] ?? "C").toUpperCase()}
                    </span>
                    <div>
                      <strong>
                        {review.first_name ?? "Customer"}{" "}
                        {review.last_initial ? `${review.last_initial}.` : ""}
                      </strong>
                      <div className="muted tiny">
                        <Stars rating={review.rating} />{" "}
                        {new Date(review.created_at).toLocaleDateString(
                          "en-KE",
                          { dateStyle: "medium" },
                        )}
                      </div>
                    </div>
                  </div>
                  {review.title ? (
                    <div className="review-title">{review.title}</div>
                  ) : null}
                  {review.comment ? (
                    <p className="review-body">{review.comment}</p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
