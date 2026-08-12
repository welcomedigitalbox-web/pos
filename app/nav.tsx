"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "./store-context";
import { useAuth } from "./auth-context";
import { useLanguage } from "./language-context";
import { PAGE_OPTIONS, hasPermission } from "./permissions";

export default function Nav() {
  const pathname = usePathname();
  const { storeId, setStoreId, stores } = useStore();
  const { profile, signOut } = useAuth();
  const { lang, setLang, t } = useLanguage();

  if (pathname === "/login" || !profile) return null;

  const tabs = PAGE_OPTIONS.filter((p) => hasPermission(profile, p.key)).map((p) => ({
    href: p.href,
    label: t(p.labelKey as any),
  }));

  if (profile.role === "admin") {
    tabs.push({ href: "/admin/users", label: t("nav_admin") });
  }

  return (
    <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-lg">🛒 {t("appName")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <div className="flex border border-slate-200 rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => setLang("my")}
              className={`px-2 py-1.5 ${
                lang === "my" ? "bg-blue-600 text-white" : "bg-white text-slate-500"
              }`}
            >
              မြန်မာ
            </button>
            <button
              onClick={() => setLang("en")}
              className={`px-2 py-1.5 ${
                lang === "en" ? "bg-blue-600 text-white" : "bg-white text-slate-500"
              }`}
            >
              EN
            </button>
          </div>

          <span className="text-xs text-slate-400 hidden md:inline">
            {profile.email} ({profile.role})
          </span>
          <button
            onClick={signOut}
            className="text-xs text-slate-500 border border-slate-200 rounded-lg px-2 py-1.5"
          >
            {t("logout")}
          </button>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 sm:px-4 py-2 text-sm rounded-t-lg whitespace-nowrap ${
              pathname === tab.href
                ? "bg-slate-50 text-blue-600 font-semibold"
                : "text-slate-500"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
