import type { Metadata } from "next";
import "./globals.css";
import Nav from "./nav";
import { StoreProvider } from "./store-context";
import { AuthProvider } from "./auth-context";
import { LanguageProvider } from "./language-context";

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
        <LanguageProvider>
          <AuthProvider>
            <StoreProvider>
              <Nav />
              <main className="sm:ml-20 w-full px-4 sm:px-6 pb-16">{children}</main>
            </StoreProvider>
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
