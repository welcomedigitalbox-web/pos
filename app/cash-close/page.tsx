"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/app/store-context";

type Acc = { id: string; code: string; name: string; is_cash: boolean; balance: number };
type Count = { count_date: string; expected: number; counted: number; note: string | null; closed_by: string | null };

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v: unknown) => Number(v || 0).toLocaleString() + " MMK";

export default function CashClosePage() {
  const { storeId } = useStore();
  const [accs, setAccs] = useState<Acc[]>([]);
  const [acc, setAcc] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [recent, setRecent] = useState<Count[]>([]);

  useEffect(() => {
    if (!storeId) return;
    supabase.rpc("fin_cash_accounts", { p_store: storeId }).then(({ data }) => {
      const rows = ((data || []) as Acc[]).filter((a) => a.is_cash);
      setAccs(rows);
      if (rows[0]) setAcc(rows[0].id);
    });
    supabase.from("fin_cash_counts").select("count_date, expected, counted, note, closed_by")
      .eq("store_id", storeId).order("count_date", { ascending: false }).limit(7)
      .then(({ data }) => setRecent((data as Count[]) || []));
  }, [storeId]);

  const chosen = accs.find((a) => a.id === acc);
  const expected = Number(chosen?.balance || 0);
  const diff = counted === "" ? 0 : Number(counted) - expected;

  async function close() {
    if (counted === "") return;
    if (diff !== 0 && !note.trim()) return setMsg("Write why it differs");
    setBusy(true);
    const { data, error } = await supabase.rpc("fin_close_cash", {
      p: { account_id: acc, store_id: storeId, count_date: today(),
           counted: Number(counted), note: note.trim() || null },
    });
    setBusy(false);
    if (error) return setMsg("❌ " + error.message);
    const r = (data || {}) as { difference?: number };
    setMsg("✅ Closed. Difference " + fmt(r.difference));
    setCounted(""); setNote("");
  }

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">Cash closing</h1>
      <p className="text-sm text-slate-500 mb-4">Count the till, then close the day.</p>

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div>
          <label className="text-sm text-slate-600">Account</label>
          <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accs.map((a) => (<option key={a.id} value={a.id}>{a.code} · {a.name}</option>))}
          </select>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-slate-600">The books say</span>
          <span className="font-semibold">{fmt(expected)}</span>
        </div>

        <div>
          <label className="text-sm text-slate-600">Counted</label>
          <input type="number" inputMode="numeric" value={counted}
            onChange={(e) => setCounted(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-lg mt-1" />
        </div>

        {counted !== "" && (
          <div className={"flex justify-between text-sm font-semibold " +
            (diff === 0 ? "text-green-700" : diff > 0 ? "text-blue-600" : "text-red-600")}>
            <span>Difference</span>
            <span>{fmt(diff)}</span>
          </div>
        )}

        <div>
          <label className="text-sm text-slate-600">Note{diff !== 0 ? " (required)" : ""}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1" />
        </div>

        <button onClick={close} disabled={busy || counted === ""}
          className="w-full py-3 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg font-semibold">
          {busy ? "..." : "Close the day"}
        </button>

        {msg && <p className="text-sm text-center">{msg}</p>}
      </div>

      <h2 className="font-semibold mt-6 mb-2">Last few days</h2>
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {recent.map((r) => (
              <tr key={r.count_date} className="border-t border-slate-100 first:border-t-0">
                <td className="px-3 py-2">{r.count_date}</td>
                <td className="px-3 py-2 text-right">{fmt(r.counted)}</td>
                <td className={"px-3 py-2 text-right " +
                  (Number(r.counted) - Number(r.expected) === 0 ? "text-slate-400" : "text-red-600")}>
                  {fmt(Number(r.counted) - Number(r.expected))}
                </td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={3}>Nothing yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
