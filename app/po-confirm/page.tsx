"use client";

// =====================================================================
// Counting in what the office says has arrived.
//
// The office writes down what the supplier's bill promises. Nothing moves
// until somebody here opens the cartons and says how many are actually
// in them. That number is what goes on the shelf, and the gap between the
// two - if there is one - stays on the record with a name against it.
// =====================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Row = {
  id: string;
  po_id: string;
  po_item_id: string;
  store_id: string;
  qty: number;
  unit_cost: number;
  expiry_date: string | null;
  declared_by: string | null;
  declared_at: string;
  status: string;
  confirmed_qty: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  note: string | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const when = (s: string | null) =>
  s
    ? new Date(s).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        timeZone: "Asia/Yangon",
      })
    : "-";

export default function PoConfirmPage() {
  const { profile } = useAuth();
  const allowed = hasPermission(profile, "po-confirm");

  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, { product: string; po: string }>>({});
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("po_receipt_declarations")
      .select("*")
      .order("declared_at", { ascending: false })
      .limit(200);
    const all = (data as Row[]) || [];
    setRows(all.filter((r) => r.status === "pending"));
    setDone(all.filter((r) => r.status !== "pending").slice(0, 25));

    // What each line is, in words: the product and the order it came from.
    const itemIds = Array.from(new Set(all.map((r) => r.po_item_id)));
    if (itemIds.length === 0) return;
    const { data: items } = await supabase
      .from("purchase_order_items")
      .select("id, po_id, products(name), purchase_orders(po_number)")
      .in("id", itemIds);
    const by: Record<string, { product: string; po: string }> = {};
    for (const i of (items as unknown as {
      id: string;
      products: { name: string } | null;
      purchase_orders: { po_number: string } | null;
    }[]) || []) {
      by[i.id] = {
        product: i.products?.name || "-",
        po: i.purchase_orders?.po_number || "",
      };
    }
    setNames(by);
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  async function confirm(r: Row) {
    const raw = counted[r.id];
    const qty = raw === undefined || raw === "" ? r.qty : Number(raw);
    if (isNaN(qty) || qty < 0) return setErr("How many did you count?");
    setBusy(r.id); setErr(""); setMsg("");
    const { data, error } = await supabase.rpc("confirm_po_receipt", {
      p_id: r.id,
      p_qty: qty,
      p_note: (note[r.id] || "").trim() || null,
    });
    setBusy("");
    if (error) { setErr(describeError(error)); return; }
    const res = (data as { counted?: number; short?: number }) || {};
    setMsg(
      Number(res.short || 0) > 0
        ? `Counted ${res.counted} - ${res.short} short of what was declared`
        : `Counted ${res.counted} - on the shelf now`
    );
    load();
  }

  const totalWaiting = useMemo(
    () => rows.reduce((n, r) => n + Number(r.qty || 0), 0),
    [rows]
  );

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="text-sm text-slate-600">
          Counting goods in belongs to the warehouse. Ask IT if you need it.
        </p>
        <Link href="/" className="text-sm text-blue-600">Back</Link>
      </main>
    );
  }

  const field = "border border-slate-300 rounded px-2 py-1 text-sm";

  return (
    <main className="p-4 sm:p-6 max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold">Goods to count in</h1>
      <p className="text-xs text-slate-500 mb-4">
        The office has written down what the supplier says is coming. Nothing
        is on the shelf until you count it and confirm.
      </p>

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}
      {msg && <p className="text-sm text-green-700 mb-3">{msg}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing waiting.</p>
      ) : (
        <>
          <p className="text-xs text-slate-500 mb-2">
            {rows.length} line(s), {money(totalWaiting)} piece(s) declared
          </p>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="border border-slate-200 rounded-lg p-3">
                <div className="flex flex-wrap items-baseline gap-2 mb-2">
                  <span className="font-medium">{names[r.po_item_id]?.product || "-"}</span>
                  <span className="text-xs text-slate-400">
                    {names[r.po_item_id]?.po} · {r.store_id}
                  </span>
                  <span className="ml-auto text-xs text-slate-400">
                    {r.declared_by} · {when(r.declared_at)}
                  </span>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <div className="text-[11px] text-slate-500">Declared</div>
                    <div className="text-sm font-medium">{Number(r.qty)}</div>
                  </div>
                  
                  <div>
                    <div className="text-[11px] text-slate-500">Expiry</div>
                    <div className="text-sm text-slate-500">{r.expiry_date || "-"}</div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500">Counted</label>
                    <input
                      type="number"
                      min="0"
                      className={field + " w-24 text-right"}
                      placeholder={String(r.qty)}
                      value={counted[r.id] ?? ""}
                      onChange={(e) =>
                        setCounted((m) => ({ ...m, [r.id]: e.target.value }))
                      }
                    />
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-[11px] text-slate-500">
                      Note (only if it differs)
                    </label>
                    <input
                      className={field + " w-full"}
                      value={note[r.id] ?? ""}
                      onChange={(e) => setNote((m) => ({ ...m, [r.id]: e.target.value }))}
                      placeholder="two cartons short, one wet"
                    />
                  </div>
                  <button
                    onClick={() => confirm(r)}
                    disabled={busy === r.id}
                    className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-50"
                  >
                    {busy === r.id ? "Working..." : "Confirm"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {done.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Counted earlier</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-slate-500 border-b">
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Product</th>
                  <th className="py-1 pr-3">Where</th>
                  <th className="py-1 pr-3 text-right">Declared</th>
                  <th className="py-1 pr-3 text-right">Counted</th>
                  <th className="py-1 pr-3">By</th>
                  <th className="py-1">Note</th>
                </tr>
              </thead>
              <tbody>
                {done.map((r) => {
                  const short = Number(r.qty) - Number(r.confirmed_qty ?? 0);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1 pr-3 whitespace-nowrap">{when(r.confirmed_at)}</td>
                      <td className="py-1 pr-3">{names[r.po_item_id]?.product || "-"}</td>
                      <td className="py-1 pr-3">{r.store_id}</td>
                      <td className="py-1 pr-3 text-right text-slate-400">{Number(r.qty)}</td>
                      <td className={`py-1 pr-3 text-right ${short > 0 ? "text-red-600 font-medium" : ""}`}>
                        {r.status === "cancelled" ? "withdrawn" : Number(r.confirmed_qty ?? 0)}
                      </td>
                      <td className="py-1 pr-3 text-slate-500 text-xs">{r.confirmed_by}</td>
                      <td className="py-1 text-slate-500 text-xs">{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
