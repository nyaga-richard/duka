import Link from "next/link";
import { redirect } from "next/navigation";
import { SearchBar } from "@/components/SearchBar";
import { FeatureTile, ShelfItem } from "@/components/storefront/Tiles";
import { ArrowRightIcon } from "@/components/icons";
import {
  listCategories,
  listFeatured,
  listProducts,
  money,
  priceFrom,
  primaryImage,
  stockOf,
  type Category,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  page?: string;
}

/** Any catalogue parameter means the visitor wanted the catalogue, not the front page. */
function catalogueRedirect(params: Search): string | null {
  const search = new URLSearchParams();
  for (const key of ["q", "category", "brand", "sort", "page"] as const) {
    const value = params[key];
    if (value) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `/shop?${query}` : null;
}

/**
 * Front page.
 *
 * The catalogue used to *be* the front page: search box, filter rows and grid
 * the moment you landed, which is a lot to ask of someone who has not decided
 * what they want yet. This page answers "what is this shop" first — the promise,
 * the products the store chose to feature from the desk, the categories it sells
 * in — then hands over to `/shop` for everything. Old links that carry filters
 * are redirected rather than dropped.
 *
 * The composition follows apple.com's front page: a centred statement, one
 * stage-sozed hero product, a two-up tile row, a quiet shelf, and a pale band of
 * small print at the end. Photos come from the ERP when the product has one.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const destination = catalogueRedirect(params);
  if (destination) redirect(destination);

  const [categories, featured, newest] = await Promise.all([
    listCategories(),
    listFeatured(8),
    listProducts("?limit=8&sort=newest"),
  ]);

  const stocked = categories
    .filter((category) => category.product_count > 0)
    .slice(0, 8);
  const featuredAreCurated = featured.some((product) => product.featured);

  // Nothing published at all: say so once, honestly, instead of an empty grid.
  if (!featured.length && !stocked.length) {
    return (
      <main className="sf-home">
        <section className="sf-hero">
          <p className="sf-eyebrow">Duka Shop</p>
          <h1>The shop is being stocked.</h1>
          <p className="sf-sub">
            No products are published yet. Once the catalogue is in, the
            products featured from the store desk appear here.
          </p>
          <div className="sf-hero-actions">
            <Link className="btn primary" href="/admin">
              Open the store desk
            </Link>
          </div>
        </section>
      </main>
    );
  }

  // The stage is the shop's one big statement, so a product with a photo leads;
  // a monogram-only product stays in the tile row rather than headlining.
  const stage =
    featured.find((product) => primaryImage(product)?.url) ??
    featured[0] ??
    null;
  const tiles = featured.filter((product) => product !== stage).slice(0, 2);

  // Nothing below repeats what is already on the page: the shelf is "the rest".
  const shown = new Set(
    [stage, ...tiles].filter(Boolean).map((product) => product!.product_id),
  );
  const shelf = newest
    .filter((product) => !shown.has(product.product_id))
    .slice(0, 4);
  const stageImage = stage ? primaryImage(stage) : null;
  const stagePrice = stage ? priceFrom(stage) : null;

  return (
    <main className="sf-home">
      <section className="sf-hero">
        <p className="sf-eyebrow">Duka Shop</p>
        <h1>
          Everyday things,
          <br />
          straight from the shop floor.
        </h1>
        <p className="sf-sub">
          Prices and stock come from the ERP, so what you see is what the shop
          has. Adding something to your cart holds it for 15 minutes while you
          check out, and delivery is arranged with you afterwards.
        </p>
        <div className="sf-hero-actions">
          <Link className="btn primary" href="/shop">
            Shop all products
          </Link>
          <Link className="sf-link" href="/orders">
            Track an order <ArrowRightIcon size={14} />
          </Link>
        </div>
        <div className="sf-hero-search">
          <SearchBar action="/shop" id="home-search" />
        </div>
        <div className="sf-hero-meta">
          <span>Live ERP stock</span>
          <span aria-hidden="true">·</span>
          <span>15-minute hold</span>
          <span aria-hidden="true">·</span>
          <span>Pay on delivery</span>
        </div>
      </section>

      {stage ? (
        <section className="sf-stage" aria-labelledby="stage-heading">
          <p className="sf-eyebrow">
            {featuredAreCurated ? "Featured" : "New"}
          </p>
          <h2 id="stage-heading">{stage.name}</h2>
          <p>
            {stage.summary ??
              `${stage.brand ?? "Duka"} · ${
                stagePrice ? money(stagePrice) : "See options"
              }`}
          </p>
          <div className="sf-stage-links">
            <Link className="sf-link" href={`/p/${stage.slug}`}>
              Shop {stage.name} <ArrowRightIcon size={14} />
            </Link>
            {stagePrice ? (
              <span className="muted">{money(stagePrice)}</span>
            ) : null}
          </div>
          <div className="sf-stage-art">
            {stageImage?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={stageImage.url}
                alt={stageImage.alt ?? stage.name}
                loading="eager"
              />
            ) : (
              <span className="product-avatar" aria-hidden="true">
                {stage.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((word) => word[0]?.toUpperCase() ?? "")
                  .join("")}
              </span>
            )}
          </div>
        </section>
      ) : null}

      {tiles.length ? (
        <section className="sf-grid" aria-label="Featured products">
          {tiles.map((product) => (
            <FeatureTile key={product.product_id} product={product} />
          ))}
        </section>
      ) : null}

      {stocked.length ? (
        <section aria-labelledby="categories-heading">
          <div className="sf-section-head">
            <div>
              <h2 id="categories-heading">Browse by category</h2>
              <p>
                Every published product, grouped the way the shop groups it.
              </p>
            </div>
            <Link className="sf-link" href="/shop">
              Shop everything <ArrowRightIcon size={14} />
            </Link>
          </div>
          <div className="sf-categories">
            {stocked.map((category: Category) => (
              <Link
                key={category.category_id}
                className="sf-category"
                href={`/shop?category=${encodeURIComponent(category.slug)}`}
              >
                {category.category_name}
                <span>
                  {category.product_count} product
                  {category.product_count === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {shelf.length ? (
        <section aria-labelledby="shelf-heading">
          <div className="sf-section-head">
            <div>
              <h2 id="shelf-heading">
                {featuredAreCurated ? "Recently added" : "More from the shop"}
              </h2>
              <p>
                {featuredAreCurated
                  ? "The newest lines in the catalogue."
                  : "Everything the store has published, newest first."}
              </p>
            </div>
            <Link className="sf-link" href="/shop">
              See all <ArrowRightIcon size={14} />
            </Link>
          </div>
          <div className="sf-shelf">
            {shelf.map((product) => (
              <ShelfItem key={product.product_id} product={product} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="sf-band" aria-label="How the shop works">
        <div>
          <h3>Stock you can trust</h3>
          <p>
            Availability is read from the ERP when the page loads, and again
            when you add something to the cart.
          </p>
        </div>
        <div>
          <h3>Held while you decide</h3>
          <p>
            Items sit in a 15-minute hold, so two people cannot buy the last one
            at the same time.
          </p>
        </div>
        <div>
          <h3>Your order, findable</h3>
          <p>
            Track any order with its number and the email you used — no account
            needed, though one keeps your history in place.
          </p>
        </div>
      </section>
    </main>
  );
}
