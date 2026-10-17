"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

function fmt(n: number) {
  return Math.round(Number(n) || 0).toLocaleString() + " MMK";
}

// What customers still owe on sales that were only part-paid. The shop takes
// the rest here; nothing about the original invoice changes.
type Row = {
  id: string;
  sale_ref: string;
  store_id: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  total: number;
  advance_payment: number;
  balance_due: number;
  sale_rep_name: string | null;
  days_outstanding: number;
};

type Method = { code: string; name: string; is_cash: boolean };

export default function ReceivablesPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");

  const [payRow, setPayRow] = useState<Row | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "sales-report")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    supabase
      .from("payment_methods")
      .select("code,name,is_cash")
      .eq("use_in_pos", true)
      .order("sort_order")
      .then(({ data }) => {
        setMethods((data as Method[]) || []);
        if (data && data.length > 0) setMethod(data[0].code);
      });
  }, []);

  // An office account sees every branch; a branch account sees its own.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, profile?.id]);

  async function load() {
    setLoading(true);
    let q = supabase
      .from("sale_receivables")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(500);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q;
    if (error) showToast("❌ " + error.message);
    setRows((data as Row[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function storeName(id: string) {
    return stores.find((s) => s.id === id)?.name || id;
  }

  function openPay(r: Row) {
    setPayRow(r);
    setAmount(String(Math.round(Number(r.balance_due) || 0)));
    setReference("");
    setNote("");
  }

  async function submit() {
    if (!payRow) return;
    const amt = Number(amount) || 0;
    if (amt <= 0) return showToast("Enter the amount taken");
    if (amt > Number(payRow.balance_due)) return showToast("That is more than is owing");
    if (!method) return showToast("Pick how it was paid");
    setSaving(true);
    try {
      const { error } = await supabase.rpc("collect_sale_balance", {
        p_sale_id: payRow.id,
        p_lines: [{ method, amount: amt, reference: reference.trim() || null }],
        p_note: note.trim() || null,
      });
      if (error) throw error;
      showToast(`${payRow.sale_ref}: ${fmt(amt)} taken`);
      setPayRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  if (!profile || !hasPermission(profile, "sales-report")) return null;

  const term = search.trim().toLowerCase();
  const shown = term
    ? rows.filter(
        (r) =>
          (r.customer_name || "").toLowerCase().includes(term) ||
          r.sale_ref.toLowerCase().includes(term)
      )
    : rows;
  const owed = shown.reduce((s, r) => s + (Number(r.balance_due) || 0), 0);

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">Outstanding balances</h2>
      <p className="text-sm text-slate-500 mb-4">
        Sales that were only part-paid. Taking the rest here leaves the original
        invoice untouched.
      </p>

      <div className="flex items-center gap-2 mb-3">
        <input
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-64"
          placeholder="Customer or invoice"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="ml-auto text-sm text-slate-500">
          {shown.length} &middot; <span className="font-semibold">{fmt(owed)}</span> owing
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Invoice</th>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Shop</th>
              <th className="text-left px-3 py-2">Customer</th>
              <th className="text-right px-3 py-2">Bill</th>
              <th className="text-right px-3 py-2">Paid</th>
              <th className="text-right px-3 py-2">Owing</th>
              <th className="text-right px-3 py-2">Days</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="text-center text-slate-400 py-8">
                  ...
                </td>
              </tr>
            )}
            {!loading &&
              shown.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/history?ref=${r.sale_ref}`} className="text-blue-600">
                      {r.sale_ref}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">{storeName(r.store_id)}</td>
                  <td className="px-3 py-2">
                    {r.customer_name || "-"}
                    {r.sale_rep_name && (
                      <div className="text-[10px] text-slate-400">{r.sale_rep_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">{fmt(r.total)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">
                    {fmt(r.advance_payment)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-orange-600">
                    {fmt(r.balance_due)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right text-xs ${
                      r.days_outstanding > 30 ? "text-red-600 font-semibold" : "text-slate-400"
                    }`}
                  >
                    {r.days_outstanding}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => openPay(r)}
                      className="text-green-700 text-xs font-semibold whitespace-nowrap"
                    >
                      Take payment
                    </button>
                  </td>
                </tr>
              ))}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-slate-400 py-8">
                  Nothing owing.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {payRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">Take payment</h3>
            <p className="text-sm text-slate-500 mb-3">
              {payRow.sale_ref} &middot; {payRow.customer_name || "-"}
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Owing</span>
                <span className="font-bold">{fmt(payRow.balance_due)}</span>
              </div>
            </div>

            <label className="text-sm text-slate-600">Amount</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />

            <label className="text-sm text-slate-600">Paid by</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {methods.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">Reference</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              placeholder="Transaction id"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />

            <label className="text-sm text-slate-600">Note</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <div className="flex gap-2">
              <button
                onClick={() => setPayRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={saving}
                className="flex-1 py-2.5 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? "..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
