"use client";

import { useRouter } from "next/navigation";

const OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "name", label: "Name A–Z" },
];

/**
 * Sort control that keeps the active search, category and brand filters. The
 * current filters arrive as props, so this component needs no `useSearchParams`
 * and no Suspense boundary.
 */
export function SortSelect({
  value,
  filters,
  basePath = "/shop",
}: {
  value: string;
  filters: Record<string, string | undefined>;
  basePath?: string;
}) {
  const router = useRouter();

  function change(next: string) {
    const search = new URLSearchParams();
    for (const [key, entry] of Object.entries(filters)) {
      if (key !== "sort" && key !== "page" && entry) search.set(key, entry);
    }
    if (next !== "newest") search.set("sort", next);
    const query = search.toString();
    router.push(query ? `${basePath}?${query}` : basePath, { scroll: false });
  }

  return (
    <select
      value={value}
      onChange={(event) => change(event.target.value)}
      aria-label="Sort products"
      title="Sort products"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
