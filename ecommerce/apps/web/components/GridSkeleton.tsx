/** Catalogue placeholder: same box model as `.product-tile`, so nothing jumps. */
export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="product-tile" key={index}>
          <div className="skeleton skeleton-media" />
          <div className="product-tile-copy">
            <div
              className="skeleton"
              style={{ width: "38%", height: 8, marginBottom: 8 }}
            />
            <div
              className="skeleton"
              style={{ width: "78%", marginBottom: 6 }}
            />
            <div className="skeleton" style={{ width: "52%" }} />
            <div className="tile-foot">
              <div className="skeleton" style={{ width: 64 }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
