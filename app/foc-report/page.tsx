"use client";

// =====================================================================
// Free of charge report.
//
// Two different things end up as goods leaving the shop for nothing: a
// promotion the company decided on, and a cashier handing something over
// at the counter. The first is a marketing cost and is expected; the
// second is the one worth watching, which is why they are counted apart
// here and the cost is shown in money, not only in pieces.
//
// The cost is what the goods cost the company, not what they would have
// sold for: a gift does not lose a sale that was never made.
// =====================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Row = {
  qty: number;
  unit_cost: number | null;
  line_cogs: number | null;
  product_name: string | null;
  promotion_id: string | null;
  foc_reason: string | null;
  sales: {
    sale_ref: string | null;
    store_id: string;
    created_at: string;
    cashier_email: string | null;
  } | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

// Every shop runs on Myanmar time; the reader may not.
const SHOP_TZ = "Asia/Yangon";
const SHOP_OFFSET = "+06:30";

const day = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: SHOP_TZ,
      })
    : "-";

// The date a sale belongs to, as the shop would say it.
const shopDay = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-CA", { timeZone: SHOP_TZ }) : "";

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function FocReportPage() {
  const { profile } = useAuth();
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [store, setStore] = useState("");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [promoNames, setPromoNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const allowed = hasPermission(profile, "foc-report");

  useEffect(() => {
    supabase
      .from("stores")
      .select("id,name")
      .order("name")
      .then(({ data }) => setStores((data as { id: string; name: string }[]) || []));
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    // The day typed in the box means the whole of that day.
    let q = supabase
      .from("sale_items")
      .select(
        "qty, unit_cost, line_cogs, product_name, promotion_id, foc_reason, " +
          "sales!inner(sale_ref, store_id, created_at, cashier_email)"
      )
      .eq("is_free_gift", true)
      .gte("sales.created_at", from + "T00:00:00" + SHOP_OFFSET)
      .lte("sales.created_at", to + "T23:59:59" + SHOP_OFFSET)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (store) q = q.eq("sales.store_id", store);

    const { data, error } = await q;
    setBusy(false);
    if (error) {
      setErr(describeError(error));
      return;
    }
    const list = (data as unknown as Row[]) || [];
    setRows(list);

    const ids = Array.from(
      new Set(list.map((r) => r.promotion_id).filter((x): x is string => !!x))
    );
    if (ids.length > 0) {
      const { data: promos } = await supabase
        .from("promotions")
        .select("id,name")
        .in("id", ids);
      const map: Record<string, string> = {};
      ((promos as { id: string; name: string }[]) || []).forEach((p) => {
        map[p.id] = p.name;
      });
      setPromoNames(map);
    }
  }, [from, to, store]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const totals = useMemo(() => {
    let promoQty = 0, promoCost = 0, handQty = 0, handCost = 0;
    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      const cost = Number(r.line_cogs ?? (Number(r.unit_cost) || 0) * qty) || 0;
      if (r.promotion_id) {
        promoQty += qty;
        promoCost += cost;
      } else {
        handQty += qty;
        handCost += cost;
      }
    }
    return { promoQty, promoCost, handQty, handCost };
  }, [rows]);

  // Which items go out free most often is the question a buyer actually
  // asks, so the table is grouped by product rather than by receipt.
  const byProduct = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; cost: number; promo: number; hand: number }>();
    for (const r of rows) {
      const name = r.product_name || "(unnamed)";
      const qty = Number(r.qty) || 0;
      const cost = Number(r.line_cogs ?? (Number(r.unit_cost) || 0) * qty) || 0;
      const cur = m.get(name) || { name, qty: 0, cost: 0, promo: 0, hand: 0 };
      cur.qty += qty;
      cur.cost += cost;
      if (r.promotion_id) cur.promo += qty; else cur.hand += qty;
      m.set(name, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.cost - a.cost);
  }, [rows]);

  function exportCsv() {
    const head = ["Date", "Sale", "Branch", "Product", "Qty", "Cost", "Kind", "Reason", "Cashier"];
    const lines = rows.map((r) => {
      const qty = Number(r.qty) || 0;
      const cost = Number(r.line_cogs ?? (Number(r.unit_cost) || 0) * qty) || 0;
      return [
        shopDay(r.sales?.created_at ?? null),
        r.sales?.sale_ref || "",
        r.sales?.store_id || "",
        r.product_name || "",
        String(qty),
        String(Math.round(cost)),
        r.promotion_id ? "Promotion" : "Given by hand",
        r.promotion_id ? (promoNames[r.promotion_id] || "") : (r.foc_reason || ""),
        r.sales?.cashier_email || "",
      ];
    });
    const csv = [head, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `foc-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="text-sm text-slate-600">
          This report is not part of your access. Ask IT to add it to your role.
        </p>
        <Link href="/" className="text-sm text-blue-600">Back</Link>
      </main>
    );
  }

  const field = "border border-slate-300 rounded-lg px-2 py-1 text-sm";

  return (
    <main className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-lg font-semibold">Free of charge</h1>
      <p className="text-xs text-slate-500 mb-4">
        Everything that left a shop without being paid for, counted at what it
        cost the company.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label className="block text-[11px] text-slate-500">From</label>
          <input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500">To</label>
          <input type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500">Branch</label>
          <select className={field} value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">All</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <button onClick={load} className={field + " bg-slate-900 text-white border-slate-900"}>
          {busy ? "Loading..." : "Show"}
        </button>
        <button onClick={exportCsv} className={field}>Export CSV</button>
      </div>

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Box label="Promotion gifts" value={`${money(totals.promoQty)} pcs`} sub={`${money(totals.promoCost)} MMK`} />
        <Box label="Given by hand" value={`${money(totals.handQty)} pcs`} sub={`${money(totals.handCost)} MMK`} />
        <Box label="Total pieces" value={money(totals.promoQty + totals.handQty)} sub="" />
        <Box label="Total cost" value={`${money(totals.promoCost + totals.handCost)} MMK`} sub="" />
      </div>

      <h2 className="text-sm font-medium mb-2">By product</h2>
      <div className="overflow-x-auto mb-6">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-slate-500 border-b">
              <th className="py-1 pr-3">Product</th>
              <th className="py-1 pr-3 text-right">Promotion</th>
              <th className="py-1 pr-3 text-right">By hand</th>
              <th className="py-1 pr-3 text-right">Total qty</th>
              <th className="py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {byProduct.map((p) => (
              <tr key={p.name} className="border-b last:border-0">
                <td className="py-1 pr-3">{p.name}</td>
                <td className="py-1 pr-3 text-right text-slate-500">{money(p.promo)}</td>
                <td className="py-1 pr-3 text-right">{money(p.hand)}</td>
                <td className="py-1 pr-3 text-right font-medium">{money(p.qty)}</td>
                <td className="py-1 text-right">{money(p.cost)}</td>
              </tr>
            ))}
            {byProduct.length === 0 && !busy && (
              <tr><td colSpan={5} className="py-3 text-slate-400">Nothing went out free in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-sm font-medium mb-2">Every line</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-slate-500 border-b">
              <th className="py-1 pr-3">Date</th>
              <th className="py-1 pr-3">Sale</th>
              <th className="py-1 pr-3">Branch</th>
              <th className="py-1 pr-3">Product</th>
              <th className="py-1 pr-3 text-right">Qty</th>
              <th className="py-1 pr-3 text-right">Cost</th>
              <th className="py-1 pr-3">Why</th>
              <th className="py-1">Cashier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const qty = Number(r.qty) || 0;
              const cost = Number(r.line_cogs ?? (Number(r.unit_cost) || 0) * qty) || 0;
              return (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{day(r.sales?.created_at ?? null)}</td>
                  <td className="py-1 pr-3">{r.sales?.sale_ref || "-"}</td>
                  <td className="py-1 pr-3">{r.sales?.store_id || "-"}</td>
                  <td className="py-1 pr-3">{r.product_name || "-"}</td>
                  <td className="py-1 pr-3 text-right">{money(qty)}</td>
                  <td className="py-1 pr-3 text-right">{money(cost)}</td>
                  <td className="py-1 pr-3">
                    {r.promotion_id ? (
                      <span className="text-slate-500">
                        Promotion{promoNames[r.promotion_id] ? ` - ${promoNames[r.promotion_id]}` : ""}
                      </span>
                    ) : (
                      <span className="text-amber-700">{r.foc_reason || "Given by hand"}</span>
                    )}
                  </td>
                  <td className="py-1 text-slate-500">{r.sales?.cashier_email || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Box({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-base font-semibold">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}
