"use client";

import { useEffect, useMemo, useState } from "react";
import { matchesSearch } from "@/lib/search";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { hasPermission } from "../permissions";
import * as XLSX from "xlsx";

type Row = {
  product_id: string;
  variant_id: string | null;
  sku: string | null;
  name: string;
  opening: number;
  received: number;
  sold: number;
  transfer_in: number;
  transfer_out: number;
  damaged: number;
  adjusted: number;
  online_out: number;
  closing: number;
};

const n = (v: number) => Number(v || 0);
const show = (v: number) => (n(v) === 0 ? "-" : n(v).toLocaleString());

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (k: number) => {
  const d = new Date();
  d.setDate(d.getDate() - k);
  return iso(d);
};

export default function StockLedgerPage() {
  const { storeId, stores, isStoreLocked } = useStore();
  const { profile } = useAuth();
  const router = useRouter();

  const [locId, setLocId] = useState("");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(iso(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [movedOnly, setMovedOnly] = useState(true);

  useEffect(() => {
    if (profile && !hasPermission(profile, "inventory")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!locId && storeId) setLocId(storeId);
  }, [storeId, locId]);

  useEffect(() => {
    if (!locId) return;
    let live = true;
    setLoading(true);
    setErr("");
    supabase
      .rpc("stock_ledger", { p_from: from, p_to: to, p_store: locId })
      .then(({ data, error }) => {
        if (!live) return;
        if (error) setErr(error.message);
        setRows((data as Row[]) || []);
        setLoading(false);
      });
    return () => { live = false; };
  }, [locId, from, to]);

  const moved = (r: Row) =>
    n(r.received) || n(r.sold) || n(r.transfer_in) || n(r.transfer_out) ||
    n(r.damaged) || n(r.adjusted) || n(r.online_out);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (movedOnly && !moved(r)) return false;
      return matchesSearch(q, r.name, r.sku);
    });
  }, [rows, search, movedOnly]);

  const sum = (k: keyof Row) =>
    filtered.reduce((s, r) => s + n(r[k] as number), 0);

  function exportExcel() {
    const sheet = filtered.map((r) => ({
      Code: r.sku || "",
      Description: r.name,
      Opening: n(r.opening),
      Received: n(r.received),
      Sold: n(r.sold),
      "Transfer In": n(r.transfer_in),
      "Transfer Out": n(r.transfer_out),
      Damaged: n(r.damaged),
      Adjusted: n(r.adjusted),
      Online: n(r.online_out),
      Closing: n(r.closing),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), "Ledger");
    XLSX.writeFile(wb, `stock-ledger-${locId}-${from}-to-${to}.xlsx`);
  }

  if (!profile || !hasPermission(profile, "inventory")) return null;

  const cols: { key: keyof Row; label: string; tone?: string }[] = [
    { key: "opening", label: "Opening" },
    { key: "received", label: "Rec" },
    { key: "sold", label: "Sale", tone: "text-slate-600" },
    { key: "transfer_in", label: "TrnIn" },
    { key: "transfer_out", label: "TrnOut" },
    { key: "online_out", label: "Online" },
    { key: "damaged", label: "Damage", tone: "text-red-600" },
    { key: "adjusted", label: "Adjust", tone: "text-blue-600" },
  ];

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">Stock movement</h2>
      <p className="text-sm text-slate-500 mb-4">
        What opened, what moved, what is left — one line per product.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {!isStoreLocked && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={locId} onChange={(e) => setLocId(e.target.value)}>
            {!locId && <option value="">Choose a location</option>}
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.is_warehouse ? `🏭 ${s.name}` : s.name}
              </option>
            ))}
          </select>
        )}

        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm" />

        {[["Today", 0], ["7 days", 6], ["30 days", 29]].map(([t, k]) => (
          <button key={String(t)} type="button"
            onClick={() => { setFrom(daysAgo(Number(k))); setTo(iso(new Date())); }}
            className="px-3 py-2 rounded-lg text-xs bg-slate-100 text-slate-600">
            {t}
          </button>
        ))}

        <input className="flex-1 min-w-[180px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder="Search product or code"
          value={search} onChange={(e) => setSearch(e.target.value)} />

        <button type="button" onClick={() => setMovedOnly(!movedOnly)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
          {movedOnly ? "Moved only" : "All products"}
        </button>

        <button type="button" onClick={exportExcel} disabled={!filtered.length}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium disabled:opacity-40">
          Excel
        </button>
      </div>

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

      {!locId ? (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          Choose a location first.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Code</th>
                <th className="text-left px-3 py-2">Description</th>
                {cols.map((c) => (
                  <th key={c.key} className="text-right px-3 py-2">{c.label}</th>
                ))}
                <th className="text-right px-3 py-2">Closing</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={cols.length + 3}
                  className="text-center text-slate-400 py-8">...</td></tr>
              )}
              {!loading && filtered.map((r) => (
                <tr key={`${r.product_id}:${r.variant_id || "base"}`}
                  className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs text-slate-400">{r.sku || "-"}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  {cols.map((c) => (
                    <td key={c.key} className={`px-3 py-2 text-right ${c.tone || ""}`}>
                      {c.key === "adjusted" && n(r.adjusted) > 0
                        ? `+${n(r.adjusted).toLocaleString()}`
                        : show(r[c.key] as number)}
                    </td>
                  ))}
                  <td className={`px-3 py-2 text-right font-medium ${
                    n(r.closing) < 0 ? "text-red-600" : ""}`}>
                    {n(r.closing).toLocaleString()}
                  </td>
                </tr>
              ))}
              {!loading && filtered.length > 0 && (
                <tr className="border-t border-slate-200 bg-slate-50 font-medium">
                  <td className="px-3 py-2" colSpan={2}>Total</td>
                  {cols.map((c) => (
                    <td key={c.key} className="px-3 py-2 text-right">
                      {sum(c.key).toLocaleString()}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    {sum("closing").toLocaleString()}
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={cols.length + 3}
                  className="text-center text-slate-400 py-8">
                  Nothing moved in this range
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
