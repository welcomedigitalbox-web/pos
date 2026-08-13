"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "./store-context";
import { useAuth } from "./auth-context";
import { useLanguage } from "./language-context";
import { PAGE_OPTIONS, GROUP_LABELS, PageGroup, hasPermission } from "./permissions";

export default function Nav() {
  const pathname = usePathname();
  const { storeId, setStoreId, stores, isStoreLocked } = useStore();
  const { profile, signOut } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const [openGroup, setOpenGroup] = useState<PageGroup | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpenGroup(null);
  }, [pathname]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (pathname === "/login" || !profile) return null;

  const groups: PageGroup[] = ["sale", "inventory", "reports"];
  const groupedPages = groups
    .map((g) => ({
      group: g,
      pages: PAGE_OPTIONS.filter((p) => p.group === g && hasPermission(profile, p.key)),
    }))
    .filter((g) => g.pages.length > 0);

  const activePage = PAGE_OPTIONS.find((p) => p.href === pathname);

  return (
    <div ref={navRef} className="sticky top-0 z-20 bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-lg">🛒 {t("appName")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {isStoreLocked ? (
            <span className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm bg-slate-50 text-slate-600">
              🔒 {stores.find((s) => s.id === storeId)?.name || storeId}
            </span>
          ) : (
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
          )}

          <div className="flex border border-slate-200 rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => setLang("my")}
              className={`px-2 py-1.5 ${lang === "my" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
            >
              မြန်မာ
            </button>
            <button
              onClick={() => setLang("en")}
              className={`px-2 py-1.5 ${lang === "en" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
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

      <div className="max-w-6xl mx-auto px-4 flex flex-wrap gap-1 relative">
        {groupedPages.map(({ group, pages }) => {
          const isGroupActive = pages.some((p) => p.href === pathname);
          const singlePage = pages.length === 1 ? pages[0] : null;

          if (singlePage) {
            return (
              <Link
                key={group}
                href={singlePage.href}
                className={`px-3 sm:px-4 py-2 text-sm rounded-t-lg whitespace-nowrap ${
                  isGroupActive ? "bg-slate-50 text-blue-600 font-semibold" : "text-slate-500"
                }`}
              >
                {t(singlePage.labelKey as any)}
              </Link>
            );
          }

          return (
            <div key={group} className="relative">
              <button
                onClick={() => setOpenGroup(openGroup === group ? null : group)}
                className={`px-3 sm:px-4 py-2 text-sm rounded-t-lg whitespace-nowrap flex items-center gap-1 ${
                  isGroupActive ? "bg-slate-50 text-blue-600 font-semibold" : "text-slate-500"
                }`}
              >
                {t(GROUP_LABELS[group] as any)}
                <span className="text-[10px]">{openGroup === group ? "▲" : "▼"}</span>
              </button>
              {openGroup === group && (
                <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[160px] z-30">
                  {pages.map((p) => (
                    <Link
                      key={p.href}
                      href={p.href}
                      className={`block px-4 py-2 text-sm whitespace-nowrap hover:bg-slate-50 ${
                        pathname === p.href ? "text-blue-600 font-semibold" : "text-slate-600"
                      }`}
                    >
                      {t(p.labelKey as any)}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {profile.role === "admin" && (
          <Link
            href="/admin/users"
            className={`px-3 sm:px-4 py-2 text-sm rounded-t-lg whitespace-nowrap ${
              pathname.startsWith("/admin") ? "bg-slate-50 text-blue-600 font-semibold" : "text-slate-500"
            }`}
          >
            {t("nav_admin")}
          </Link>
        )}
      </div>
    </div>
  );
}
