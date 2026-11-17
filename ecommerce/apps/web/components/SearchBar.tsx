/**
 * Catalogue search. A plain GET form, so it works before hydration and the
 * query lands in the URL (shareable, back-button friendly). Active filters ride
 * along as hidden fields so searching does not silently drop them.
 */
export function SearchBar({
  q = "",
  category,
  brand,
  sort,
  id = "search",
}: {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  id?: string;
}) {
  return (
    <form className="searchbar" action="/" method="get" role="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ opacity: 0.55, flex: "none" }}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        id={id}
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search products, brands or SKUs"
        aria-label="Search products"
        autoComplete="off"
      />
      {category ? <input type="hidden" name="category" value={category} /> : null}
      {brand ? <input type="hidden" name="brand" value={brand} /> : null}
      {sort ? <input type="hidden" name="sort" value={sort} /> : null}
      <button type="submit" className="button" style={{ padding: "0.35rem 0.8rem", fontSize: "0.85rem" }}>
        Search
      </button>
    </form>
  );
}
