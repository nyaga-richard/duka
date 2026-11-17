import { SearchIcon } from "@/components/icons";

/**
 * Catalogue search, drawn as the ERP's `.search-box`. A plain GET form, so it
 * works before hydration and the query lands in the URL (shareable, back-button
 * friendly). Active filters ride along as hidden fields so searching does not
 * silently drop them.
 */
export function SearchBar({
  q = "",
  category,
  brand,
  sort,
  id = "search",
  action = "/shop",
}: {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  id?: string;
  /** Where the catalogue lives; the landing page points its own box here too. */
  action?: string;
}) {
  return (
    <form className="search-box" action={action} method="get" role="search">
      <SearchIcon size={15} />
      <input
        id={id}
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search products, brands or SKUs"
        aria-label="Search products"
        autoComplete="off"
      />
      {category ? (
        <input type="hidden" name="category" value={category} />
      ) : null}
      {brand ? <input type="hidden" name="brand" value={brand} /> : null}
      {sort ? <input type="hidden" name="sort" value={sort} /> : null}
      <button type="submit" className="btn sm outline">
        Search
      </button>
    </form>
  );
}
