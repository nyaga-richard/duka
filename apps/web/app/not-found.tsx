import Link from "next/link";
import { Brand } from "@/components/Brand";

export default function NotFound() {
  return (
    <main className="shop-main" style={{ maxWidth: 620, paddingTop: 60 }}>
      <Link href="/" style={{ display: "inline-block", marginBottom: 22 }}>
        <Brand />
      </Link>
      <div className="card">
        <div className="empty" style={{ padding: "52px 24px" }}>
          <h2>We can’t find that page</h2>
          <p>The link is out of date, or the page has moved.</p>
          <Link className="btn primary" href="/" style={{ marginTop: 6 }}>
            Back to the shop
          </Link>
        </div>
      </div>
    </main>
  );
}
