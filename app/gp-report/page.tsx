"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Row = {
  code: string | null; description: string; category: string | null;
  cost: number; price: number; qty: number;
  total_cost: number; total_price: number;
  gp_value: number; gp_percent: number | null; closing_stock: number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d); };
const n = (v: unknown) => Number(v || 0).toLocaleString();

export default function GpReportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(iso(new Date()));
  const [store, setStore] = useState("");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [soldOnly, setSoldOnly] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.from("stores").select("id,name").order("id")
      .then(({ data }) => setStores((data as { id: string; name: string }[]) || []));
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to, store]);

  async function load() {
    setLoading(true);
    const { data } = await supabase.rpc("product_gp_report", {
      p_from: from, p_to: to, p_store: store || null,
    });
    setRows((data as Row[]) || []);
    setLoading(false);
  }

  const shown = useMemo(() => {
    let out = rows;
    if (soldOnly) out = out.filter((r) => r.qty !== 0);
    if (q) {
      const s = q.toLowerCase();
      out = out.filter((r) =>
        (r.code || "").toLowerCase().includes(s) ||
        r.description.toLowerCase().includes(s) ||
        (r.category || "").toLowerCase().includes(s));
    }
    return out;
  }, [rows, q, soldOnly]);

  const total = useMemo(() => shown.reduce(
    (t, r) => ({
      qty: t.qty + Number(r.qty || 0),
      cost: t.cost + Number(r.total_cost || 0),
      price: t.price + Number(r.total_price || 0),
      gp: t.gp + Number(r.gp_value || 0),
      stock: t.stock + Number(r.closing_stock || 0),
    }),
    { qty: 0, cost: 0, price: 0, gp: 0, stock: 0 }
  ), [shown]);

  const totalGpPct = total.price > 0 ? (total.gp / total.price) * 100 : null;

  function download() {
    const head = ["Code", "Description", "Category", "Cost", "Price", "Qty",
      "Total Cost", "Total Price", "GP Value", "GP %", "Closing Stock"];
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = shown.map((r) => [
      r.code, r.description, r.category, r.cost, r.price, r.qty,
      r.total_cost, r.total_price, r.gp_value,
      r.gp_percent == null ? "" : r.gp_percent, r.closing_stock,
    ].map(esc).join(","));
    const csv = "﻿" + [head.join(","), ...body].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `gp-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="max-w-full mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold">Product GP Report</h1>
          <p className="text-sm text-slate-500">Sales, cost, profit and stock on hand</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          <span className="text-slate-400">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          <select value={store} onChange={(e) => setStore(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
            <option value="">All shops</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={download}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm">Export CSV</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, name or category"
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[220px]" />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={soldOnly} onChange={(e) => setSoldOnly(e.target.checked)} />
          Sold only
        </label>
        <span className="text-xs text-slate-400">{shown.length} </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[1000px]">
          <thead className="bg-slate-50 text-slate-500 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Code</th>
              <th className="px-3 py-2 text-left font-medium">Description</th>
              <th className="px-3 py-2 text-left font-medium">Category</th>
              {["Cost", "Price", "Qty", "Total Cost", "Total Price", "GP Value", "GP %", "Closing Stock"].map((h) => (
                <th key={h} className="px-3 py-2 text-right font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.code || "-"}</td>
                <td className="px-3 py-1.5">{r.description}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.category || "-"}</td>
                <td className="px-3 py-1.5 text-right text-slate-500">{n(r.cost)}</td>
                <td className="px-3 py-1.5 text-right">{n(r.price)}</td>
                <td className="px-3 py-1.5 text-right">{n(r.qty)}</td>
                <td className="px-3 py-1.5 text-right text-slate-500">{n(r.total_cost)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{n(r.total_price)}</td>
                <td className="px-3 py-1.5 text-right text-green-700">{n(r.gp_value)}</td>
                <td className={"px-3 py-1.5 text-right " + (r.gp_percent == null ? "text-slate-400" : r.gp_percent < 15 ? "text-red-600" : "text-slate-600")}>
                  {r.gp_percent == null ? "-" : r.gp_percent + "%"}
                </td>
                <td className={"px-3 py-1.5 text-right " + (Number(r.closing_stock) <= 0 ? "text-red-600 font-medium" : "")}>
                  {n(r.closing_stock)}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-slate-400" colSpan={11}>
                {loading ? "…" : "Nothing in this period."}
              </td></tr>
            )}
          </tbody>
          {shown.length > 0 && (
            <tfoot className="bg-slate-50 font-medium">
              <tr className="border-t border-slate-200">
                <td className="px-3 py-2" colSpan={5}>Total</td>
                <td className="px-3 py-2 text-right">{n(total.qty)}</td>
                <td className="px-3 py-2 text-right">{n(total.cost)}</td>
                <td className="px-3 py-2 text-right">{n(total.price)}</td>
                <td className="px-3 py-2 text-right text-green-700">{n(total.gp)}</td>
                <td className="px-3 py-2 text-right">{totalGpPct == null ? "-" : totalGpPct.toFixed(2) + "%"}</td>
                <td className="px-3 py-2 text-right">{n(total.stock)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
