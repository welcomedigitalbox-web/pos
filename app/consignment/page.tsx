"use client";

// Consignment stock, apart from the shop's own.
//
// Two questions get asked about these goods and nothing else: what is still
// standing here, and what do we owe for the ones that sold. Both are on this
// page, and the unsold ones can be handed back from it.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, describeError } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useLanguage } from "../language-context";

type Row = {
  supplier_id: string | null;
  supplier_name: string | null;
  product_id: string;
  variant_id: string | null;
  store_id: string;
  on_hand: number;
  sold_qty: number;
  returned_qty: number;
  owed: number;
};

type Entry = {
  id: string;
  kind: string;
  qty: number;
  unit_cost: number;
  amount_due: number;
  store_id: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

const fmt = (n: number) => Math.round(n).toLocaleString() + " MMK";

export default function ConsignmentPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allStores, setAllStores] = useState(false);
  const [toast, setToast] = useState("");

  const [back, setBack] = useState<Row | null>(null);
  const [backQty, setBackQty] = useState("");
  const [backNote, setBackNote] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storeId, allStores]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 4000);
  }

  async function load() {
    setLoading(true);
    let q = supabase.from("consignment_stock_v").select("*").limit(1000);
    if (!allStores) q = q.eq("store_id", storeId);
    const [{ data }, { data: prods }, { data: log }] = await Promise.all([
      q,
      supabase.from("products").select("id, name").limit(5000),
      supabase.from("consignment_ledger")
        .select("id, kind, qty, unit_cost, amount_due, store_id, note, created_by, created_at")
        .order("created_at", { ascending: false }).limit(50),
    ]);
    setRows(((data as Row[]) || []).filter((r) => r.on_hand !== 0 || r.sold_qty > 0));
    const m: Record<string, string> = {};
    for (const p of (prods as { id: string; name: string }[]) || []) m[p.id] = p.name;
    setNames(m);
    setEntries((log as Entry[]) || []);
    setLoading(false);
  }

  const totals = useMemo(() => ({
    onHand: rows.reduce((s, r) => s + Number(r.on_hand), 0),
    owed: rows.reduce((s, r) => s + Number(r.owed), 0),
  }), [rows]);

  async function sendBack() {
    if (!back) return;
    const qty = Number(backQty);
    if (!qty || qty <= 0) return showToast("❌ " + t("stockRequest_qtyInvalid"));
    setSending(true);
    try {
      const { error } = await supabase.rpc("consignment_return", {
        p_supplier: back.supplier_id,
        p_product: back.product_id,
        p_variant: back.variant_id,
        p_store: back.store_id,
        p_qty: qty,
        p_note: backNote.trim() || null,
      });
      if (error) throw error;
      setBack(null); setBackQty(""); setBackNote("");
      showToast("✅");
      await load();
    } catch (err) {
      showToast("❌ " + describeError(err));
    } finally {
      setSending(false);
    }
  }

  if (!profile || !hasPermission(profile, "products")) return null;

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">Consignment</h2>
        <label className="flex items-center gap-2 text-sm text-slate-500">
          <input type="checkbox" checked={allStores} onChange={(e) => setAllStores(e.target.checked)} />
          all stores
        </label>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Goods that belong to the supplier until they sell. Nothing is owed on
        what is still standing here.
      </p>

      <div className="flex flex-wrap gap-3 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 min-w-[140px]">
          <div className="text-xs text-slate-500">Still here</div>
          <div className="text-lg font-semibold mt-0.5">{totals.onHand}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 min-w-[160px]">
          <div className="text-xs text-slate-500">Owed for what sold</div>
          <div className="text-lg font-semibold mt-0.5 text-orange-600">{fmt(totals.owed)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2">{t("nav_suppliers")}</th>
              {allStores && <th className="text-left px-4 py-2">Store</th>}
              <th className="text-right px-4 py-2">Here</th>
              <th className="text-right px-4 py-2">Sold</th>
              <th className="text-right px-4 py-2">Returned</th>
              <th className="text-right px-4 py-2">Owed</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">…</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{names[r.product_id] || r.product_id.slice(0, 8)}</td>
                <td className="px-4 py-2 text-slate-500">{r.supplier_name || "-"}</td>
                {allStores && <td className="px-4 py-2 text-slate-500">{r.store_id}</td>}
                <td className="px-4 py-2 text-right tabular-nums">{Number(r.on_hand)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{Number(r.sold_qty)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400">{Number(r.returned_qty)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-orange-600">{fmt(Number(r.owed))}</td>
                <td className="px-4 py-2 text-right">
                  {Number(r.on_hand) > 0 && (
                    <button onClick={() => { setBack(r); setBackQty(String(r.on_hand)); }}
                      className="text-blue-600 text-xs font-medium">
                      Send back
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-10">
                Nothing on consignment here
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="font-medium text-sm mb-2">Movements</h3>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[620px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">Date</th>
              <th className="text-left px-4 py-2">What</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Owed</th>
              <th className="text-left px-4 py-2">{t("pos_note")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-slate-500">{e.created_at.slice(0, 16).replace("T", " ")}</td>
                <td className="px-4 py-2">
                  <span className={
                    "px-2 py-0.5 rounded text-xs font-medium " +
                    (e.kind === "sold" ? "bg-orange-100 text-orange-700"
                      : e.kind === "returned" ? "bg-slate-100 text-slate-600"
                      : "bg-green-100 text-green-700")
                  }>{e.kind}</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(e.qty)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {Number(e.amount_due) ? fmt(Number(e.amount_due)) : "-"}
                </td>
                <td className="px-4 py-2 text-slate-400">{e.note || "-"}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {back && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">Send back</h3>
            <p className="text-sm text-slate-500 mb-4">
              {names[back.product_id]} · {back.supplier_name} · {Number(back.on_hand)} here
            </p>

            <label className="text-sm text-slate-600">Quantity</label>
            <input type="number" autoFocus value={backQty} onChange={(e) => setBackQty(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <input value={backNote} onChange={(e) => setBackNote(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" />

            <div className="flex gap-2">
              <button onClick={() => setBack(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={sendBack} disabled={sending}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "..." : "Send back"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
