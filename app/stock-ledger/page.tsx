"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";

type Row = {
  product_id: string;
  variant_id: string | null;
  item_name: string;
  barcode: string | null;
  warehouse_id: string;
  batch_id: string;
  expiry_date: string | null;
  on_hand: number;
  committed: number;
  free: number;
  unit_cost: number | null;
  stock_value: number | null;
};

export default function StockLedgerPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();

  const [whId, setWhId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);

  const warehouses = useMemo(
    () => stores.filter((s: any) => s.is_warehouse),
    [stores]
  );

  useEffect(() => {
    if (!whId && warehouses.length) setWhId(warehouses[0].id);
  }, [warehouses, whId]);

  useEffect(() => {
    if (whId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId]);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.rpc("warehouse_stock_ledger", {
      p_warehouse_id: whId,
    });
    if (!error) setRows((data as Row[]) || []);
    setLoading(false);
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyShort && r.free > 0) return false;
      if (!q) return true;
      return (
        r.item_name.toLowerCase().includes(q) ||
        (r.barcode || "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, onlyShort]);

  // Totals cover what is on screen, so a filtered view adds up to itself.
  const totals = useMemo(() => {
    const value = visible.reduce((n, r) => n + Number(r.stock_value || 0), 0);
    return {
      onHand: visible.reduce((n, r) => n + Number(r.on_hand || 0), 0),
      committed: visible.reduce((n, r) => n + Number(r.committed || 0), 0),
      free: visible.reduce((n, r) => n + Number(r.free || 0), 0),
      value,
      showValue: visible.some((r) => r.stock_value !== null),
    };
  }, [visible]);

  function downloadCsv() {
    const showCost = totals.showValue;
    const head = [
      "Warehouse", "Item", "Barcode", "Expiry",
      "On hand", "Committed", "Free",
      ...(showCost ? ["Unit cost", "Stock value"] : []),
    ];
    // Quote every field: item names carry commas, and Excel splits on them.
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      head.map(esc).join(","),
      ...visible.map((r) =>
        [
          r.warehouse_id, r.item_name, r.barcode || "", r.expiry_date || "",
          r.on_hand, r.committed, r.free,
          ...(showCost ? [r.unit_cost ?? "", r.stock_value ?? ""] : []),
        ].map(esc).join(",")
      ),
    ];

    const blob = new Blob(["\uFEFF" + lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-ledger-${whId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fmt = (n: number | null) =>
    n === null ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

  // Anything expiring within the month is worth moving first.
  const soon = (d: string | null) => {
    if (!d) return false;
    const days = (new Date(d).getTime() - Date.now()) / 86400000;
    return days < 30;
  };

  if (!profile || !hasPermission(profile, "ledger")) return null;

  return (
    <div className="pt-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-lg">{t("nav_ledger")}</h2>
          <p className="text-sm text-slate-500">{t("stockLedger_subtitle")}</p>
        </div>
        <button
          onClick={downloadCsv}
          disabled={!visible.length}
          className="px-4 py-2 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
        >
          {t("stockLedger_download")}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {warehouses.length > 1 && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={whId} onChange={(e) => setWhId(e.target.value)}>
            {warehouses.map((w: any) => (
              <option key={w.id} value={w.id}>🏭 {w.name}</option>
            ))}
          </select>
        )}
        <input
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-64"
          placeholder={t("warehouse_searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm px-3">
          <input type="checkbox" checked={onlyShort}
            onChange={(e) => setOnlyShort(e.target.checked)} />
          {t("stockLedger_onlyShort")}
        </label>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[880px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("stockLedger_expiry")}</th>
              <th className="text-right px-3 py-2">{t("stockLedger_onHand")}</th>
              <th className="text-right px-3 py-2">{t("stockLedger_committed")}</th>
              <th className="text-right px-3 py-2">{t("stockLedger_free")}</th>
              {totals.showValue && (
                <>
                  <th className="text-right px-3 py-2">{t("warehouse_colAvgCost")}</th>
                  <th className="text-right px-3 py-2">{t("stockLedger_value")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">…</td></tr>
            )}
            {!loading && visible.map((r) => (
              <tr key={r.batch_id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.item_name}</td>
                <td className="px-3 py-2 text-slate-400 text-xs">{r.barcode || "-"}</td>
                <td className={`px-3 py-2 text-xs ${soon(r.expiry_date) ? "text-red-600 font-medium" : "text-slate-500"}`}>
                  {r.expiry_date || "-"}
                </td>
                <td className="px-3 py-2 text-right">{fmt(r.on_hand)}</td>
                <td className="px-3 py-2 text-right text-amber-700">
                  {r.committed > 0 ? fmt(r.committed) : "-"}
                </td>
                <td className={`px-3 py-2 text-right font-medium ${r.free < 0 ? "text-red-600" : ""}`}>
                  {fmt(r.free)}
                </td>
                {totals.showValue && (
                  <>
                    <td className="px-3 py-2 text-right text-slate-500">{fmt(r.unit_cost)}</td>
                    <td className="px-3 py-2 text-right">{fmt(r.stock_value)}</td>
                  </>
                )}
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
          {visible.length > 0 && (
            <tfoot className="bg-slate-50 font-medium border-t-2 border-slate-200">
              <tr>
                <td className="px-3 py-2" colSpan={3}>{visible.length}</td>
                <td className="px-3 py-2 text-right">{fmt(totals.onHand)}</td>
                <td className="px-3 py-2 text-right">{fmt(totals.committed)}</td>
                <td className="px-3 py-2 text-right">{fmt(totals.free)}</td>
                {totals.showValue && (
                  <>
                    <td />
                    <td className="px-3 py-2 text-right">{fmt(totals.value)}</td>
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
