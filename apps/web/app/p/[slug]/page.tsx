import Link from "next/link";
import { notFound } from "next/navigation";
import { AddToCart } from "@/components/AddToCart";
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

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  const reviews = await listReviews(slug, 8);
  const images = product.images ?? [];
  const primary = images.find((image) => image.is_primary) ?? images[0] ?? null;
  const price = priceFrom(product);
  const totalStock = (product.variants ?? []).reduce((sum, variant) => sum + (variant.available ?? 0), 0);
  const monogram = product.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <main>
      <p className="small muted" style={{ marginBottom: "1rem" }}>
        <Link href="/">Shop</Link>
        {product.category ? (
          <>
            {" / "}
            <Link href={`/?category=${encodeURIComponent(product.category_slug ?? "")}`}>{product.category}</Link>
          </>
        ) : null}
      </p>

      <div className="product-hero">
        <div className="gallery">
          <div className="main">
            {primary?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primary.url} alt={primary.alt ?? product.name} />
            ) : (
              <span className="monogram" aria-hidden="true" style={{ fontSize: "2.6rem", fontWeight: 800, opacity: 0.6 }}>
                {monogram || "·"}
              </span>
            )}
          </div>
          {images.length > 1 ? (
            <div className="thumbs">
              {images.slice(0, 6).map((image) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={image.url} src={image.url} alt={image.alt ?? product.name} loading="lazy" />
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div className="chips" style={{ marginBottom: "0.6rem" }}>
            {product.brand ? <span className="badge">{product.brand}</span> : null}
            {totalStock > 0 ? (
              <span className="badge ok">
                <span className="dot" />
                {totalStock <= 5 ? `Only ${totalStock} left` : "In stock"}
              </span>
            ) : (
              <span className="badge danger">Sold out</span>
            )}
            {product.featured ? <span className="badge accent">Featured</span> : null}
          </div>

          <h1 style={{ marginBottom: "0.3rem" }}>{product.name}</h1>
          {product.summary ? <p className="lede">{product.summary}</p> : null}

          <p className="price" style={{ fontSize: "1.4rem", margin: "0.4rem 0 1rem" }}>
            {price ? money(price) : "See options"}
            {(product.variants?.length ?? 0) > 1 ? <small> · from</small> : null}
          </p>

          <div className="panel">
            <h3>Choose an option</h3>
            {(product.variants ?? []).length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                This product has no purchasable options yet.
              </p>
            ) : (
              (product.variants ?? []).map((variant) => (
                <div className="variant" key={variant.variant_id}>
                  <div className="line">
                    <strong style={{ fontSize: "0.95rem" }}>
                      {variant.options?.map((option) => option.value).join(" / ") || variant.sku}
                    </strong>
                    <span className="price">{money(variant.price)}</span>
                  </div>
                  <p className="small muted" style={{ margin: "0 0 0.5rem" }}>
                    {variant.available > 0 ? `${variant.available} available` : "Out of stock"}
                    {variant.compare_at_price && Number(variant.compare_at_price) > Number(variant.price) ? (
                      <span style={{ marginLeft: "0.4rem", textDecoration: "line-through" }}>
                        {money(variant.compare_at_price)}
                      </span>
                    ) : null}
                  </p>
                  <AddToCart variantId={variant.variant_id} available={variant.available} />
                </div>
              ))
            )}
            <p className="small muted" style={{ margin: "0.8rem 0 0" }}>
              Adding an item holds stock for 15 minutes.
            </p>
          </div>

          {product.description ? (
            <div className="panel" style={{ marginTop: "1rem" }}>
              <h3>Details</h3>
              <p className="muted" style={{ whiteSpace: "pre-line", marginBottom: 0 }}>
                {product.description}
              </p>
            </div>
          ) : null}

          {(product.attributes?.length ?? 0) > 0 ? (
            <div className="panel" style={{ marginTop: "1rem" }}>
              <h3>Specifications</h3>
              <div className="table-wrap" style={{ boxShadow: "none", border: 0 }}>
                <table>
                  <tbody>
                    {(product.attributes ?? []).map((attribute) => (
                      <tr key={`${attribute.key}-${attribute.value}`}>
                        <th scope="row" style={{ width: "45%", textTransform: "none", letterSpacing: 0, fontSize: "0.85rem" }}>
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

      <section className="reviews">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>Reviews</h2>
          {reviews.average_rating ? (
            <span className="small muted">
              <Stars rating={Number(reviews.average_rating)} /> {Number(reviews.average_rating).toFixed(1)} ·{" "}
              {reviews.total} review{reviews.total === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="small muted">No reviews yet</span>
          )}
        </div>

        {reviews.items.length === 0 ? (
          <div className="notice info">
            Reviews come from verified purchases only: they open after an order is delivered.
          </div>
        ) : (
          <div className="panel">
            {reviews.items.map((review) => (
              <article className="review" key={review.review_id}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <span className="avatar" aria-hidden="true">
                    {(review.first_name?.[0] ?? "C").toUpperCase()}
                  </span>
                  <div>
                    <strong style={{ fontSize: "0.92rem" }}>
                      {review.first_name ?? "Customer"} {review.last_initial ? `${review.last_initial}.` : ""}
                    </strong>
                    <div className="small muted">
                      <Stars rating={review.rating} />{" "}
                      {new Date(review.created_at).toLocaleDateString("en-KE", { dateStyle: "medium" })}
                    </div>
                  </div>
                </div>
                {review.title ? <strong>{review.title}</strong> : null}
                {review.comment ? <p className="muted" style={{ margin: 0 }}>{review.comment}</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
