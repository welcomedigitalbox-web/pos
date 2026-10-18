"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Bell, Gift } from "lucide-react";
import { usePathname } from "next/navigation";
import { useStore } from "./store-context";
import { useAuth } from "./auth-context";
import { useLanguage } from "./language-context";
import { supabase } from "@/lib/supabase";
import { PAGE_OPTIONS, GROUP_LABELS, PageGroup, hasPermission } from "./permissions";
import { APP_URL, canAccess, type AppKey } from "@/lib/apps";

type DeptKey = PageGroup | "admin";

const DEPARTMENTS: { key: DeptKey; icon: string; labelKey: string }[] = [
  { key: "sale", icon: "🛒", labelKey: "dept_sale" },
  { key: "customer", icon: "👥", labelKey: "dept_customer" },
  { key: "inventory", icon: "📦", labelKey: "dept_inventory" },
  { key: "warehouse", icon: "🏭", labelKey: "dept_warehouse" },
  { key: "merchandising", icon: "🏷️", labelKey: "dept_merchandising" },
  { key: "reports", icon: "📊", labelKey: "dept_reports" },
  { key: "setup", icon: "🧰", labelKey: "dept_setup" },
  { key: "admin", icon: "⚙️", labelKey: "nav_admin" },
  { key: "ai-agent", icon: "🤖", labelKey: "dept_aiAgent" },
  { key: "profile", icon: "👤", labelKey: "dept_profile" },
];

// The other Edu Baby House apps. They sign in off the same session, so these
// are plain links — no second login on the way over. Each only shows for
// someone whose department covers it, since landing on a "no access" page is
// a worse answer than never seeing the icon.
const SIBLING_APPS: { key: AppKey; icon: string; labelKey: string }[] = [
  { key: "onlineorder", icon: "\u{1F4AC}", labelKey: "dept_onlineOrder" },
  { key: "report", icon: "\u{1F4DD}", labelKey: "dept_dailyReport" },
  { key: "finance", icon: "\u{1F4B0}", labelKey: "dept_finance" },
];

// How many things are sitting there waiting for this person to sign them off.
// Managers were opening five screens to find out; now the number follows them
// around and a click goes straight to the list.
function ApprovalBell() {
  const [count, setCount] = useState(0);
  const { profile } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (!profile) return;
    let live = true;

    async function tally() {
      const may = await Promise.all(
        (["merchandising", "sale", "warehouse"] as const).map((d) =>
          supabase.rpc("can_approve_dept", { p_department: d }).then(({ data }) => !!data)
        )
      );
      const [merch, sale, wh] = may;
      const { data: dmg } = await supabase.rpc("can_approve_damage");

      // Counting only: head:true asks the database for the number and sends
      // no rows back, so this can run on every page without costing anything.
      const head = { count: "exact" as const, head: true };
      const parts = await Promise.all([
        merch
          ? supabase.from("purchase_orders").select("id", head).eq("status", "draft")
          : null,
        sale
          ? supabase.from("sale_returns").select("id", head).eq("status", "pending")
          : null,
        wh
          ? supabase.from("stock_requests").select("id", head).eq("status", "pending")
          : null,
        dmg
          ? supabase.from("stock_damages").select("id", head).eq("status", "pending")
          : null,
        wh
          ? supabase
              .from("stock_transfers")
              .select("id", head)
              .in("status", ["pending_approval", "discrepancy"])
          : null,
      ]);

      if (live) setCount(parts.reduce((t2, r) => t2 + (r?.count || 0), 0));
    }

    tally();
    const t = setInterval(tally, 60000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [profile?.id, pathname]);

  if (count === 0) return null;

  return (
    <Link
      href="/approvals"
      title="Waiting for your approval"
      aria-label={`${count} waiting for your approval`}
      className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 text-slate-600 hover:border-amber-300 hover:text-amber-700 transition"
    >
      <Bell size={17} strokeWidth={1.75} />
      <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none">
        {count > 99 ? "99+" : count}
      </span>
    </Link>
  );
}

// Free goods from a finished promotion are still out in the shops until
// somebody brings them back, so the reminder sits next to the approvals.
function FocBell() {
  const [count, setCount] = useState(0);
  const { profile } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (!profile) return;
    let live = true;

    async function tally() {
      const { data } = await supabase.rpc("promo_foc_pending_count");
      if (live) setCount(Number(data || 0));
    }

    tally();
    const t = setInterval(tally, 300000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [profile?.id, pathname]);

  if (count === 0) return null;

  return (
    <Link
      href="/promo-reclaim"
      title="Promotion ended - free stock still in the shops"
      aria-label={`${count} promotion(s) with free stock to collect`}
      className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-700 transition"
    >
      <Gift size={17} strokeWidth={1.75} />
      <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-purple-500 text-white text-[10px] font-bold leading-none">
        {count > 99 ? "99+" : count}
      </span>
    </Link>
  );
}

