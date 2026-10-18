"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

// Supabase hands back a plain object, so String() on it prints "[object Object]"
// and the cashier learns nothing. Pull the real message out.
function errText(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: string; details?: string; hint?: string };
    return e.message || e.details || e.hint || JSON.stringify(err);
  }
  return String(err);
}

function fmt(n: number) {
  return Math.round(Number(n) || 0).toLocaleString() + " MMK";
}

// The shop cannot change a posted invoice, and shouldn't be able to. It says
// here what the invoice should have said, and finance decides.
type Sale = {
  id: string;
  sale_ref: string;
  store_id: string;
  created_at: string;
  customer_name: string | null;
  total: number;
  cashier_email: string | null;
};

type Item = {
  id: string;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  line_discount: number | null;
  promo_discount: number | null;
};

type Pending = {
  id: string;
  reason: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  decision_note: string | null;
};

export default function InvoiceFixPage() {
  const { profile } = useAuth();
  const router = useRouter();

  const [ref, setRef] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, { qty: string; price: string }>>({});
  const [history, setHistory] = useState<Pending[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  if (profile && !hasPermission(profile, "history")) {
    router.replace("/");
    return null;
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function find() {
    const code = ref.trim();
    if (!code) return;
    setBusy(true);
    setSale(null);
    setItems([]);
    setHistory([]);
    try {
      const { data: s, error } = await supabase
        .from("sales")
        .select("id,sale_ref,store_id,created_at,customer_name,total,cashier_email")
        .eq("sale_ref", code)
        .maybeSingle();
      if (error) throw error;
      if (!s) {
        showToast("No invoice with that number");
        return;
      }
      setSale(s as Sale);

      const [{ data: its }, { data: hist }] = await Promise.all([
        supabase
          .from("sale_items")
          .select("id,product_name,qty,unit_price,line_total,line_discount,promo_discount")
          .eq("sale_id", (s as Sale).id)
          .order("product_name"),
        supabase
          .from("sale_corrections")
          .select("id,reason,status,requested_by,requested_at,decision_note")
          .eq("sale_id", (s as Sale).id)
          .order("requested_at", { ascending: false }),
      ]);
      const list = (its as Item[]) || [];
      setItems(list);
      setEdits(
        Object.fromEntries(
          list.map((i) => [i.id, { qty: String(i.qty), price: String(i.unit_price) }])
        )
      );
      setHistory((hist as Pending[]) || []);
    } catch (err) {
      showToast("❌ " + errText(err));
    } finally {
      setBusy(false);
    }
  }

  // Only the lines the shop actually changed are sent.
  const changed = items.filter((i) => {
    const e = edits[i.id];
    if (!e) return false;
    return Number(e.qty) !== Number(i.qty) || Number(e.price) !== Number(i.unit_price);
  });

  // Discounts already on the line stay where they are, so the figure shown
  // here matches what the invoice would actually come to.
  const newTotal = items.reduce((sum, i) => {
    const e = edits[i.id];
    const q = e ? Number(e.qty) || 0 : i.qty;
    const p = e ? Number(e.price) || 0 : i.unit_price;
    const off = Number(i.line_discount || 0) + Number(i.promo_discount || 0);
    return sum + Math.max(q * p - off, 0);
  }, 0);

  async function submit() {
    if (!sale) return;
    if (changed.length === 0) return showToast("Change a quantity or a price first");
    if (!reason.trim()) return showToast("Say what went wrong");
    setBusy(true);
    try {
      const { error } = await supabase.rpc("request_sale_correction", {
        p_sale_id: sale.id,
        p_reason: reason.trim(),
        p_lines: changed.map((i) => ({
          item_id: i.id,
          qty: Number(edits[i.id].qty),
          unit_price: Number(edits[i.id].price),
        })),
      });
      if (error) throw error;
      showToast(`Sent to finance. ${sale.sale_ref} stays as it is until they apply it.`);
      setReason("");
      await find();
    } catch (err) {
      showToast("❌ " + errText(err));
    } finally {
      setBusy(false);
    }
  }

  const waiting = history.find((h) => h.status === "pending");

  return (
    <div className="pt-4 max-w-3xl">
      <h2 className="font-semibold text-lg mb-1">Ask finance to fix an invoice</h2>
      <p className="text-sm text-slate-500 mb-4">
        For a price or quantity typed in wrong. The invoice does not change until
        finance applies it. For goods coming back, use Returns instead.
      </p>

      <div className="flex gap-2 mb-4">
        <input
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-64 font-mono"
          placeholder="Invoice number"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && find()}
        />
        <button
          onClick={find}
          disabled={busy}
          className="px-4 py-2 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
        >
          Find
        </button>
      </div>

      {sale && (
        <>
          <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 text-sm">
            <div className="flex justify-between">
              <span className="font-mono font-semibold">{sale.sale_ref}</span>
              <span className="text-slate-500">
                {new Date(sale.created_at).toLocaleString()}
              </span>
            </div>
            <div className="text-slate-500 mt-1">
              {sale.customer_name || "Walk-in"} &middot; {sale.cashier_email || "-"}
            </div>
          </div>

          {waiting && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 mb-4 text-sm">
              Finance already has a correction for this invoice:{" "}
              <span className="font-medium">{waiting.reason}</span>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-4">
            <table className="w-full text-sm min-w-[620px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Price</th>
                  <th className="text-right px-3 py-2">Should be qty</th>
                  <th className="text-right px-3 py-2">Should be price</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const e = edits[i.id] || { qty: "", price: "" };
                  const dirty =
                    Number(e.qty) !== Number(i.qty) ||
                    Number(e.price) !== Number(i.unit_price);
                  return (
                    <tr
                      key={i.id}
                      className={`border-t border-slate-100 ${dirty ? "bg-amber-50" : ""}`}
                    >
                      <td className="px-3 py-2">{i.product_name}</td>
                      <td className="px-3 py-2 text-right text-slate-500">{i.qty}</td>
                      <td className="px-3 py-2 text-right text-slate-500">
                        {fmt(i.unit_price)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          className="w-20 border border-slate-200 rounded px-2 py-1 text-right"
                          value={e.qty}
                          disabled={!!waiting}
                          onChange={(ev) =>
                            setEdits({ ...edits, [i.id]: { ...e, qty: ev.target.value } })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          className="w-28 border border-slate-200 rounded px-2 py-1 text-right"
                          value={e.price}
                          disabled={!!waiting}
                          onChange={(ev) =>
                            setEdits({ ...edits, [i.id]: { ...e, price: ev.target.value } })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between text-sm mb-4">
            <span className="text-slate-500">
              Invoice now <span className="font-semibold">{fmt(sale.total)}</span>
            </span>
            <span className={newTotal !== sale.total ? "text-amber-700 font-semibold" : "text-slate-400"}>
              Would become {fmt(newTotal)}
            </span>
          </div>

          {!waiting && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <label className="text-sm text-slate-600">What went wrong</label>
              <textarea
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                rows={2}
                placeholder="Price typed as 12,000 instead of 1,200"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                onClick={submit}
                disabled={busy || changed.length === 0}
                className="w-full py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {busy ? "..." : `Send ${changed.length || ""} line(s) to finance`}
              </button>
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold mb-2">Earlier requests</h3>
              <div className="space-y-2">
                {history.map((h) => (
                  <div
                    key={h.id}
                    className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs"
                  >
                    <div className="flex justify-between">
                      <span className="font-medium">{h.reason}</span>
                      <span
                        className={
                          h.status === "applied"
                            ? "text-green-700 font-semibold"
                            : h.status === "rejected"
                            ? "text-red-600 font-semibold"
                            : "text-amber-700 font-semibold"
                        }
                      >
                        {h.status}
                      </span>
                    </div>
                    <div className="text-slate-400 mt-0.5">
                      {h.requested_by} &middot;{" "}
                      {new Date(h.requested_at).toLocaleDateString()}
                      {h.decision_note ? ` — ${h.decision_note}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
