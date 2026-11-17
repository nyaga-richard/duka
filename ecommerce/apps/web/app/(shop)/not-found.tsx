import Link from "next/link";

export default function ShopNotFound() {
  return (
    <div className="card">
      <div className="empty" style={{ padding: "52px 24px" }}>
        <h2>We can’t find that page</h2>
        <p>
          The product may have been unpublished, or the link is out of date.
        </p>
        <Link className="btn primary" href="/" style={{ marginTop: 6 }}>
          Back to the shop
        </Link>
      </div>
    </div>
  );
}
