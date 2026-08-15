"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

type Status = "healthy" | "warning" | "urgent" | "out";

type Row = {
  storeId: string;
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  avgCost: number;
  sold: number;
  available: number;
  target: number;
  stockPercent: number | null;
  status: Status;
  stockValue: number;
  nearestExpiry: string | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

function statusInfo(status: Status, t: (k: any) => string) {
  switch (status) {
    case "healthy":
      return { label: t("warehouse_healthy"), color: "bg-green-100 text-green-700" };
    case "warning":
      return { label: t("warehouse_warning"), color: "bg-yellow-100 text-yellow-700" };
    case "urgent":
      return { label: t("warehouse_urgent"), color: "bg-orange-100 text-orange-700" };
    case "out":
      return { label: t("warehouse_outOfStock"), color: "bg-red-100 text-red-700" };
  }
}

export default function WarehouseHistoryPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();
  const retailStores = stores.filter((s) => !s.is_warehouse);
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const [storeFilter, setStoreFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "warehouse")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "warehouse")) return null;

  async function loadData() {
    setLoading(true);

    // Per-store stock/cost, joined with the global product catalog
    const { data: inventory } = await supabase
      .from("store_inventory")
      .select("*, products(name, sku), product_variants(variant_name, sku)");

    // Per-store sold qty (sale_items -> parent sale's store_id)
    const { data: saleItems } = await supabase
      .from("sale_items")
      .select("product_id, variant_id, qty, sales(store_id)");

    // Per-store nearest expiry from remaining batches
    const { data: batches } = await supabase
      .from("stock_purchases")
      .select("product_id, variant_id, store_id, expiry_date, remaining_qty")
      .gt("remaining_qty", 0)
      .not("expiry_date", "is", null)
      .order("expiry_date", { ascending: true });

    const soldMap = new Map<string, number>();
    for (const item of (saleItems as any[]) || []) {
      const sId = item.sales?.store_id;
      if (!sId) continue;
      const key = `${sId}:${item.product_id}:${item.variant_id || "base"}`;
      soldMap.set(key, (soldMap.get(key) || 0) + Number(item.qty));
    }

    const expiryMap = new Map<string, string>();
    for (const b of batches || []) {
      const key = `${b.store_id}:${b.product_id}:${b.variant_id || "base"}`;
      if (!expiryMap.has(key)) expiryMap.set(key, b.expiry_date as string);
    }

    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    const built: Row[] = ((inventory as any[]) || [])
      .filter((inv) => inv.products) // skip orphaned rows (deleted product)
      .map((inv) => {
        const key = `${inv.store_id}:${inv.product_id}:${inv.variant_id || "base"}`;
        const sold = soldMap.get(key) || 0;
        const available = Number(inv.stock_qty);
        const target = Math.round(sold * 0.5);
        const stockPercent = sold > 0 ? (available / sold) * 100 : null;

        let status: Status;
        if (available <= 0) status = "out";
        else if (sold === 0) status = "healthy";
        else if (stockPercent! >= 50) status = "healthy";
        else if (stockPercent! >= 30) status = "warning";
        else status = "urgent";

        const nearestExpiry = expiryMap.get(key) || null;
        const isExpired = !!nearestExpiry && new Date(nearestExpiry).getTime() < now;
        const isExpiringSoon = !!nearestExpiry && !isExpired && new Date(nearestExpiry).getTime() - now < thirtyDays;

        return {
          storeId: inv.store_id,
          productId: inv.product_id,
          variantId: inv.variant_id ?? null,
          name: inv.product_variants?.variant_name
            ? `${inv.products.name} (${inv.product_variants.variant_name})`
            : inv.products.name,
          sku: inv.product_variants?.sku || inv.products.sku,
          avgCost: Number(inv.avg_cost),
          sold,
          available,
          target,
          stockPercent,
          status,
          stockValue: available * Number(inv.avg_cost),
          nearestExpiry,
          isExpired,
          isExpiringSoon,
        };
      });

    setRows(built);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (storeFilter !== "all" && r.storeId !== storeFilter) return false;
      if (statusFilter !== "all") {
        if (statusFilter === "expiring" && !r.isExpiringSoon) return false;
        if (statusFilter === "expired" && !r.isExpired) return false;
        if (["healthy", "warning", "urgent", "out"].includes(statusFilter) && r.status !== statusFilter)
          return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!r.name.toLowerCase().includes(q) && !(r.sku || "").toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, storeFilter, statusFilter, search]);

  const summary = useMemo(() => {
    const totalSold = filtered.reduce((s, r) => s + r.sold, 0);
    const totalAvailable = filtered.reduce((s, r) => s + r.available, 0);
    const totalTarget = filtered.reduce((s, r) => s + r.target, 0);
    const totalValue = filtered.reduce((s, r) => s + r.stockValue, 0);
    const stockPercent = totalSold > 0 ? (totalAvailable / totalSold) * 100 : 0;
    return {
      products: filtered.length,
      totalSold,
      totalAvailable,
      totalTarget,
      totalValue,
      stockPercent,
      healthy: filtered.filter((r) => r.status === "healthy").length,
      warning: filtered.filter((r) => r.status === "warning").length,
      urgent: filtered.filter((r) => r.status === "urgent").length,
      out: filtered.filter((r) => r.status === "out").length,
    };
  }, [filtered]);

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("warehouseHistory_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("warehouseHistory_subtitle")}</p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
        >
          <option value="all">{t("warehouse_allStores")}</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">{t("warehouse_allStock")}</option>
          <option value="healthy">{t("warehouse_healthy")}</option>
          <option value="warning">{t("warehouse_warning")}</option>
          <option value="urgent">{t("warehouse_urgent")}</option>
          <option value="out">{t("warehouse_outOfStock")}</option>
          <option value="expiring">{t("warehouse_expiringSoon")}</option>
          <option value="expired">{t("warehouse_expired")}</option>
        </select>

        <input
          className="flex-1 min-w-[180px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("warehouse_searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_products")}</div>
          <div className="text-xl font-bold mt-1">{summary.products}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_soldQty")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalSold.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_availableQty")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalAvailable.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_targetQty")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalTarget.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_stockPercent")}</div>
          <div className="text-xl font-bold mt-1 text-green-700">{summary.stockPercent.toFixed(1)}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_healthy")}</div>
          <div className="text-xl font-bold mt-1 text-green-600">{summary.healthy}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_warning")}</div>
          <div className="text-xl font-bold mt-1 text-yellow-600">{summary.warning}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_urgent")}</div>
          <div className="text-xl font-bold mt-1 text-orange-600">{summary.urgent}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_outOfStock")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{summary.out}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_stockValue")}</div>
          <div className="text-xl font-bold mt-1">{fmt(summary.totalValue)}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[1000px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colStore")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colSold")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvgCost")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colTarget")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colStockPercent")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colStatus")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colExpiry")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="text-center text-slate-400 py-8">
                  ...
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((r) => {
                const info = statusInfo(r.status, t);
                return (
                  <tr key={`${r.storeId}:${r.productId}:${r.variantId || "base"}`} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      {stores.find((s) => s.id === r.storeId)?.is_warehouse ? `🏭 ${r.storeId}` : r.storeId}
                    </td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-slate-400">{r.sku || "-"}</td>
                    <td className="px-3 py-2">{r.sold.toLocaleString()}</td>
                    <td className="px-3 py-2 font-medium">{r.available.toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-500">{fmt(r.avgCost)}</td>
                    <td className="px-3 py-2">{r.target.toLocaleString()}</td>
                    <td className="px-3 py-2">{r.stockPercent !== null ? `${r.stockPercent.toFixed(0)}%` : "-"}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${info.color}`}>{info.label}</span>
                    </td>
                    <td
                      className={`px-3 py-2 text-xs ${
                        r.isExpired ? "text-red-600 font-semibold" : r.isExpiringSoon ? "text-orange-600 font-medium" : "text-slate-400"
                      }`}
                    >
                      {r.nearestExpiry ? r.nearestExpiry : "-"}
                      {r.isExpired && " ⚠️"}
                      {r.isExpiringSoon && " ⏰"}
                    </td>
                  </tr>
                );
              })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center text-slate-400 py-8">
                  {t("warehouse_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
