"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/app/auth-context";

type P = { id: string; email: string; role: string | null };
type A = { id: string; for_profile: string; acting_profile: string; from_date: string; to_date: string | null; reason: string | null };

const today = () => new Date().toISOString().slice(0, 10);
const FIELD = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";

export default function ActingPage() {
  const { profile } = useAuth();
  const [people, setPeople] = useState<P[]>([]);
  const [rows, setRows] = useState<A[]>([]);
  const [seat, setSeat] = useState("");
  const [who, setWho] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    const [p, a] = await Promise.all([
      supabase.from("profiles").select("id,email,role").order("email"),
      supabase.from("org_acting").select("*").order("from_date", { ascending: false }),
    ]);
    setPeople((p.data as P[]) || []);
    setRows((a.data as A[]) || []);
  }
  useEffect(() => { load(); }, []);

  if (!profile || profile.role !== "admin") return null;

  const name = (id: string) => people.find((p) => p.id === id)?.email || id;
  const live = (a: A) => a.from_date <= today() && (!a.to_date || a.to_date >= today());

  async function add() {
    if (!seat || !who || seat === who) return setMsg("Pick two different people");
    const { error } = await supabase.from("org_acting").insert({
      for_profile: seat, acting_profile: who, from_date: from, to_date: to || null, reason: reason || null,
    });
    if (error) return setMsg("❌ " + error.message);
    setSeat(""); setWho(""); setTo(""); setReason(""); setMsg("✅"); load();
  }

  async function end(a: A) {
    await supabase.from("org_acting").update({ to_date: today() }).eq("id", a.id);
    load();
  }

  return (
    <div className="p-4 max-w-4xl">
      <h1 className="text-lg font-semibold mb-1">Acting</h1>
      <p className="text-sm text-slate-500 mb-4">
        While a manager is away or the seat is empty, someone else signs for them.
        Without this, reports climb to the next manager up on their own.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <div>
          <label className="text-xs text-slate-500">Seat (the manager who is away)</label>
          <select className={FIELD} value={seat} onChange={(e) => setSeat(e.target.value)}>
            <option value="">-</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.email} · {p.role}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">Acting (who signs meanwhile)</label>
          <select className={FIELD} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">-</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.email} · {p.role}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">From</label>
          <input type="date" className={FIELD} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-500">To (blank = until ended)</label>
          <input type="date" className={FIELD} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs text-slate-500">Reason</label>
          <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="resigned / leave / vacancy" />
        </div>
        <div className="sm:col-span-2 flex justify-between items-center">
          <span className="text-sm">{msg}</span>
          <button onClick={add} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">Save</button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Seat</th>
              <th className="text-left px-3 py-2">Acting</th>
              <th className="text-left px-3 py-2">From</th>
              <th className="text-left px-3 py-2">To</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={"border-t border-slate-100 " + (live(a) ? "" : "opacity-40")}>
                <td className="px-3 py-2">{name(a.for_profile)}</td>
                <td className="px-3 py-2 font-medium">{name(a.acting_profile)}</td>
                <td className="px-3 py-2">{a.from_date}</td>
                <td className="px-3 py-2">{a.to_date || "—"}</td>
                <td className="px-3 py-2 text-slate-500">{a.reason || "-"}</td>
                <td className="px-3 py-2 text-right">
                  {live(a) && <button onClick={() => end(a)} className="text-red-600 text-xs">End today</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={6}>Nobody is acting for anyone.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
