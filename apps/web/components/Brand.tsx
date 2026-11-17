/**
 * The wordmark, drawn exactly as the ERP draws it (`duka.` in Inter with tight
 * tracking) so the shop and the back office share one identity. `onDark` is for
 * the dark-green sidebar and the sign-in story panel.
 */
export function Brand({
  onDark = false,
  label = "shop",
}: {
  onDark?: boolean;
  label?: string;
}) {
  return (
    <span className={`brand ${onDark ? "brand--on-dark" : ""}`}>
      <span>
        duka<span className="brand-dot">.</span>
      </span>
      <small>{label}</small>
    </span>
  );
}
