import Link from "next/link";
import { redirect } from "next/navigation";
import { ProductCard } from "@/components/ProductCard";
import { SearchBar } from "@/components/SearchBar";
import { ArrowRightIcon } from "@/components/icons";
import {
  listCategories,
  listFeatured,
  listProducts,
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
 * the categories it sells in, and the products the store chose to feature from
 * the desk — then hands over to `/shop` for the full catalogue. Old links that
 * carry filters are redirected rather than dropped.
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
    listProducts("?limit=4&sort=newest"),
  ]);

  const stocked = categories
    .filter((category) => category.product_count > 0)
    .slice(0, 8);
  const inStock = featured.filter((product) => stockOf(product) > 0).length;
  const featuredAreCurated = featured.some((product) => product.featured);

  // Nothing published at all: say so once, honestly, instead of an empty grid.
  if (!featured.length && !stocked.length) {
    return (
      <main>
        <section className="home-hero">
          <div className="home-hero-copy">
            <span className="eyebrow">Duka storefront</span>
            <h1>The shop is being stocked</h1>
            <p>
              No products are published yet. Once the catalogue is in, the
              featured products chosen in the store desk appear here.
            </p>
            <div className="hero-actions">
              <Link className="btn primary" href="/admin">
                Open the store desk
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="eyebrow">Duka storefront</span>
          <h1>
            Everyday things, <br />
            straight from the shop floor.
          </h1>
          <p>
            Prices and stock come from the ERP, so what you see is what the shop
            has. Adding something to your cart holds it for 15 minutes while you
            check out, and delivery is arranged with you afterwards.
          </p>
          <div className="hero-actions">
            <Link className="btn primary lg" href="/shop">
              Shop all products
            </Link>
            <Link className="btn secondary lg" href="/orders">
              Track an order
            </Link>
          </div>
          <div className="hero-points">
            <span className="badge ok">
              <span className="status-dot" />
              Live ERP stock
            </span>
            <span className="badge">15-minute hold</span>
            <span className="badge">Pay on delivery</span>
          </div>
        </div>

        <div className="home-hero-side">
          <label className="eyebrow" htmlFor="home-search">
            Search everything
          </label>
          <SearchBar action="/shop" id="home-search" />
          <dl className="home-facts">
            <div>
              <dt>Categories</dt>
              <dd>{stocked.length || "—"}</dd>
            </div>
            <div>
              <dt>Featured now</dt>
              <dd>{featured.length}</dd>
            </div>
            <div>
              <dt>Ready to ship</dt>
              <dd>{inStock}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="home-section" aria-labelledby="featured-heading">
        <div className="shop-section-head">
          <div>
            <h2 id="featured-heading">
              {featuredAreCurated ? "Featured products" : "New in the shop"}
            </h2>
            <p>
              {featuredAreCurated
                ? "Picked by the store and set in the desk."
                : "Nothing is featured yet — these are the newest products."}
            </p>
          </div>
          <Link className="btn ghost sm" href="/shop">
            Shop all <ArrowRightIcon size={13} />
          </Link>
        </div>
        <div className="product-grid">
          {featured.map((product) => (
            <ProductCard key={product.product_id} product={product} />
          ))}
        </div>
      </section>

      {stocked.length ? (
        <section className="home-section" aria-labelledby="categories-heading">
          <div className="shop-section-head">
            <div>
              <h2 id="categories-heading">Browse by category</h2>
              <p>
                Every published product, grouped the way the shop groups it.
              </p>
            </div>
          </div>
          <div className="home-categories">
            {stocked.map((category: Category) => (
              <Link
                key={category.category_id}
                className="home-category"
                href={`/shop?category=${encodeURIComponent(category.slug)}`}
              >
                <strong>{category.category_name}</strong>
                <span className="muted tiny">
                  {category.product_count} product
                  {category.product_count === 1 ? "" : "s"}
                </span>
                <ArrowRightIcon size={13} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {featuredAreCurated && newest.length ? (
        <section className="home-section" aria-labelledby="new-heading">
          <div className="shop-section-head">
            <div>
              <h2 id="new-heading">Recently added</h2>
              <p>The newest lines in the catalogue.</p>
            </div>
          </div>
          <div className="product-grid">
            {newest.map((product) => (
              <ProductCard key={product.product_id} product={product} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="home-promises">
        <div className="home-promise">
          <strong>Stock you can trust</strong>
          <p>
            Availability is read from the ERP when the page loads, and again
            when you add something to the cart.
          </p>
        </div>
        <div className="home-promise">
          <strong>Held while you decide</strong>
          <p>
            Items sit in a 15-minute hold, so two people cannot buy the last one
            at the same time.
          </p>
        </div>
        <div className="home-promise">
          <strong>Your order, findable</strong>
          <p>
            Track any order with its number and the email you used — no account
            needed, though one keeps your history in place.
          </p>
        </div>
      </section>
    </main>
  );
}
