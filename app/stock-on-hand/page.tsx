"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

function n0(n: number) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function mmk(n: number) {
  return n0(n) + " MMK";
}

// Closing stock for every location on one screen. The figures come back as one
// JSON value rather than a row per product and shop, because a REST response
// stops at 1,000 rows and this is twenty thousand of them.
type Row = {
  id: string;
  sku: string | null;
  name: string;
  category_id: string | null;
  price: number;
  is_active: boolean;
  total_qty: number;
  total_value: number;
  by_store: Record<string, number>;
};

type Summary = {
  store_id: string;
  skus_in_stock: number;
  total_qty: number;
  total_value: number;
  negative_rows: number;
  no_cost_rows: number;
};

type Cat = { id: string; name: string };

export default function StockOnHandPage() {
  const { profile } = useAuth();
  const { stores } = useStore();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [onlyStock, setOnlyStock] = useState(true);

  const canSeeCost =
    profile?.role === "owner" ||
    profile?.role === "admin" ||
    (profile?.role || "").includes("manager") ||
    (profile?.role || "").includes("director") ||
    (profile?.role || "").includes("account");

  useEffect(() => {
    if (profile && !hasPermission(profile, "inventory")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
  }, []);

  // Hooks must run on every render, so the guard waits until just before the
  // JSX. Returning early above useMemo changes the hook count and React stops
  // the whole page.
  const pageBlocked = !profile || !hasPermission(profile, "inventory");

  async function load() {
    setLoading(true);
    setErr("");
    const [main, sum, c] = await Promise.all([
      supabase.rpc("stock_on_hand_json"),
      supabase.from("stock_on_hand_by_store").select("*"),
      supabase.from("product_categories").select("id,name").order("sort_order"),
    ]);
    // Say what went wrong rather than spinning on "Counting..." for ever.
    const firstErr = main.error || sum.error || c.error;
    if (firstErr) {
      setErr(
        [firstErr.message, (firstErr as { details?: string }).details,
         (firstErr as { hint?: string }).hint].filter(Boolean).join(" · ")
      );
    }
    setRows((main.data as Row[]) || []);
    setSummary((sum.data as Summary[]) || []);
    setCats((c.data as Cat[]) || []);
    setLoading(false);
  }

  const shown = useMemo(() => {
    let out = rows;
    if (onlyStock) out = out.filter((r) => Number(r.total_qty) !== 0);
    if (cat) out = out.filter((r) => (r.category_id || "") === cat);
    if (q) {
      const s = q.toLowerCase();
      out = out.filter(
        (r) => (r.sku || "").toLowerCase().includes(s) || r.name.toLowerCase().includes(s)
      );
    }
    return out;
  }, [rows, q, cat, onlyStock]);

  const shownQty = shown.reduce((s, r) => s + Number(r.total_qty || 0), 0);
  const shownValue = shown.reduce((s, r) => s + Number(r.total_value || 0), 0);

  function exportCsv() {
    const head = [
      "SKU",
      "Product",
      ...stores.map((s) => s.name),
      "Total qty",
      ...(canSeeCost ? ["Stock value"] : []),
    ];
    const lines = shown.map((r) =>
      [
        r.sku || "",
        `"${r.name.replace(/"/g, '""')}"`,
        ...stores.map((s) => r.by_store?.[s.id] ?? 0),
        r.total_qty,
        ...(canSeeCost ? [Math.round(r.total_value)] : []),
      ].join(",")
    );
    const blob = new Blob([[head.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `closing-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const totalNegative = summary.reduce((s, r) => s + Number(r.negative_rows || 0), 0);
  const totalNoCost = summary.reduce((s, r) => s + Number(r.no_cost_rows || 0), 0);

  if (pageBlocked) return null;

  return (
    <div className="pt-4">
      <div className="flex items-start justify-between mb-1">
        <h2 className="font-semibold text-lg">Closing stock</h2>
        <button
          onClick={exportCsv}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-medium"
        >
          Export
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        What every shop and warehouse is holding right now, in one table.
      </p>

      {/* Per-location summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {summary
          .slice()
          .sort((a, b) => a.store_id.localeCompare(b.store_id))
          .map((s) => (
            <div key={s.store_id} className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs text-slate-500">
                {stores.find((x) => x.id === s.store_id)?.name || s.store_id}
              </div>
              <div className="font-semibold">{n0(s.total_qty)}</div>
              <div className="text-[11px] text-slate-400">
                {n0(s.skus_in_stock)} SKU
                {canSeeCost ? ` · ${mmk(s.total_value)}` : ""}
              </div>
              {(s.negative_rows > 0 || s.no_cost_rows > 0) && (
                <div className="text-[10px] text-red-600 mt-0.5">
                  {s.negative_rows > 0 ? `${s.negative_rows} negative` : ""}
                  {s.negative_rows > 0 && s.no_cost_rows > 0 ? " · " : ""}
                  {s.no_cost_rows > 0 ? `${s.no_cost_rows} no cost` : ""}
                </div>
              )}
            </div>
          ))}
      </div>

      {(totalNegative > 0 || totalNoCost > 0) && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2 mb-4 text-xs">
          {totalNegative > 0 && (
            <div>
              {totalNegative} line(s) are below zero — stock went out that was never
              booked in. Fix those before trusting the value.
            </div>
          )}
          {totalNoCost > 0 && (
            <div>
              {totalNoCost} line(s) hold stock with no cost, so their value counts
              as nothing.
            </div>
          )}
        </div>
      )}

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-3 py-2 mb-4 text-xs">
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]"
          placeholder="Search code or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={cat}
          onChange={(e) => setCat(e.target.value)}
        >
          <option value="">All categories</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyStock}
            onChange={(e) => setOnlyStock(e.target.checked)}
          />
          Holding stock only
        </label>
        <span className="ml-auto text-sm text-slate-500">
          {n0(shown.length)} SKU &middot;{" "}
          <span className="font-semibold">{n0(shownQty)}</span>
          {canSeeCost ? ` · ${mmk(shownValue)}` : ""}
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 sticky left-0 bg-slate-50">Product</th>
              <th className="text-left px-3 py-2">Code</th>
              {stores.map((s) => (
                <th key={s.id} className="text-right px-3 py-2 whitespace-nowrap">
                  {s.name}
                </th>
              ))}
              <th className="text-right px-3 py-2">Total</th>
              {canSeeCost && <th className="text-right px-3 py-2">Value</th>}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={stores.length + 4} className="text-center text-slate-400 py-10">
                  Counting...
                </td>
              </tr>
            )}
            {!loading &&
              shown.slice(0, 1500).map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 sticky left-0 bg-white">
                    {r.name}
                    {!r.is_active && (
                      <span className="ml-1 text-[10px] text-slate-400">archived</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-400">{r.sku || "-"}</td>
                  {stores.map((s) => {
                    const v = r.by_store?.[s.id] ?? 0;
                    return (
                      <td
                        key={s.id}
                        className={`px-3 py-1.5 text-right ${
                          v < 0 ? "text-red-600 font-semibold" : v === 0 ? "text-slate-300" : ""
                        }`}
                      >
                        {v === 0 ? "-" : n0(v)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right font-semibold">{n0(r.total_qty)}</td>
                  {canSeeCost && (
                    <td className="px-3 py-1.5 text-right text-slate-600">
                      {n0(r.total_value)}
                    </td>
                  )}
                </tr>
              ))}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={stores.length + 4} className="text-center text-slate-400 py-10">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {shown.length > 1500 && (
        <p className="text-xs text-slate-400 mt-2">
          Showing the first 1,500 of {n0(shown.length)}. Narrow it with the search
          or the category, or use Export for the whole list.
        </p>
      )}
    </div>
  );
}
