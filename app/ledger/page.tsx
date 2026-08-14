"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, CENTRAL_WAREHOUSE_ID, SellableItem, fetchSellableItems } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " MMK";
}

type Row = SellableItem & {
  soldQty: number;
  salesValue: number;
  salesShare: number;    // this product's share of total sales in the period
  cogs: number;
  gp: number;
  gpMargin: number;      // GP as % of sales
  sellThrough: number;   // sold in period / (sold in period + on hand)
  avgDaily: number;      // average units sold per day in the period
  coverDays: number | null;  // how many more days current stock lasts
  suggestedReorder: number;  // qty needed to reach the cover target
  stockValue: number;
  rank: number;
};

type MovementRow = { date: string; type: string; qty: number; balance: number; reference: string };
type SortKey = "sold" | "share" | "gp" | "margin" | "stock" | "cover" | "name";
type PeriodKey = "today" | "this_month" | "last_month" | "this_year" | "all" | "custom";

// Resolve a preset into a concrete range plus the number of days it spans,
// so the daily-average maths stays honest for part-finished periods.
function resolvePeriod(
  key: PeriodKey,
  customFrom?: string,
  customTo?: string
): { from: Date | null; to: Date | null; days: number | null } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 86400000;
  switch (key) {
    case "today":
      return { from: startOfToday, to: now, days: 1 };
    case "this_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: now, days: Math.max(1, Math.ceil((now.getTime() - from.getTime()) / dayMs)) };
    }
    case "last_month": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, -1);
      return { from, to, days: Math.max(1, Math.round((to.getTime() - from.getTime()) / dayMs)) };
    }
    case "this_year": {
      const from = new Date(now.getFullYear(), 0, 1);
      return { from, to: now, days: Math.max(1, Math.ceil((now.getTime() - from.getTime()) / dayMs)) };
    }
    case "custom": {
      if (!customFrom && !customTo) return { from: null, to: null, days: null };
      const from = customFrom ? new Date(customFrom) : new Date(0);
      // include the whole "to" day
      const to = customTo ? new Date(new Date(customTo).getTime() + dayMs - 1) : now;
      return { from, to, days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / dayMs)) };
    }
    default:
      return { from: null, to: null, days: null };
  }
}

// How many days of stock we want on hand before a reorder is suggested
const COVER_TARGET_DAYS = 30;

function stockLevel(r: Row) {
  if (r.stock_qty <= 0) return { key: "out", color: "bg-red-100 text-red-700" };
  if (r.soldQty === 0) return { key: "healthy", color: "bg-green-100 text-green-700" };
  const pct = (r.stock_qty / r.soldQty) * 100;
  if (pct >= 50) return { key: "healthy", color: "bg-green-100 text-green-700" };
  if (pct >= 30) return { key: "warning", color: "bg-yellow-100 text-yellow-700" };
  return { key: "urgent", color: "bg-orange-100 text-orange-700" };
}