export default function Nav() {
  const pathname = usePathname();
  const { storeId, setStoreId, stores, isStoreLocked } = useStore();
  const { profile, signOut } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  if (pathname === "/login" || !profile) return null;

  const activePage = PAGE_OPTIONS.find((p) => p.href === pathname);
  // A detail screen such as /products/<id>/edit is not in the list, so the
  // trail falls back to the longest page whose address it starts with.
  const trailPage =
    activePage ||
    PAGE_OPTIONS.filter((p) => p.href !== "/" && pathname.startsWith(p.href + "/")).sort(
      (a2, b2) => b2.href.length - a2.href.length
    )[0];
  let activeDept: DeptKey | null = (trailPage?.group as DeptKey) || null;
  if (pathname.startsWith("/admin")) activeDept = "admin";

  const visibleDepartments = DEPARTMENTS.filter((d) => {
    if (d.key === "admin") return profile.role === "admin";
    return PAGE_OPTIONS.some((p) => p.group === d.key && hasPermission(profile, p.key));
  });

  const visibleApps = SIBLING_APPS.filter((a) => canAccess(a.key, profile));

  function deptHref(deptKey: DeptKey): string {
    if (deptKey === "admin") return "/admin/users";
    const firstPage = PAGE_OPTIONS.find((p) => p.group === deptKey && hasPermission(profile, p.key));
    return firstPage?.href || "/";
  }

  const subPages =
    activeDept && activeDept !== "admin"
      ? PAGE_OPTIONS.filter((p) => p.group === activeDept && hasPermission(profile, p.key))
      : [];

  // Which branch you are working in decides what every page shows and where
  // a sale lands, so it belongs on screen everywhere, not only on the home
  // page. A cashier could not see which shop the till was ringing up.
  const showStoreSelector = true;

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

        {visibleApps.length > 0 && (
          <div className="w-10 border-t border-slate-200 my-1.5 shrink-0" />
        )}
        {visibleApps.map((a) => (
          <a
            key={a.key}
            href={APP_URL[a.key]}
            className="w-16 flex flex-col items-center py-2 rounded-lg text-xs shrink-0 text-slate-500 hover:bg-slate-50"
          >
            <span className="text-xl">{a.icon}</span>
            <span className="mt-0.5 text-[10px] leading-tight text-center px-0.5">
              {t(a.labelKey as any)}
            </span>
          </a>
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
              <Link href="/" className="font-semibold text-base sm:text-lg truncate hover:text-blue-600">
                {t("appName")}
              </Link>
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
                    {!storeId && <option value="">{t("store_choose")}</option>}
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.is_warehouse ? "\u{1F3ED} " : ""}{s.name}
                      </option>
                    ))}
                  </select>
                ))}

              <ApprovalBell />
              <FocBell />

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

          {/* Where you are. Staff were landing on a sub-page from a link and
              had no idea which part of the system they were in. */}
          {pathname !== "/" && (trailPage || activeDept) && (
            <div className="px-3 sm:px-4 pb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
              <Link href="/" className="hover:text-slate-600">
                {t("nav_home")}
              </Link>
              {activeDept && activeDept !== "admin" && (
                <>
                  <span>/</span>
                  <Link href={deptHref(activeDept)} className="hover:text-slate-600">
                    {t(GROUP_LABELS[activeDept as PageGroup] as never)}
                  </Link>
                </>
              )}
              {activeDept === "admin" && (
                <>
                  <span>/</span>
                  <span>{t("nav_admin")}</span>
                </>
              )}
              {trailPage && (
                <>
                  <span>/</span>
                  <span className="text-slate-600 font-medium">
                    {t(trailPage.labelKey as never)}
                  </span>
                </>
              )}
              {!activePage && trailPage && (
                <>
                  <span>/</span>
                  <span className="text-slate-600 font-medium">
                    {pathname.endsWith("/edit") ? "Edit" : pathname.endsWith("/new") ? "New" : "Detail"}
                  </span>
                </>
              )}
            </div>
          )}

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
                { href: "/admin/org", label: "Organization" },
                { href: "/admin/uoms", label: "Units" },
                { href: "/admin/role-pages", label: "Role Pages" },
                { href: "/admin/acting", label: "Acting" },
                { href: "/admin/stores", label: t("admin_stores_title") },
                { href: "/admin/settings", label: t("admin_settings_title") },
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
