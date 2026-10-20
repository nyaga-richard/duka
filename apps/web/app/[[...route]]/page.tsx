import { Suspense } from "react";
import App from "../../components/App";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <Suspense fallback={<div className="boot">Opening Duka…</div>}>
      <App />
    </Suspense>
  );
}
