/** Catalogue placeholder: same box model as the real cards, so nothing jumps. */
export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="card" key={index}>
          <div className="skeleton media" style={{ borderRadius: 0 }} />
          <div style={{ padding: "0.85rem 0.95rem 1rem" }}>
            <div className="skeleton line" style={{ width: "70%", marginBottom: "0.5rem" }} />
            <div className="skeleton line" style={{ width: "45%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
