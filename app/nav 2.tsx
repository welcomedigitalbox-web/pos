"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "./store-context";
import { useAuth } from "./auth-context";
import { useLanguage } from "./language-context";
import { PAGE_OPTIONS, PageGroup, hasPermission } from "./permissions";

type DeptKey = PageGroup | "admin";

const DEPARTMENTS: { key: DeptKey; icon: string; labelKey: string }[] = [
  { key: "sale", icon: "🛒", labelKey: "dept_sale" },
  { key: "inventory", icon: "📦", labelKey: "dept_inventory" },
  { key: "warehouse", icon: "🏭", labelKey: "dept_warehouse" },
  { key: "merchandising", icon: "🏷️", labelKey: "dept_merchandising" },
  { key: "reports", icon: "📊", labelKey: "dept_reports" },
  { key: "admin", icon: "⚙️", labelKey: "nav_admin" },
  { key: "ai-agent", icon: "🤖", labelKey: "dept_aiAgent" },
  { key: "profile", icon: "👤", labelKey: "dept_profile" },
];

export default function Nav() {
  const pathname = usePathname();
  const { storeId, setStoreId, stores, isStoreLocked } = useStore();
  const { profile, signOut } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  if (pathname === "/login" || !profile) return null;

  const activePage = PAGE_OPTIONS.find((p) => p.href === pathname);
  let activeDept: DeptKey | null = (activePage?.group as DeptKey) || null;
  if (pathname.startsWith("/admin")) activeDept = "admin";

  const visibleDepartments = DEPARTMENTS.filter((d) => {
    if (d.key === "admin") return profile.role === "admin";
    return PAGE_OPTIONS.some((p) => p.group === d.key && hasPermission(profile, p.key));
  });

  function deptHref(deptKey: DeptKey): string {
    if (deptKey === "admin") return "/admin/users";
    const firstPage = PAGE_OPTIONS.find((p) => p.group === deptKey && hasPermission(profile, p.key));
    return firstPage?.href || "/";
  }

  const subPages =
    activeDept && activeDept !== "admin"
      ? PAGE_OPTIONS.filter((p) => p.group === activeDept && hasPermission(profile, p.key))
      : [];

  const showStoreSelector = pathname === "/";

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/30 z-40 sm:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-screen z-50 sm:z-30 bg-white border-r border-slate-200 flex flex-col items-center py-3 gap-1 overflow-y-auto transition-transform duration-200 w-20 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full sm:translate-x-0"
        }`}
      >
        <div className="text-2xl mb-2">🛒</div>
        {visibleDepartments.map((d) => (
          <Link
            key={d.key}
            href={deptHref(d.key)}
            className={`w-16 flex flex-col items-center py-2 rounded-lg text-xs shrink-0 ${
              activeDept === d.key ? "bg-blue-50 text-blue-600 font-semibold" : "text-slate-500"
            }`}
          >
            <span className="text-xl">{d.icon}</span>
            <span className="mt-0.5 text-[10px] leading-tight text-center px-0.5">{t(d.labelKey as any)}</span>
          </Link>
        ))}
      </aside>

      {/* Top bar + sub-page header */}
      <div className="sm:ml-20">
        <div className="sticky top-0 z-20 bg-white border-b border-slate-200">
          <div className="px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button className="sm:hidden text-xl leading-none shrink-0" onClick={() => setMobileOpen(true)}>
                ☰
              </button>
              <h1 className="font-semibold text-base sm:text-lg truncate">{t("appName")}</h1>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {showStoreSelector &&
                (isStoreLocked ? (
                  <span className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm bg-slate-50 text-slate-600">
                    🔒 {stores.find((s) => s.id === storeId)?.name || storeId}
                  </span>
                ) : (
                  <select
                    className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
                    value={storeId}
                    onChange={(e) => setStoreId(e.target.value)}
                  >
                    {stores.filter((s) => !s.is_warehouse).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ))}

              <div className="hidden sm:flex border border-slate-200 rounded-lg overflow-hidden text-xs">
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
                className="hidden sm:inline-block text-xs text-slate-500 border border-slate-200 rounded-lg px-2 py-1.5"
              >
                {t("logout")}
              </button>
            </div>
          </div>

          {subPages.length > 0 && (
            <div className="px-3 sm:px-4 flex gap-1 overflow-x-auto scrollbar-none">
              {subPages.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  className={`px-3 py-2 text-sm whitespace-nowrap ${
                    pathname === p.href
                      ? "text-blue-600 font-semibold border-b-2 border-blue-600"
                      : "text-slate-500"
                  }`}
                >
                  {t(p.labelKey as any)}
                </Link>
              ))}
            </div>
          )}

          {activeDept === "admin" && (
            <div className="px-3 sm:px-4 flex gap-1 overflow-x-auto scrollbar-none">
              {[
                { href: "/admin/users", label: t("admin_users_title") },
                { href: "/admin/stores", label: t("admin_stores_title") },
                { href: "/admin/settings", label: t("admin_settings_title") },
                { href: "/admin/payment-methods", label: t("admin_paymentMethods_title") },
              ].map((tab) => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`px-3 py-2 text-sm whitespace-nowrap ${
                    pathname === tab.href
                      ? "text-blue-600 font-semibold border-b-2 border-blue-600"
                      : "text-slate-500"
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
