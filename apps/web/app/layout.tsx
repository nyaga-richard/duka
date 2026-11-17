import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";
import "./storefront.css";

export const metadata: Metadata = {
  title: { default: "Duka — shop", template: "%s · Duka" },
  description:
    "Duka storefront: catalogue, cart and checkout, synced with the Duka ERP.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8f6" },
    { media: "(prefers-color-scheme: dark)", color: "#14201c" },
  ],
};

/* Runs before first paint: an explicit choice wins, otherwise CSS follows the
   OS preference. Kept inline so a dark-mode user never sees a white flash. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("duka-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
