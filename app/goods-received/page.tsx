"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, Supplier } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type ReceiptRow = {
  id: string;
  qty: number;
  unit_cost: number;
  total_cost: number;
  supplier: string | null;
  expiry_date: string | null;
  received_by: string | null;
  received_at: string | null;
  created_at: string;
  po_id: string | null;
  po_number: string | null;
  display_name: string;
};

export default function GoodsReceivedPage() {
  const { warehouses, defaultWarehouseId } = useStore();
  const [whId, setWhId] = useState("");
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "goods-received")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!whId && defaultWarehouseId) setWhId(defaultWarehouseId);
  }, [defaultWarehouseId, whId]);

  useEffect(() => {
    if (whId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId]);

  if (!profile || !hasPermission(profile, "goods-received")) return null;

  async function load() {
    setLoading(true);

    const { data: sups } = await supabase.from("suppliers").select("*").order("name");
    setSuppliers((sups as Supplier[]) || []);

    // Everything received into the central warehouse — PO receipts and manual stock-ins alike
    const { data } = await supabase
      .from("stock_purchases")
      .select("*, products(name), product_variants(variant_name), purchase_orders(po_number)")
      .eq("store_id", whId)
      .order("created_at", { ascending: false })
      .limit(300);

    setRows(
      ((data as any[]) || []).map((r) => ({
        ...r,
        po_number: r.purchase_orders?.po_number || null,
        display_name: r.product_variants?.variant_name
          ? `${r.products?.name} (${r.product_variants.variant_name})`
          : r.products?.name || "-",
      }))
    );
    setLoading(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (supplierFilter !== "all" && (r.supplier || "") !== supplierFilter) return false;

      const when = new Date(r.received_at || r.created_at);
      if (fromDate && when < new Date(fromDate)) return false;
      // include the whole "to" day
      if (toDate && when > new Date(new Date(toDate).getTime() + 24 * 60 * 60 * 1000 - 1)) return false;

      if (q) {
        const hay = `${r.display_name} ${r.supplier || ""} ${r.po_number || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, supplierFilter, fromDate, toDate]);

  const summary = useMemo(
    () => ({
      receipts: filtered.length,
      totalQty: filtered.reduce((s, r) => s + Number(r.qty), 0),
      totalValue: filtered.reduce((s, r) => s + Number(r.total_cost), 0),
      suppliers: new Set(filtered.map((r) => r.supplier).filter(Boolean)).size,
    }),
    [filtered]
  );

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_goodsReceived")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("goodsReceived_subtitle")}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {warehouses.length > 1 && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={whId} onChange={(e) => setWhId(e.target.value)}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>🏭 {w.name}</option>)}
          </select>
        )}

        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
          <option value="all">{t("goodsReceived_allSuppliers")}</option>
          {suppliers.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>

        <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <span className="self-center text-slate-400 text-sm">→</span>
        <input type="date" className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={toDate} onChange={(e) => setToDate(e.target.value)} />

        <input className="flex-1 min-w-[200px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("goodsReceived_searchPlaceholder")}
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("goodsReceived_receipts")}</div>
          <div className="text-xl font-bold mt-1">{summary.receipts}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("po_receivedQty")}</div>
          <div className="text-xl font-bold mt-1">{summary.totalQty.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("goodsReceived_totalValue")}</div>
          <div className="text-lg font-bold mt-1">{fmt(summary.totalValue)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("nav_suppliers")}</div>
          <div className="text-xl font-bold mt-1">{summary.suppliers}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("nav_suppliers")}</th>
              <th className="text-left px-3 py-2">{t("po_number")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedQty")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_unitCost")}</th>
              <th className="text-left px-3 py-2">{t("goodsReceived_totalValue")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_expiryDate")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{new Date(r.received_at || r.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.display_name}</td>
                <td className="px-3 py-2">{r.supplier || "-"}</td>
                <td className="px-3 py-2">
                  {r.po_id ? (
                    <Link href={`/purchase-orders/${r.po_id}`} className="text-blue-600 text-xs font-medium">
                      {r.po_number || t("products_view")}
                    </Link>
                  ) : (
                    <span className="text-slate-300 text-xs">{t("goodsReceived_manual")}</span>
                  )}
                </td>
                <td className="px-3 py-2 font-medium">{Number(r.qty).toLocaleString()}</td>
                <td className="px-3 py-2">{fmt(Number(r.unit_cost))}</td>
                <td className="px-3 py-2 font-medium">{fmt(Number(r.total_cost))}</td>
                <td className="px-3 py-2 text-slate-400 text-xs">{r.expiry_date || "-"}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.received_by || "-"}</td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
