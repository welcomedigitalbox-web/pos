"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, Product } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";



type Status = "healthy" | "warning" | "urgent" | "out" ;

type Row = {
  product: Product;
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

export default function WarehousePage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const [storeFilter, setStoreFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

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
    const { data: products } = await supabase.from("products").select("*").order("name");
    const { data: saleItems } = await supabase.from("sale_items").select("product_id, qty");
    const { data: batches } = await supabase
      .from("stock_purchases")
      .select("product_id, expiry_date, remaining_qty")
      .gt("remaining_qty", 0)
      .not("expiry_date", "is", null)
      .order("expiry_date", { ascending: true });

    const soldMap = new Map<string, number>();
    for (const item of saleItems || []) {
      soldMap.set(item.product_id, (soldMap.get(item.product_id) || 0) + Number(item.qty));
    }

    const expiryMap = new Map<string, string>();
    for (const b of batches || []) {
      if (!expiryMap.has(b.product_id)) expiryMap.set(b.product_id, b.expiry_date as string);
    }

    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    const built: Row[] = (products || []).map((p) => {
      const sold = soldMap.get(p.id) || 0;
      const available = p.stock_qty;
      const target = Math.round(sold * 0.5);
      const stockPercent = sold > 0 ? (available / sold) * 100 : null;

      let status: Status;
      if (available <= 0) status = "out";
      else if (sold === 0) status = "healthy";
      else if (stockPercent! >= 50) status = "healthy";
      else if (stockPercent! >= 30) status = "warning";
      else status = "urgent";

      const nearestExpiry = expiryMap.get(p.id) || null;
      const isExpired = !!nearestExpiry && new Date(nearestExpiry).getTime() < now;
      const isExpiringSoon = !!nearestExpiry && !isExpired && new Date(nearestExpiry).getTime() - now < thirtyDays;

      return {
        product: p,
        sold,
        available,
        target,
        stockPercent,
        status,
        stockValue: available * p.avg_cost,
        nearestExpiry,
        isExpired,
        isExpiringSoon,
      };
    });

    setRows(built);
    setLoading(false);
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (storeFilter !== "all" && r.product.store_id !== storeFilter) return false;
      if (statusFilter !== "all") {
        if (statusFilter === "expiring" && !r.isExpiringSoon) return false;
        if (statusFilter === "expired" && !r.isExpired) return false;
        if (["healthy", "warning", "urgent", "out"].includes(statusFilter) && r.status !== statusFilter)
          return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!r.product.name.toLowerCase().includes(q) && !(r.product.sku || "").toLowerCase().includes(q))
          return false;
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
      <h2 className="font-semibold text-lg mb-1">{t("warehouse_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("warehouse_subtitle")}</p>

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
                  <tr key={r.product.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.product.store_id}</td>
                    <td className="px-3 py-2">{r.product.name}</td>
                    <td className="px-3 py-2 text-slate-400">{r.product.sku || "-"}</td>
                    <td className="px-3 py-2">{r.sold.toLocaleString()}</td>
                    <td className="px-3 py-2 font-medium">{r.available.toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-500">{fmt(r.product.avg_cost)}</td>
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
    </div>
  );
}
