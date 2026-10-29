"use client";

import { useEffect, useState } from "react";
import { matchesSearch } from "@/lib/search";
import { useRouter } from "next/navigation";
import { supabase, fetchAllProducts, fetchSupplierCodeMap } from "@/lib/supabase";
import * as XLSX from "xlsx";
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

  const [codes, setCodes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Product[]>([]);
  const [pick, setPick] = useState<Product | null>(null);
  const [price, setPrice] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, Product>>({});
  const [busy, setBusy] = useState(false);
  // Lines put together by hand, waiting to be written down together.
  const [draft, setDraft] = useState<
    { product: Product; price: string; date: string; note: string }[]
  >([]);

  // Thousands of prices change at once when a supplier reprices a range, and
  // nobody is typing those one at a time. The sheet is the list of prices as
  // it already arrives from the supplier.
  const [impRows, setImpRows] = useState<
    { sku: string; name: string; product_id: string | null; now: number | null;
      new_price: number; on: string; note: string; ok: boolean; why: string }[]
  >([]);
  const [impBusy, setImpBusy] = useState(false);
  const [impMsg, setImpMsg] = useState("");
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
    Promise.all([fetchSupplierCodeMap(), fetchAllProducts<Product>("id, sku, name, price", true)])
      .then(([map, rows]) => {
        if (!live) return;
        setCodes(map);
        setFound(rows.filter((r) => matchesSearch(q, r.name, r.sku, map[r.id])).slice(0, 20));
      });
    return () => { live = false; };
  }, [search]);

  // Adding keeps the date, because a batch of prices usually starts on the
  // same morning, and clears the product so the next one can be searched.
  function addToDraft() {
    if (!pick || !price.trim() || !date) {
      return setMsg("Pick a product, a price and a date");
    }
    setDraft((d) => [...d, { product: pick, price, date, note }]);
    setPick(null); setPrice(""); setNote(""); setSearch(""); setFound([]);
    setMsg("");
  }

  async function saveDraft() {
    if (draft.length === 0) return;
    setBusy(true); setMsg("");
    const { error } = await supabase.from("price_schedule").insert(
      draft.map((d) => ({
        product_id: d.product.id,
        new_price: Number(d.price.replace(/[, ]/g, "")),
        effective_on: d.date,
        note: d.note.trim() || null,
        created_by: profile?.email || null,
      }))
    );
    setBusy(false);
    if (error) return setMsg(error.message);
    setMsg(`${draft.length} scheduled`);
    setDraft([]);
    await load();
  }

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

  // A sheet already filled with what each product costs today, so the only
  // column anyone has to touch is the new price.
  async function downloadTemplate() {
    setImpBusy(true);
    const all = await fetchAllProducts<Product>("id, sku, name, price", true);
    const head = ["SKU", "Product", "Price now", "New price", "Starts on (YYYY-MM-DD)", "Note"];
    const body = all
      .filter((p) => p.sku)
      .map((p) => [p.sku, p.name, Number(p.price) || 0, "", "", ""]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
    ws["!cols"] = [{ wch: 16 }, { wch: 46 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 28 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Price schedule");
    XLSX.writeFile(wb, `price-schedule-${new Date().toISOString().slice(0, 10)}.xlsx`);
    setImpBusy(false);
  }

  // Excel hands dates back as a serial number as often as a string, so both
  // are accepted and anything else is refused rather than guessed at.
  function readDate(v: unknown): string {
    if (v == null || v === "") return "";
    if (typeof v === "number") {
      const d = XLSX.SSF.parse_date_code(v);
      if (!d) return "";
      return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    const t = String(v).trim();
    const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const d2 = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (d2) return `${d2[3]}-${d2[2].padStart(2, "0")}-${d2[1].padStart(2, "0")}`;
    return "";
  }

  async function readSheet(file: File) {
    setImpBusy(true);
    setImpMsg("");
    const wb = XLSX.read(await file.arrayBuffer());
    const sheet = wb.Sheets["Price schedule"] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const all = await fetchAllProducts<Product>("id, sku, name, price", true);
    const bySku = new Map(all.filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p]));
    const today = new Date().toISOString().slice(0, 10);

    const out = raw.map((r) => {
      const sku = String(r["SKU"] ?? r["sku"] ?? "").trim();
      const hit = bySku.get(sku.toLowerCase());
      const np = Number(String(r["New price"] ?? r["new_price"] ?? "").toString().replace(/[, ]/g, ""));
      const on = readDate(r["Starts on (YYYY-MM-DD)"] ?? r["Starts on"] ?? r["starts_on"]);
      const row = {
        sku,
        name: hit?.name || String(r["Product"] ?? ""),
        product_id: hit?.id ?? null,
        now: hit?.price ?? null,
        new_price: np,
        on,
        note: String(r["Note"] ?? r["note"] ?? "").trim(),
        ok: true,
        why: "",
      };
      if (!sku) { row.ok = false; row.why = "no SKU"; }
      else if (!hit) { row.ok = false; row.why = "SKU not found"; }
      else if (!np || np <= 0) { row.ok = false; row.why = "no new price"; }
      else if (!on) { row.ok = false; row.why = "no start date"; }
      else if (on < today) { row.ok = false; row.why = "start date is in the past"; }
      else if (Number(hit.price) === np) { row.ok = false; row.why = "same as the price now"; }
      return row;
    }).filter((r) => r.sku || r.new_price);

    setImpRows(out);
    setImpMsg(`${out.length} rows · ${out.filter((r) => r.ok).length} ready · ${out.filter((r) => !r.ok).length} to fix`);
    setImpBusy(false);
  }

  async function commitSheet() {
    const good = impRows.filter((r) => r.ok && r.product_id);
    if (!good.length) return;
    setImpBusy(true);
    // In batches, because a single insert of thousands of rows is one request
    // the browser can lose halfway and nobody knows what landed.
    let done = 0;
    for (let i = 0; i < good.length; i += 400) {
      const chunk = good.slice(i, i + 400).map((r) => ({
        product_id: r.product_id,
        new_price: r.new_price,
        effective_on: r.on,
        note: r.note || "bulk import",
        created_by: profile?.email || null,
      }));
      const { error } = await supabase.from("price_schedule").insert(chunk);
      if (error) {
        setImpMsg(`${done} scheduled, then: ${error.message}`);
        setImpBusy(false);
        await load();
        return;
      }
      done += chunk.length;
      setImpMsg(`${done} / ${good.length} scheduled...`);
    }
    setImpRows([]);
    setImpMsg(`${done} price change(s) scheduled`);
    setImpBusy(false);
    await load();
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
            <button onClick={addToDraft} disabled={busy}
              className="px-4 py-2 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">
              Add
            </button>
            <button onClick={add} disabled={busy}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
              Add &amp; save now
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
        {draft.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">To be scheduled ({draft.length})</h3>
              <button onClick={saveDraft} disabled={busy}
                className="px-4 py-2 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">
                Schedule all
              </button>
            </div>
            <table className="min-w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1">Product</th>
                  <th className="text-right px-2 py-1">Now</th>
                  <th className="text-right px-2 py-1">New</th>
                  <th className="text-left px-2 py-1">Starts</th>
                  <th className="text-left px-2 py-1">Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.map((d, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1">
                      {d.product.name}
                      <span className="text-xs text-slate-400 ml-1">{d.product.sku}</span>
                    </td>
                    <td className="px-2 py-1 text-right text-slate-400">
                      {money(d.product.price)}
                    </td>
                    <td className="px-2 py-1 text-right font-medium">{d.price}</td>
                    <td className="px-2 py-1">{d.date}</td>
                    <td className="px-2 py-1 text-slate-500">{d.note}</td>
                    <td className="px-2 py-1 text-right">
                      <button
                        onClick={() => setDraft((r) => r.filter((_, n) => n !== i))}
                        className="text-xs text-red-600"
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <p className="text-xs text-slate-500 mt-2">{msg}</p>}
      </div>

      {/* The bulk route. One sheet, thousands of prices, one start date each. */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-5">
        <h2 className="text-sm font-semibold">Many at once (Excel)</h2>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">
          Download the sheet, fill in <b>New price</b> and <b>Starts on</b>, upload it
          back. Rows you leave blank are ignored.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={downloadTemplate}
            disabled={impBusy}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm font-medium bg-white disabled:opacity-50"
          >
            ⬇ Download sheet
          </button>
          <label className="text-sm">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readSheet(f);
                e.target.value = "";
              }}
            />
          </label>
          {impRows.some((r) => r.ok) && (
            <button
              onClick={commitSheet}
              disabled={impBusy}
              className="bg-slate-900 text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Schedule {impRows.filter((r) => r.ok).length} price change(s)
            </button>
          )}
        </div>

        {impMsg && <p className="text-xs text-slate-600 mt-2">{impMsg}</p>}

        {impRows.length > 0 && (
          <div className="mt-3 border border-slate-200 rounded-lg overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">SKU</th>
                  <th className="text-left px-3 py-2">Product</th>
                  <th className="text-right px-3 py-2">Now</th>
                  <th className="text-right px-3 py-2">New</th>
                  <th className="text-left px-3 py-2">Starts</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {impRows.slice(0, 400).map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className={`border-t border-slate-100 ${r.ok ? "" : "bg-red-50"}`}>
                    <td className="px-3 py-1.5 font-mono">{r.sku || "-"}</td>
                    <td className="px-3 py-1.5">{r.name || "-"}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">{money(r.now)}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{money(r.new_price)}</td>
                    <td className="px-3 py-1.5">{r.on || "-"}</td>
                    <td className="px-3 py-1.5 text-red-600">{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {impRows.length > 400 && (
              <p className="text-xs text-slate-400 px-3 py-2">
                Showing the first 400 of {impRows.length}; all of them are scheduled.
              </p>
            )}
          </div>
        )}
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
