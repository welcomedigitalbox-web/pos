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

  const [whIds, setWhIds] = useState<string[]>([]);
  // One row per batch answers "what is on this shelf". Pivot answers
  // "where is this item", which is the question when several places hold it.
  const [pivot, setPivot] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);

  const warehouses = useMemo(
    () => stores.filter((s: any) => s.is_warehouse),
    [stores]
  );

  useEffect(() => {
    if (!whIds.length && warehouses.length) setWhIds([warehouses[0].id]);
  }, [warehouses, whIds.length]);

  useEffect(() => {
    if (whIds.length) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whIds.join(",")]);

  // The function answers for one warehouse, so several warehouses are
  // several calls, asked at once and laid end to end.
  async function load() {
    setLoading(true);
    const results = await Promise.all(
      whIds.map((id) =>
        supabase.rpc("warehouse_stock_ledger", { p_warehouse_id: id })
      )
    );
    const all: Row[] = [];
    for (const { data, error } of results) {
      if (!error) all.push(...((data as Row[]) || []));
    }
    setRows(all);
    setLoading(false);
  }

  function toggleWh(id: string) {
    setWhIds((cur) =>
      cur.includes(id)
        ? (cur.length === 1 ? cur : cur.filter((x) => x !== id))
        : [...cur, id]
    );
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

  // Item by item, with a column for each place that holds it.
  const pivotRows = useMemo(() => {
    const by = new Map<string, {
      name: string; barcode: string | null;
      per: Record<string, number>; total: number;
    }>();
    for (const r of visible) {
      const key = `${r.item_name}|${r.barcode || ""}`;
      const e = by.get(key) || { name: r.item_name, barcode: r.barcode, per: {}, total: 0 };
      e.per[r.warehouse_id] = (e.per[r.warehouse_id] || 0) + Number(r.on_hand || 0);
      e.total += Number(r.on_hand || 0);
      by.set(key, e);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [visible]);

  const whName = (id: string) =>
    (warehouses.find((w: any) => w.id === id) as any)?.name || id;

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
    a.download = `stock-ledger-${whIds.join("-")}-${new Date().toISOString().slice(0, 10)}.csv`;
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
          <div className="flex flex-wrap gap-1.5">
            {warehouses.map((w: any) => (
              <button
                key={w.id}
                type="button"
                onClick={() => toggleWh(w.id)}
                className={`px-3 py-2 rounded-lg text-sm border ${
                  whIds.includes(w.id)
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-slate-600 border-slate-200"
                }`}
              >
                {w.name}
              </button>
            ))}
          </div>
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
        <label className="flex items-center gap-2 text-sm px-3">
          <input type="checkbox" checked={pivot}
            onChange={(e) => setPivot(e.target.checked)} />
          ပစ္စည်းအလိုက် စုပြ
        </label>
      </div>

      {pivot ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
                <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
                {whIds.map((id) => (
                  <th key={id} className="text-right px-3 py-2">{whName(id)}</th>
                ))}
                <th className="text-right px-3 py-2 font-semibold">
                  {t("stockLedger_onHand")}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={whIds.length + 3} className="text-center text-slate-400 py-8">…</td></tr>
              )}
              {!loading && pivotRows.map((r) => (
                <tr key={`${r.name}|${r.barcode || ""}`} className="border-t border-slate-100">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{r.barcode || "-"}</td>
                  {whIds.map((id) => (
                    <td key={id} className="px-3 py-2 text-right">
                      {r.per[id] ? fmt(r.per[id]) : <span className="text-slate-300">-</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-medium">{fmt(r.total)}</td>
                </tr>
              ))}
              {!loading && pivotRows.length === 0 && (
                <tr><td colSpan={whIds.length + 3} className="text-center text-slate-400 py-8">-</td></tr>
              )}
            </tbody>
            {pivotRows.length > 0 && (
              <tfoot className="bg-slate-50 font-medium border-t-2 border-slate-200">
                <tr>
                  <td className="px-3 py-2" colSpan={2}>{pivotRows.length}</td>
                  {whIds.map((id) => (
                    <td key={id} className="px-3 py-2 text-right">
                      {fmt(pivotRows.reduce((n, r) => n + (r.per[id] || 0), 0))}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    {fmt(pivotRows.reduce((n, r) => n + r.total, 0))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      ) : (
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[880px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              {whIds.length > 1 && <th className="text-left px-3 py-2">🏭</th>}
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
                {whIds.length > 1 && (
                  <td className="px-3 py-2 text-xs text-slate-500">{whName(r.warehouse_id)}</td>
                )}
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
                <td className="px-3 py-2" colSpan={whIds.length > 1 ? 4 : 3}>{visible.length}</td>
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
      )}
    </div>
  );
}
