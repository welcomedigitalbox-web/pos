"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type PeriodKey = "today" | "this_month" | "last_month" | "this_year" | "all" | "custom";

function resolvePeriod(key: PeriodKey, from?: string, to?: string) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 86400000;
  switch (key) {
    case "today":
      return { from: startOfToday, to: now };
    case "this_month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    case "last_month":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, -1),
      };
    case "this_year":
      return { from: new Date(now.getFullYear(), 0, 1), to: now };
    case "custom":
      return {
        from: from ? new Date(from) : null,
        to: to ? new Date(new Date(to).getTime() + dayMs - 1) : now,
      };
    default:
      return { from: null, to: null };
  }
}

type SaleRow = {
  id: string;
  created_at: string;
  store_id: string;
  cashier_email: string | null;
  sale_rep_name: string | null;
  customer_name: string | null;
  payment_method: string | null;
  order_type: string;
  channel: string | null;
  total: number;
};

type RefundRow = {
  id: string;
  return_number: string;
  created_at: string;
  store_id: string;
  requested_by: string | null;
  refund_amount: number;
};

export default function HistoryPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  // Cashiers see only their own store's sales for today; wider access needs a
  // manager role, so the filters below are deliberately locked down for them.
  const isManagerLevel =
    profile?.role === "sale_manager" ||
    profile?.role === "manager" ||
    profile?.role === "owner" ||
    profile?.role === "admin";

  const [sales, setSales] = useState<SaleRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [period, setPeriod] = useState<PeriodKey>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [storeFilter, setStoreFilter] = useState("current");
  const [cashierFilter, setCashierFilter] = useState("all");

  useEffect(() => {
    if (profile && !hasPermission(profile, "history")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, period, customFrom, customTo, storeFilter]);

  if (!profile || !hasPermission(profile, "history")) return null;

  async function load() {
    setLoading(true);

    const effectivePeriod: PeriodKey = isManagerLevel ? period : "today";
    const { from, to } = resolvePeriod(effectivePeriod, customFrom, customTo);

    let saleQuery = supabase.from("sales").select("*").order("created_at", { ascending: false }).limit(500);
    let refundQuery = supabase
      .from("sale_returns")
      .select("id, return_number, created_at, store_id, requested_by, refund_amount")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(500);

    // Store scope: managers may look across stores, everyone else is pinned
    if (!isManagerLevel || storeFilter === "current") {
      saleQuery = saleQuery.eq("store_id", storeId);
      refundQuery = refundQuery.eq("store_id", storeId);
    } else if (storeFilter !== "all") {
      saleQuery = saleQuery.eq("store_id", storeFilter);
      refundQuery = refundQuery.eq("store_id", storeFilter);
    }

    if (from) {
      saleQuery = saleQuery.gte("created_at", from.toISOString());
      refundQuery = refundQuery.gte("created_at", from.toISOString());
    }
    if (to) {
      saleQuery = saleQuery.lte("created_at", to.toISOString());
      refundQuery = refundQuery.lte("created_at", to.toISOString());
    }

    const [{ data: saleData }, { data: refundData }] = await Promise.all([saleQuery, refundQuery]);
    setSales((saleData as SaleRow[]) || []);
    setRefunds((refundData as RefundRow[]) || []);
    setLoading(false);
  }

  // Built from the loaded rows so the list only ever offers cashiers that
  // actually have sales in the current scope
  const cashiers = useMemo(() => {
    const set = new Set<string>();
    for (const s of sales) if (s.cashier_email) set.add(s.cashier_email);
    return Array.from(set).sort();
  }, [sales]);

  const filteredSales = useMemo(
    () => (cashierFilter === "all" ? sales : sales.filter((s) => s.cashier_email === cashierFilter)),
    [sales, cashierFilter]
  );

  const filteredRefunds = useMemo(
    () => (cashierFilter === "all" ? refunds : refunds.filter((r) => r.requested_by === cashierFilter)),
    [refunds, cashierFilter]
  );

  const summary = useMemo(
    () => ({
      totalSale: filteredSales.reduce((s, r) => s + Number(r.total), 0),
      totalOrders: filteredSales.length,
      totalRefund: filteredRefunds.reduce((s, r) => s + Number(r.refund_amount), 0),
      refundOrders: filteredRefunds.length,
    }),
    [filteredSales, filteredRefunds]
  );

  const netSale = summary.totalSale - summary.totalRefund;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_history")}</h2>
      <p className="text-sm text-slate-500 mb-4">
        {isManagerLevel ? t("history_managerSubtitle") : t("history_cashierSubtitle")}
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {isManagerLevel && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
            <option value="current">{t("history_currentStore")}</option>
            <option value="all">{t("warehouse_allStores")}</option>
            {stores.filter((s) => !s.is_warehouse).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {isManagerLevel ? (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
            <option value="today">{t("ledger_periodToday")}</option>
            <option value="this_month">{t("ledger_periodThisMonth")}</option>
            <option value="last_month">{t("ledger_periodLastMonth")}</option>
            <option value="this_year">{t("ledger_periodThisYear")}</option>
            <option value="all">{t("ledger_periodAll")}</option>
            <option value="custom">{t("ledger_periodCustom")}</option>
          </select>
        ) : (
          <span className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600">
            🔒 {t("ledger_periodToday")}
          </span>
        )}

        {isManagerLevel && period === "custom" && (
          <>
            <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span className="self-center text-slate-400 text-sm">→</span>
            <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </>
        )}

        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={cashierFilter} onChange={(e) => setCashierFilter(e.target.value)}>
          <option value="all">{t("history_allCashiers")}</option>
          {cashiers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("history_totalSale")}</div>
          <div className="text-lg font-bold mt-1">{fmt(summary.totalSale)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("history_totalOrders")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalOrders}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("history_totalRefund")}</div>
          <div className="text-lg font-bold mt-1 text-red-600">{fmt(summary.totalRefund)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("history_refundOrders")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{summary.refundOrders}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("history_netSale")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(netSale)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("orderLookup_orderId")}</th>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              {isManagerLevel && <th className="text-left px-3 py-2">{t("admin_store")}</th>}
              <th className="text-left px-3 py-2">{t("pos_customer")}</th>
              <th className="text-left px-3 py-2">{t("pos_cashier")}</th>
              <th className="text-left px-3 py-2">{t("pos_salesRep")}</th>
              <th className="text-left px-3 py-2">{t("pos_paymentMethod")}</th>
              <th className="text-left px-3 py-2">{t("pos_total")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filteredSales.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">{s.id.slice(0, 8).toUpperCase()}</td>
                <td className="px-3 py-2">{new Date(s.created_at).toLocaleString()}</td>
                {isManagerLevel && <td className="px-3 py-2 text-slate-500">{s.store_id}</td>}
                <td className="px-3 py-2">{s.customer_name || "-"}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{s.cashier_email || "-"}</td>
                <td className="px-3 py-2 text-slate-500">{s.sale_rep_name || "-"}</td>
                <td className="px-3 py-2 text-xs">{s.payment_method || "-"}</td>
                <td className="px-3 py-2 font-medium">{fmt(s.total)}</td>
              </tr>
            ))}
            {!loading && filteredSales.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filteredRefunds.length > 0 && (
        <>
          <h3 className="font-semibold mt-6 mb-2">{t("history_refundList")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("returns_number")}</th>
                  <th className="text-left px-3 py-2">{t("history_time")}</th>
                  {isManagerLevel && <th className="text-left px-3 py-2">{t("admin_store")}</th>}
                  <th className="text-left px-3 py-2">{t("returns_requestedBy")}</th>
                  <th className="text-left px-3 py-2">{t("returns_refundAmount")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRefunds.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{r.return_number}</td>
                    <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                    {isManagerLevel && <td className="px-3 py-2 text-slate-500">{r.store_id}</td>}
                    <td className="px-3 py-2 text-slate-500 text-xs">{r.requested_by || "-"}</td>
                    <td className="px-3 py-2 font-medium text-red-600">-{fmt(Number(r.refund_amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
