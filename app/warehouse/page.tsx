"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, SellableItem, fetchSellableItems } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type Row = SellableItem & {
  damagedQty: number;
  inTransitQty: number;
  stockValue: number;
  nearestExpiry: string | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
};

type SortKey = "name" | "qty" | "value";

export default function WarehousePage() {
  const { warehouses, defaultWarehouseId } = useStore();
  const [whId, setWhId] = useState("");
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("value");

  useEffect(() => {
    if (profile && !hasPermission(profile, "warehouse")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!whId && defaultWarehouseId) setWhId(defaultWarehouseId);
  }, [defaultWarehouseId, whId]);

  useEffect(() => {
    if (whId) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId]);

  if (!profile || !hasPermission(profile, "warehouse")) return null;

  async function loadData() {
    setLoading(true);

    // Only what physically sits in the central warehouse right now
    const items = await fetchSellableItems(whId, true);

    const { data: damages } = await supabase
      .from("stock_damages")
      .select("product_id, variant_id, qty")
      .eq("store_id", whId);

    // Sent but not yet confirmed by the receiving store
    const { data: transits } = await supabase
      .from("stock_transfers")
      .select("product_id, variant_id, qty")
      .eq("status", "in_transit");

    const { data: batches } = await supabase
      .from("stock_purchases")
      .select("product_id, variant_id, expiry_date, remaining_qty")
      .eq("store_id", whId)
      .gt("remaining_qty", 0)
      .not("expiry_date", "is", null)
      .order("expiry_date", { ascending: true });

    const keyOf = (pid: string, vid: string | null) => `${pid}:${vid || "base"}`;

    const damageMap = new Map<string, number>();
    for (const d of damages || []) {
      const k = keyOf(d.product_id, d.variant_id);
      damageMap.set(k, (damageMap.get(k) || 0) + Number(d.qty));
    }

    const transitMap = new Map<string, number>();
    for (const tr of transits || []) {
      const k = keyOf(tr.product_id, tr.variant_id);
      transitMap.set(k, (transitMap.get(k) || 0) + Number(tr.qty));
    }

    const expiryMap = new Map<string, string>();
    for (const b of batches || []) {
      const k = keyOf(b.product_id, b.variant_id);
      if (!expiryMap.has(k)) expiryMap.set(k, b.expiry_date as string);
    }

    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    setRows(
      items.map((i) => {
        const k = keyOf(i.product_id, i.variant_id);
        const nearestExpiry = expiryMap.get(k) || null;
        const isExpired = !!nearestExpiry && new Date(nearestExpiry).getTime() < now;
        const isExpiringSoon =
          !!nearestExpiry && !isExpired && new Date(nearestExpiry).getTime() - now < thirtyDays;
        return {
          ...i,
          damagedQty: damageMap.get(k) || 0,
          inTransitQty: transitMap.get(k) || 0,
          stockValue: i.stock_qty * i.avg_cost,
          nearestExpiry,
          isExpired,
          isExpiringSoon,
        };
      })
    );
    setLoading(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (statusFilter === "in_stock" && r.stock_qty <= 0) return false;
      if (statusFilter === "out_of_stock" && r.stock_qty > 0) return false;
      if (statusFilter === "damaged" && r.damagedQty <= 0) return false;
      if (statusFilter === "in_transit" && r.inTransitQty <= 0) return false;
      if (statusFilter === "expiring" && !r.isExpiringSoon) return false;
      if (statusFilter === "expired" && !r.isExpired) return false;
      if (q && !r.display_name.toLowerCase().includes(q) && !(r.sku || "").toLowerCase().includes(q))
        return false;
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortKey === "name") return a.display_name.localeCompare(b.display_name);
      if (sortKey === "qty") return b.stock_qty - a.stock_qty;
      return b.stockValue - a.stockValue;
    });
  }, [rows, search, statusFilter, sortKey]);

  const summary = useMemo(
    () => ({
      products: filtered.length,
      totalQty: filtered.reduce((s, r) => s + r.stock_qty, 0),
      totalValue: filtered.reduce((s, r) => s + r.stockValue, 0),
      damaged: filtered.reduce((s, r) => s + r.damagedQty, 0),
      inTransit: filtered.reduce((s, r) => s + r.inTransitQty, 0),
      outOfStock: filtered.filter((r) => r.stock_qty <= 0).length,
    }),
    [filtered]
  );

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">🏭 {t("warehouse_currentStockTitle")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("warehouse_currentStockSubtitle")}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {warehouses.length > 1 && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={whId} onChange={(e) => setWhId(e.target.value)}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>🏭 {w.name}</option>)}
          </select>
        )}

        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">{t("warehouse_allStock")}</option>
          <option value="in_stock">{t("warehouse_inStock")}</option>
          <option value="out_of_stock">{t("warehouse_outOfStock")}</option>
          <option value="damaged">{t("warehouse_damaged")}</option>
          <option value="in_transit">{t("transferIn_status_in_transit")}</option>
          <option value="expiring">{t("warehouse_expiringSoon")}</option>
          <option value="expired">{t("warehouse_expired")}</option>
        </select>

        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="value">{t("warehouse_sortValue")}</option>
          <option value="qty">{t("warehouse_sortQty")}</option>
          <option value="name">{t("warehouse_sortName")}</option>
        </select>

        <input
          className="flex-1 min-w-[200px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("warehouse_searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_products")}</div>
          <div className="text-xl font-bold mt-1">{summary.products}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_availableQty")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalQty.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_stockValue")}</div>
          <div className="text-lg font-bold mt-1">{fmt(summary.totalValue)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_damaged")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{summary.damaged.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_in_transit")}</div>
          <div className="text-xl font-bold mt-1 text-yellow-600">{summary.inTransit.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_outOfStock")}</div>
          <div className="text-xl font-bold mt-1 text-slate-500">{summary.outOfStock}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvgCost")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_stockValue")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_damaged")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_status_in_transit")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colExpiry")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((r) => (
              <tr key={r.key} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.display_name}</td>
                <td className="px-3 py-2 text-slate-400">{r.sku || "-"}</td>
                <td className={`px-3 py-2 font-medium ${r.stock_qty <= 0 ? "text-red-600" : ""}`}>
                  {r.stock_qty.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-slate-500">{fmt(r.avg_cost)}</td>
                <td className="px-3 py-2 font-medium">{fmt(r.stockValue)}</td>
                <td className={`px-3 py-2 ${r.damagedQty > 0 ? "text-red-600 font-medium" : "text-slate-300"}`}>
                  {r.damagedQty || "-"}
                </td>
                <td className={`px-3 py-2 ${r.inTransitQty > 0 ? "text-yellow-600 font-medium" : "text-slate-300"}`}>
                  {r.inTransitQty || "-"}
                </td>
                <td
                  className={`px-3 py-2 text-xs ${
                    r.isExpired ? "text-red-600 font-semibold" : r.isExpiringSoon ? "text-orange-600 font-medium" : "text-slate-400"
                  }`}
                >
                  {r.nearestExpiry || "-"}
                  {r.isExpired && " ⚠️"}
                  {r.isExpiringSoon && " ⏰"}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">{t("warehouse_empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
