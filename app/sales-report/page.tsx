"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type SaleRow = {
  id: string;
  store_id: string;
  total: number;
  order_type: string;
  channel: string | null;
  created_at: string;
};

type RangeMode = "today" | "yesterday" | "week" | "month" | "year" | "custom";

function getRange(mode: RangeMode, customStart: string, customEnd: string): { start: Date; end: Date } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (mode) {
    case "today":
      return { start: startOfToday, end: now };
    case "yesterday": {
      const y = new Date(startOfToday);
      y.setDate(y.getDate() - 1);
      const yEnd = new Date(startOfToday.getTime() - 1);
      return { start: y, end: yEnd };
    }
    case "week": {
      const day = now.getDay(); // 0=Sun
      const diff = day === 0 ? 6 : day - 1; // Monday start
      const monday = new Date(startOfToday);
      monday.setDate(monday.getDate() - diff);
      return { start: monday, end: now };
    }
    case "month":
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
    case "year":
      return { start: new Date(now.getFullYear(), 0, 1), end: now };
    case "custom":
      return {
        start: customStart ? new Date(customStart) : startOfToday,
        end: customEnd ? new Date(new Date(customEnd).getTime() + 24 * 60 * 60 * 1000 - 1) : now,
      };
  }
}

function channelLabel(row: SaleRow): string {
  if (row.order_type === "walk_in") return "POS";
  if (row.order_type === "wholesale") return "Wholesale";
  if (row.order_type === "online") {
    const c = row.channel || "other";
    return c.charAt(0).toUpperCase() + c.slice(1);
  }
  return row.order_type;
}

export default function SalesReportPage() {
  const { stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rangeMode, setRangeMode] = useState<RangeMode>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [storeFilter, setStoreFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");

  const [sales, setSales] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile && !hasPermission(profile, "sales-report")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeMode, customStart, customEnd]);

  if (!profile || !hasPermission(profile, "sales-report")) return null;

  async function load() {
    setLoading(true);
    const { start, end } = getRange(rangeMode, customStart, customEnd);
    const { data } = await supabase
      .from("sales")
      .select("id, store_id, total, order_type, channel, created_at")
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: false });
    setSales((data as SaleRow[]) || []);
    setLoading(false);
  }

  const filtered = useMemo(() => {
    return sales.filter((s) => {
      if (storeFilter !== "all" && s.store_id !== storeFilter) return false;
      if (channelFilter !== "all") {
        const label = channelLabel(s).toLowerCase();
        if (channelFilter === "pos" && label !== "pos") return false;
        if (channelFilter === "wholesale" && label !== "wholesale") return false;
        if (["facebook", "tiktok", "viber", "other"].includes(channelFilter) && label !== channelFilter) return false;
      }
      return true;
    });
  }, [sales, storeFilter, channelFilter]);

  const totalSale = filtered.reduce((s, r) => s + r.total, 0);
  const totalOrders = filtered.length;

  const byStore = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const s of filtered) {
      const v = map.get(s.store_id) || { total: 0, count: 0 };
      v.total += s.total;
      v.count += 1;
      map.set(s.store_id, v);
    }
    return Array.from(map.entries())
      .map(([storeId, v]) => ({ storeId, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const s of filtered) {
      const label = channelLabel(s);
      const v = map.get(label) || { total: 0, count: 0 };
      v.total += s.total;
      v.count += 1;
      map.set(label, v);
    }
    return Array.from(map.entries())
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  const rangeButtons: { key: RangeMode; label: string }[] = [
    { key: "today", label: t("salesReport_today") },
    { key: "yesterday", label: t("salesReport_yesterday") },
    { key: "week", label: t("salesReport_thisWeek") },
    { key: "month", label: t("salesReport_thisMonth") },
    { key: "year", label: t("salesReport_thisYear") },
    { key: "custom", label: t("salesReport_customRange") },
  ];

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-3">{t("nav_salesReport")}</h2>

      {/* Date range buttons */}
      <div className="flex flex-wrap gap-1 mb-3">
        {rangeButtons.map((b) => (
          <button
            key={b.key}
            onClick={() => setRangeMode(b.key)}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium ${
              rangeMode === b.key ? "bg-blue-600 text-white" : "bg-white border border-slate-200 text-slate-600"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {rangeMode === "custom" && (
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            type="date"
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
          />
          <span className="self-center text-slate-400 text-sm">→</span>
          <input
            type="date"
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
          />
        </div>
      )}

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
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        >
          <option value="all">{t("salesReport_allChannels")}</option>
          <option value="pos">POS</option>
          <option value="wholesale">Wholesale</option>
          <option value="facebook">Facebook</option>
          <option value="tiktok">TikTok</option>
          <option value="viber">Viber</option>
          <option value="other">{t("saleOrder_channelOther")}</option>
        </select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-2 gap-3 mb-6">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase">{t("dashboard_todaySale")}</div>
          <div className="text-xl font-bold mt-1">{loading ? "..." : fmt(totalSale)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase">{t("dashboard_todayOrder")}</div>
          <div className="text-xl font-bold mt-1">{loading ? "..." : totalOrders}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* By store */}
        <div>
          <h3 className="font-semibold mb-2">{t("salesReport_byStore")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[300px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("admin_store")}</th>
                  <th className="text-left px-3 py-2">{t("dashboard_todayOrder")}</th>
                  <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
                </tr>
              </thead>
              <tbody>
                {byStore.map((r) => (
                  <tr key={r.storeId} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.storeId}</td>
                    <td className="px-3 py-2">{r.count}</td>
                    <td className="px-3 py-2 font-medium">{fmt(r.total)}</td>
                  </tr>
                ))}
                {byStore.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center text-slate-400 py-6">
                      -
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* By channel */}
        <div>
          <h3 className="font-semibold mb-2">{t("salesReport_byChannel")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[300px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("saleOrder_channel")}</th>
                  <th className="text-left px-3 py-2">{t("dashboard_todayOrder")}</th>
                  <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
                </tr>
              </thead>
              <tbody>
                {byChannel.map((r) => (
                  <tr key={r.label} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.label}</td>
                    <td className="px-3 py-2">{r.count}</td>
                    <td className="px-3 py-2 font-medium">{fmt(r.total)}</td>
                  </tr>
                ))}
                {byChannel.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center text-slate-400 py-6">
                      -
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