export default function LedgerPage() {
  const { stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [storeId, setStoreId] = useState(CENTRAL_WAREHOUSE_ID);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sold");
  const [period, setPeriod] = useState<PeriodKey>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [movLoading, setMovLoading] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "ledger")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    setExpandedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, period, customFrom, customTo]);

  if (!profile || !hasPermission(profile, "ledger")) return null;

  async function load() {
    setLoading(true);
    const items = await fetchSellableItems(storeId, true);

    const { from, to, days } = resolvePeriod(period, customFrom, customTo);

    let saleQuery = supabase
      .from("sale_items")
      .select("product_id, variant_id, qty, line_total, line_cogs, created_at, sales!inner(store_id)")
      .eq("sales.store_id", storeId);
    if (from) saleQuery = saleQuery.gte("created_at", from.toISOString());
    if (to) saleQuery = saleQuery.lte("created_at", to.toISOString());
    const { data: saleRows } = await saleQuery;

    const keyOf = (pid: string, vid: string | null) => `${pid}:${vid || "base"}`;
    const agg = new Map<string, { qty: number; total: number; cogs: number }>();
    for (const r of (saleRows as any[]) || []) {
      const k = keyOf(r.product_id, r.variant_id);
      const cur = agg.get(k) || { qty: 0, total: 0, cogs: 0 };
      cur.qty += Number(r.qty);
      cur.total += Number(r.line_total);
      cur.cogs += Number(r.line_cogs || 0);
      agg.set(k, cur);
    }

    // For "all time", measure against the span of actual sales rather than a fixed window
    let periodDays = days ?? 0;
    if (!days) {
      const dates = ((saleRows as any[]) || []).map((r) => new Date(r.created_at).getTime());
      periodDays = dates.length ? Math.max(1, Math.ceil((Date.now() - Math.min(...dates)) / 86400000)) : 0;
    }

    const periodSalesTotal = ((saleRows as any[]) || []).reduce((sum, r) => sum + Number(r.line_total), 0);

    const built = items.map((i) => {
      const a = agg.get(keyOf(i.product_id, i.variant_id)) || { qty: 0, total: 0, cogs: 0 };
      const gp = a.total - a.cogs;
      const denom = a.qty + i.stock_qty;
      const avgDaily = periodDays > 0 ? a.qty / periodDays : 0;
      const coverDays = avgDaily > 0 ? i.stock_qty / avgDaily : null;
      const suggestedReorder = Math.max(0, Math.ceil(avgDaily * COVER_TARGET_DAYS - i.stock_qty));
      return {
        avgDaily,
        coverDays,
        suggestedReorder,
        ...i,
        soldQty: a.qty,
        salesValue: a.total,
        cogs: a.cogs,
        gp,
        gpMargin: a.total > 0 ? (gp / a.total) * 100 : 0,
        sellThrough: denom > 0 ? (a.qty / denom) * 100 : 0,
        salesShare: periodSalesTotal > 0 ? (a.total / periodSalesTotal) * 100 : 0,
        stockValue: i.stock_qty * i.avg_cost,
        rank: 0,
      } as Row;
    });

    // Rank by units sold — 1 is the best seller
    built.sort((a, b) => b.soldQty - a.soldQty);
    built.forEach((r, idx) => (r.rank = idx + 1));

    setRows(built);
    setLoading(false);
  }

  async function toggleMovements(r: Row) {
    if (expandedKey === r.key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(r.key);
    setMovLoading(true);

    const scope = <T extends { eq: any; is: any }>(q: T) =>
      r.variant_id ? q.eq("variant_id", r.variant_id) : q.is("variant_id", null);

    const { data: purchases } = await scope(
      supabase.from("stock_purchases").select("qty, created_at, supplier, received_by")
        .eq("product_id", r.product_id).eq("store_id", storeId)
    ).order("created_at", { ascending: true });

    const { data: sales } = await scope(
      supabase.from("sale_items").select("qty, created_at, sale_id, sales!inner(store_id)")
        .eq("product_id", r.product_id).eq("sales.store_id", storeId)
    ).order("created_at", { ascending: true });

    const { data: damages } = await scope(
      supabase.from("stock_damages").select("qty, created_at, reason")
        .eq("product_id", r.product_id).eq("store_id", storeId)
    ).order("created_at", { ascending: true });

    const { data: transfers } = await scope(
      supabase.from("stock_transfers").select("qty, received_qty, created_at, to_store_id, status")
        .eq("product_id", r.product_id)
    ).order("created_at", { ascending: true });

    const isWarehouse = storeId === CENTRAL_WAREHOUSE_ID;
    const combined = [
      ...(purchases || []).map((p: any) => ({
        date: p.created_at, type: "in", qty: Number(p.qty),
        reference: [p.supplier ? `Stock-in (${p.supplier})` : "Stock-in", p.received_by ? `· ${p.received_by}` : ""].filter(Boolean).join(" "),
      })),
      ...(sales || []).map((s: any) => ({
        date: s.created_at, type: "out", qty: Number(s.qty),
        reference: `Sale #${s.sale_id.slice(0, 8).toUpperCase()}`,
      })),
      ...(damages || []).map((d: any) => ({
        date: d.created_at, type: "damage", qty: Number(d.qty),
        reference: d.reason ? `Damage (${d.reason})` : "Damage",
      })),
      ...(transfers || [])
        .filter((tr: any) => (isWarehouse ? true : tr.to_store_id === storeId))
        .filter((tr: any) => (isWarehouse ? true : tr.status !== "in_transit"))
        .map((tr: any) => ({
          date: tr.created_at,
          type: isWarehouse ? "out" : "in",
          qty: isWarehouse ? Number(tr.qty) : Number(tr.received_qty ?? tr.qty),
          reference: isWarehouse ? `Transfer → ${tr.to_store_id}` : "Transfer in",
        })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    setMovements(
      combined
        .map((m) => {
          balance += m.type === "in" ? m.qty : -m.qty;
          return { ...m, balance };
        })
        .reverse()
    );
    setMovLoading(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? rows.filter((r) => r.display_name.toLowerCase().includes(q) || (r.sku || "").toLowerCase().includes(q))
      : rows;
    return [...list].sort((a, b) => {
      if (sortKey === "share") return b.salesShare - a.salesShare;
      if (sortKey === "gp") return b.gp - a.gp;
      if (sortKey === "margin") return b.gpMargin - a.gpMargin;
      if (sortKey === "stock") return b.stock_qty - a.stock_qty;
      // Lowest cover first — those are the ones about to run out
      if (sortKey === "cover") return (a.coverDays ?? Infinity) - (b.coverDays ?? Infinity);
      if (sortKey === "name") return a.display_name.localeCompare(b.display_name);
      return b.soldQty - a.soldQty;
    });
  }, [rows, search, sortKey]);

  const totals = useMemo(
    () => ({
      sold: filtered.reduce((s, r) => s + r.soldQty, 0),
      sales: filtered.reduce((s, r) => s + r.salesValue, 0),
      gp: filtered.reduce((s, r) => s + r.gp, 0),
      stockValue: filtered.reduce((s, r) => s + r.stockValue, 0),
    }),
    [filtered]
  );
  const overallMargin = totals.sales > 0 ? (totals.gp / totals.sales) * 100 : 0;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("ledger_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("ledger_perfSubtitle")}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.is_warehouse ? `🏭 ${s.name}` : s.name}</option>
          ))}
        </select>

        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
          <option value="today">{t("ledger_periodToday")}</option>
          <option value="this_month">{t("ledger_periodThisMonth")}</option>
          <option value="last_month">{t("ledger_periodLastMonth")}</option>
          <option value="this_year">{t("ledger_periodThisYear")}</option>
          <option value="all">{t("ledger_periodAll")}</option>
          <option value="custom">{t("ledger_periodCustom")}</option>
        </select>

        {period === "custom" && (
          <>
            <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span className="self-center text-slate-400 text-sm">→</span>
            <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </>
        )}

        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="sold">{t("ledger_sortSold")}</option>
          <option value="share">{t("ledger_sortShare")}</option>
          <option value="gp">{t("ledger_sortGp")}</option>
          <option value="margin">{t("ledger_sortMargin")}</option>
          <option value="stock">{t("ledger_sortStock")}</option>
          <option value="cover">{t("ledger_sortCover")}</option>
          <option value="name">{t("warehouse_sortName")}</option>
        </select>

        <input className="flex-1 min-w-[200px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("ledger_searchPlaceholder")}
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_products")}</div>
          <div className="text-xl font-bold mt-1">{filtered.length}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("ledger_unitsSold")}</div>
          <div className="text-xl font-bold mt-1">{totals.sold.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("barcode_totalSale")}</div>
          <div className="text-lg font-bold mt-1">{fmt(totals.sales)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("dashboard_gp")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(totals.gp)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("dashboard_gpMargin")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{overallMargin.toFixed(1)}%</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[1440px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">#</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("ledger_unitsSold")}</th>
              <th className="text-left px-3 py-2">{t("ledger_sellThrough")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("ledger_coverDays")}</th>
              <th className="text-left px-3 py-2">{t("ledger_suggestReorder")}</th>
              <th className="text-left px-3 py-2">{t("ledger_stockLevel")}</th>
              <th className="text-left px-3 py-2">{t("barcode_totalSale")}</th>
              <th className="text-left px-3 py-2">{t("ledger_salesShare")}</th>
              <th className="text-left px-3 py-2">{t("dashboard_gp")}</th>
              <th className="text-left px-3 py-2">{t("dashboard_gpMargin")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={14} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((r) => {
              const lvl = stockLevel(r);
              const open = expandedKey === r.key;
              return (
                <>
                  <tr key={r.key} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-400">{r.rank}</td>
                    <td className="px-3 py-2">{r.display_name}</td>
                    <td className="px-3 py-2 text-slate-400">{r.sku || "-"}</td>
                    <td className="px-3 py-2 font-medium">{r.soldQty.toLocaleString()}</td>
                    <td className="px-3 py-2">{r.sellThrough.toFixed(0)}%</td>
                    <td className={`px-3 py-2 font-medium ${r.stock_qty <= 0 ? "text-red-600" : ""}`}>
                      {r.stock_qty.toLocaleString()}
                    </td>
                    <td className={`px-3 py-2 ${
                      r.coverDays !== null && r.coverDays < 14 ? "text-red-600 font-medium" : "text-slate-500"
                    }`}>
                      {r.coverDays === null ? "-" : `${Math.floor(r.coverDays)}${t("ledger_daysUnit")}`}
                    </td>
                    <td className={`px-3 py-2 font-medium ${r.suggestedReorder > 0 ? "text-orange-600" : "text-slate-300"}`}>
                      {r.suggestedReorder > 0 ? `+${r.suggestedReorder.toLocaleString()}` : "-"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${lvl.color}`}>
                        {t(`warehouse_${lvl.key === "out" ? "outOfStock" : lvl.key}` as any)}
                      </span>
                    </td>
                    <td className="px-3 py-2">{fmt(r.salesValue)}</td>
                    <td className="px-3 py-2">
                      {r.salesShare > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <div className="w-12 h-1.5 bg-slate-100 rounded overflow-hidden">
                            <div className="h-full bg-blue-500" style={{ width: `${Math.min(r.salesShare, 100)}%` }} />
                          </div>
                          <span className="text-xs">{r.salesShare.toFixed(1)}%</span>
                        </div>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                    <td className={`px-3 py-2 font-medium ${r.gp >= 0 ? "text-green-700" : "text-red-600"}`}>
                      {fmt(r.gp)}
                    </td>
                    <td className="px-3 py-2">{r.salesValue > 0 ? `${r.gpMargin.toFixed(1)}%` : "-"}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => toggleMovements(r)} className="text-blue-600 text-xs font-medium">
                        {open ? t("ledger_hideMovement") : t("ledger_showMovement")}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr key={`${r.key}-mov`} className="bg-slate-50">
                      <td colSpan={14} className="px-3 py-3">
                        {movLoading ? (
                          <div className="text-slate-400 text-center py-3">...</div>
                        ) : movements.length === 0 ? (
                          <div className="text-slate-400 text-center py-3">{t("ledger_empty")}</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead className="text-slate-500">
                              <tr>
                                <th className="text-left px-2 py-1">{t("ledger_date")}</th>
                                <th className="text-left px-2 py-1">{t("ledger_type")}</th>
                                <th className="text-left px-2 py-1">{t("ledger_qty")}</th>
                                <th className="text-left px-2 py-1">{t("ledger_balance")}</th>
                                <th className="text-left px-2 py-1">{t("ledger_reference")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {movements.map((m, idx) => (
                                <tr key={idx} className="border-t border-slate-200">
                                  <td className="px-2 py-1">{new Date(m.date).toLocaleString()}</td>
                                  <td className="px-2 py-1">
                                    <span className={`px-1.5 py-0.5 rounded font-medium ${
                                      m.type === "in" ? "bg-green-100 text-green-700"
                                      : m.type === "damage" ? "bg-red-100 text-red-700"
                                      : "bg-slate-200 text-slate-600"}`}>
                                      {m.type === "in" ? t("ledger_in") : m.type === "damage" ? t("nav_damage") : t("ledger_out")}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1">{m.type === "in" ? "+" : "-"}{m.qty}</td>
                                  <td className="px-2 py-1 font-medium">{m.balance}</td>
                                  <td className="px-2 py-1 text-slate-500">{m.reference}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={14} className="text-center text-slate-400 py-8">{t("warehouse_empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
