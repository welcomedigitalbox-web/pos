"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import * as XLSX from "xlsx";

type Draft = {
  sku: string; store: string; qty: number; unit_cost: number;
  expiry: string; ok: boolean; why?: string; name?: string;
};

const HEADERS = ["SKU", "Store", "Qty", "Unit Cost", "Expiry Date"];
const num = (v: unknown) => Number(String(v ?? "").replace(/[, ]/g, "")) || 0;

// Excel hands dates back as a serial number unless the cell is text.
const asDate = (v: unknown) => {
  if (v === "" || v == null) return "";
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.y}-${p(d.m)}-${p(d.d)}`;
  }
  const t = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
};

export default function StockImportPage() {
  const [rows, setRows] = useState<Draft[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    supabase.from("stores").select("id,name").order("id")
      .then(({ data }) => setStores((data as { id: string; name: string }[]) || []));
  }, []);

  function template() {
    const rowsOut = [HEADERS, ["EB-1001", stores[0]?.id ?? "BAK_STORE", 120, 3500, "2027-06-30"]];
    const ws = XLSX.utils.aoa_to_sheet(rowsOut);
    ws["!cols"] = [{ wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Opening Stock");
    // A second sheet so nobody has to guess the store codes.
    const ids = XLSX.utils.aoa_to_sheet([["Store code", "Name"], ...stores.map((s) => [s.id, s.name])]);
    XLSX.utils.book_append_sheet(wb, ids, "Store codes");
    XLSX.writeFile(wb, "opening-stock-template.xlsx");
  }

  async function pick(file: File) {
    setMsg(""); setFileName(file.name);
    const wb = XLSX.read(await file.arrayBuffer());
    const sheet = wb.Sheets["Opening Stock"] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const { data: prods } = await supabase.from("products").select("sku, name");
    const known = new Map(((prods as { sku: string | null; name: string }[]) || [])
      .filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p.name]));
    const storeIds = new Set(stores.map((s) => s.id));

    const out: Draft[] = [];
    for (const r of raw) {
      const sku = String(r["SKU"] ?? r["sku"] ?? "").trim();
      const store = String(r["Store"] ?? r["store"] ?? "").trim();
      if (!sku && !store) continue;
      const d: Draft = {
        sku, store, qty: num(r["Qty"] ?? r["qty"]),
        unit_cost: num(r["Unit Cost"] ?? r["unit_cost"]),
        expiry: asDate(r["Expiry Date"] ?? r["expiry"]),
        ok: true, name: known.get(sku.toLowerCase()),
      };
      if (!known.has(sku.toLowerCase())) { d.ok = false; d.why = "unknown SKU"; }
      else if (!storeIds.has(store)) { d.ok = false; d.why = "unknown store code"; }
      else if (d.qty <= 0) { d.ok = false; d.why = "quantity must be above zero"; }
      else if (d.unit_cost <= 0) { d.ok = false; d.why = "cost must be above zero"; }
      out.push(d);
    }
    setRows(out);
    setMsg(`${out.length} rows · ${out.filter((x) => x.ok).length} ready · ${out.filter((x) => !x.ok).length} to fix`);
  }

  async function run() {
    const good = rows.filter((r) => r.ok);
    if (good.length === 0) return setMsg("Nothing to import");
    if (!confirm(`Import ${good.length} rows? Running this twice adds the stock twice.`)) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("import_opening_stock", {
      p_rows: good.map((r) => ({
        sku: r.sku, store: r.store, qty: r.qty, unit_cost: r.unit_cost, expiry: r.expiry,
      })),
    });
    setBusy(false);
    if (error) return setMsg(error.message);
    const res = data as { imported: number; failed: number };
    setMsg(`${res.imported} imported${res.failed ? `, ${res.failed} failed` : ""}`);
    setRows([]);
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold mb-1">Opening Stock</h1>
      <p className="text-sm text-slate-500 mb-5">
        One row per product per shop. Each row becomes a purchase batch, so FIFO and the average
        cost stay correct. Import a file once — running it again adds the stock a second time.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
        <div className="flex flex-wrap gap-2 mb-4">
          {HEADERS.map((h) => (
            <span key={h} className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600">{h}</span>
          ))}
        </div>
        <button onClick={template}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm mb-4 block">
          Download template
        </button>
        <input type="file" accept=".xlsx,.xls,.csv"
          onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} className="text-sm" />
        {fileName && <span className="text-xs text-slate-400 ml-2">{fileName}</span>}
      </div>

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-700">{msg}</div>}

      {rows.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-500">Rows marked in red are left out.</span>
            <div className="flex gap-2">
              <button onClick={() => { setRows([]); setMsg(""); setFileName(""); }}
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm">Cancel</button>
              <button onClick={run} disabled={busy}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-40">
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[60vh]">
            <table className="w-full text-xs min-w-[820px]">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  {["SKU", "Product", "Store", "Qty", "Unit Cost", "Value", "Expiry", "Note"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={"border-t border-slate-100 " + (r.ok ? "" : "bg-red-50")}>
                    <td className="px-3 py-1.5">{r.sku || "-"}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.name || "-"}</td>
                    <td className="px-3 py-1.5">{r.store || "-"}</td>
                    <td className="px-3 py-1.5 text-right">{r.qty.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right">{r.unit_cost.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">
                      {(r.qty * r.unit_cost).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{r.expiry || "-"}</td>
                    <td className="px-3 py-1.5 text-red-600">{r.why || ""}</td>
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
