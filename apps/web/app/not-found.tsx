import Link from "next/link";

export default function NotFound() {
  return (
    <main className="narrow">
      <div className="empty">
        <h2>We can’t find that page</h2>
        <p>The product may have been unpublished, or the link is out of date.</p>
        <Link className="button" href="/">
          Back to the shop
        </Link>
      </div>
    </main>
  );
}
