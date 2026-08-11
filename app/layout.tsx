import type { Metadata } from "next";
import "./globals.css";
import Nav from "./nav";
import { StoreProvider } from "./store-context";

export const metadata: Metadata = {
  title: "POS MVP",
  description: "POS system for Edu Baby House",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900">
        <StoreProvider>
          <Nav />
          <main className="max-w-6xl mx-auto px-4 pb-16">{children}</main>
        </StoreProvider>
      </body>
    </html>
  );
}
