"use client";

import { useEffect, useState } from "react";
import { matchesSearch } from "@/lib/search";
import { useRouter } from "next/navigation";
import { supabase, fetchAllProducts } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Product = { id: string; sku: string | null; name: string; price: number | null };
type Row = {
  id: string; product_id: string; new_price: number; effective_on: string;
  note: string | null; created_by: string | null; applied_at: string | null;
  old_price: number | null;
};

const money = (n: number | null | undefined) =>
  n == null ? "-" : Number(n).toLocaleString("en-US");

// A price agreed today but starting later. Writing it down here means nobody
// has to remember to change it on the morning, and the till needs to know
// nothing about any of it: the price it reads is changed when the day comes.
export default function PriceSchedulePage() {
  const { profile } = useAuth();
  const router = useRouter();
  const blocked = !profile || !hasPermission(profile, "price-schedule");
  useEffect(() => {
    if (profile && !hasPermission(profile, "price-schedule")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Product[]>([]);
  const [pick, setPick] = useState<Product | null>(null);
  const [price, setPrice] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, Product>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    const { data } = await supabase
      .from("price_schedule")
      .select("*")
      .order("effective_on", { ascending: true })
      .limit(500);
    const list = (data as Row[]) || [];
    setRows(list);
    // The names are looked up in batches: "in" with hundreds of ids makes a
    // request too long to send, and a missing name shows the raw id, which
    // means nothing to the person reading the list.
    const ids = Array.from(new Set(list.map((r) => r.product_id)));
    const by: Record<string, Product> = {};
    for (let i = 0; i < ids.length; i += 100) {
      const { data: ps } = await supabase
        .from("products").select("id, sku, name, price").in("id", ids.slice(i, i + 100));
      for (const p of ((ps as Product[]) || [])) by[p.id] = p;
    }
    setNames(by);
  }
  useEffect(() => { if (profile && !blocked) load(); /* eslint-disable-next-line */ }, [profile]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setFound([]); return; }
    let live = true;
    // Matched here rather than by the database, so a name holding two spaces
    // or a bracket is still found, and the words may be typed in any order.
    fetchAllProducts<Product>("id, sku, name, price", true).then((rows) => {
      if (!live) return;
      setFound(rows.filter((r) => matchesSearch(q, r.name, r.sku)).slice(0, 20));
    });
    return () => { live = false; };
  }, [search]);

  async function add() {
    if (!pick || !price.trim() || !date) return setMsg("Pick a product, a price and a date");
    setBusy(true); setMsg("");
    const { error } = await supabase.from("price_schedule").insert({
      product_id: pick.id,
      new_price: Number(price.replace(/[, ]/g, "")),
      effective_on: date,
      note: note.trim() || null,
      created_by: profile?.email || null,
    });
    setBusy(false);
    if (error) return setMsg(error.message);
    setPick(null); setPrice(""); setNote(""); setSearch(""); setFound([]);
    setMsg("Scheduled");
    await load();
  }

  async function drop(id: string) {
    const { error } = await supabase.from("price_schedule").delete().eq("id", id);
    if (error) return setMsg(error.message);
    load();
  }

  async function applyNow() {
    setBusy(true);
    const { data, error } = await supabase.rpc("apply_due_price_changes");
    setBusy(false);
    setMsg(error ? error.message : `${data ?? 0} applied`);
    load();
  }

  if (blocked) return null;

  const pending = rows.filter((r) => !r.applied_at);
  const done = rows.filter((r) => r.applied_at).slice(-30).reverse();

  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <h1 className="text-xl font-semibold">Scheduled price changes</h1>
      <p className="text-sm text-slate-500 mt-0.5 mb-4">
        A new price takes effect on the morning of the date you set. Until then
        the tills keep selling at the old one.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-5">
        {pick ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[14rem]">
              <div className="text-xs text-slate-500">Product</div>
              <div className="text-sm font-medium">{pick.name}</div>
              <div className="text-xs text-slate-400">
                {pick.sku} · now {money(pick.price)} MMK
              </div>
            </div>
            <label className="text-xs text-slate-500">
              New price
              <input value={price} onChange={(e) => setPrice(e.target.value)}
                inputMode="numeric"
                className="mt-1 block w-32 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Starts on
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="mt-1 block border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-slate-500 grow">
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)}
                className="mt-1 block w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <button onClick={add} disabled={busy}
              className="px-4 py-2 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">
              Schedule
            </button>
            <button onClick={() => setPick(null)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm">Cancel</button>
          </div>
        ) : (
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a product or SKU…"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            {found.length > 0 && (
              <ul className="border border-slate-200 rounded-lg mt-2 divide-y divide-slate-100 max-h-60 overflow-y-auto">
                {found.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => { setPick(p); setPrice(String(p.price ?? "")); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50">
                      {p.name}
                      <span className="text-xs text-slate-400 ml-2">
                        {p.sku} · {money(p.price)} MMK
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {msg && <p className="text-xs text-slate-500 mt-2">{msg}</p>}
      </div>

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">Waiting ({pending.length})</h2>
        <button onClick={applyNow} disabled={busy}
          className="text-xs text-blue-600 underline">Apply anything due now</button>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-right px-3 py-2">Now</th>
              <th className="text-right px-3 py-2">New</th>
              <th className="text-left px-3 py-2">Starts</th>
              <th className="text-left px-3 py-2">By</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pending.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  {names[r.product_id]?.name || r.product_id}
                  {r.note && <span className="block text-xs text-slate-400">{r.note}</span>}
                </td>
                <td className="px-3 py-2 text-right text-slate-500">
                  {money(names[r.product_id]?.price)}
                </td>
                <td className="px-3 py-2 text-right font-medium">{money(r.new_price)}</td>
                <td className="px-3 py-2">{r.effective_on}</td>
                <td className="px-3 py-2 text-xs text-slate-400">{r.created_by}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => drop(r.id)}
                    className="text-xs text-red-600 underline">Remove</button>
                </td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Nothing waiting</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {done.length > 0 && (
        <>
          <h2 className="text-sm font-semibold mb-2">Already applied</h2>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {done.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">{names[r.product_id]?.name || r.product_id}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{money(r.old_price)}</td>
                    <td className="px-3 py-2 text-right">{money(r.new_price)}</td>
                    <td className="px-3 py-2">{r.effective_on}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{r.created_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
