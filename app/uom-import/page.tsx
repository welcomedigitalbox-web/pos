"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import * as XLSX from "xlsx";

type Draft = {
  sku: string; code: string; name: string; factor: number;
  barcode: string; price: number | null; base: boolean;
  ok: boolean; why?: string; product?: string;
};

const HEADERS = ["SKU", "Unit Code", "Unit Name", "Factor", "Barcode", "Unit Price"];
const num = (v: unknown) => Number(String(v ?? "").replace(/[, ]/g, "")) || 0;

export default function UomImportPage() {
  // A page nobody navigated to can still be typed into the address bar,
  // so the page checks for itself.
  const { profile } = useAuth();
  const router = useRouter();
  const pageBlocked = !profile || !hasPermission(profile, "uom-import");
  useEffect(() => {
    if (profile && !hasPermission(profile, "uom-import")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [rows, setRows] = useState<Draft[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");

  function template() {
    const out = [
      HEADERS,
      ["EB-1001", "pc", "Piece", 1, "8851234567890", 28500],
      ["EB-1001", "pkg", "Package", 6, "8851234567891", 168000],
      ["EB-1001", "ctn", "Carton", 24, "8851234567892", 660000],
    ];
    const ws = XLSX.utils.aoa_to_sheet(out);
    ws["!cols"] = [{ wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 20 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Units");
    XLSX.writeFile(wb, "units-template.xlsx");
  }

  async function pick(file: File) {
    setMsg(""); setFileName(file.name);
    const wb = XLSX.read(await file.arrayBuffer());
    const sheet = wb.Sheets["Units"] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const { data: prods } = await supabase.from("products").select("sku, name");
    const known = new Map(((prods as { sku: string | null; name: string }[]) || [])
      .filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p.name]));

    const seen = new Set<string>();
    const out: Draft[] = [];
    for (const r of raw) {
      const sku = String(r["SKU"] ?? r["sku"] ?? "").trim();
      const code = String(r["Unit Code"] ?? r["code"] ?? "").trim();
      if (!sku && !code) continue;
      const factor = num(r["Factor"] ?? r["factor"]);
      const d: Draft = {
        sku, code,
        name: String(r["Unit Name"] ?? r["name"] ?? code).trim(),
        factor,
        barcode: String(r["Barcode"] ?? r["barcode"] ?? "").trim(),
        price: String(r["Unit Price"] ?? "").trim() === "" ? null : num(r["Unit Price"]),
        base: factor === 1,
        ok: true, product: known.get(sku.toLowerCase()),
      };
      const key = `${sku.toLowerCase()}|${code.toLowerCase()}`;
      if (!known.has(sku.toLowerCase())) { d.ok = false; d.why = "unknown SKU"; }
      else if (!code) { d.ok = false; d.why = "unit code missing"; }
      else if (factor <= 0) { d.ok = false; d.why = "factor must be above zero"; }
      else if (seen.has(key)) { d.ok = false; d.why = "repeated in file"; }
      seen.add(key);
      out.push(d);
    }
    // Every product needs exactly one base unit.
    const bySku = new Map<string, Draft[]>();
    for (const d of out.filter((x) => x.ok)) {
      bySku.set(d.sku.toLowerCase(), [...(bySku.get(d.sku.toLowerCase()) || []), d]);
    }
    for (const [, list] of bySku) {
      if (!list.some((d) => d.factor === 1)) {
        for (const d of list) { d.ok = false; d.why = "no unit with factor 1"; }
      }
    }
    setRows(out);
    setMsg(`${out.length} rows · ${out.filter((x) => x.ok).length} ready · ${out.filter((x) => !x.ok).length} to fix`);
  }

  async function run() {
    const good = rows.filter((r) => r.ok);
    if (good.length === 0) return setMsg("Nothing to import");
    setBusy(true);

    const { data: prods } = await supabase.from("products").select("id, sku");
    const idOf = new Map(((prods as { id: string; sku: string | null }[]) || [])
      .filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p.id]));

    const { data: existing } = await supabase.from("product_uoms").select("id, product_id, code");
    const have = new Map(((existing as { id: string; product_id: string; code: string }[]) || [])
      .map((u) => [`${u.product_id}|${u.code.toLowerCase()}`, u.id]));

    let ok = 0, bad = 0;
    for (const r of good) {
      const pid = idOf.get(r.sku.toLowerCase());
      if (!pid) { bad++; continue; }
      const payload = {
        product_id: pid, code: r.code, name: r.name || r.code,
        factor: r.factor, barcode: r.barcode || null, price: r.price,
        is_base: r.factor === 1, is_active: true,
      };
      const id = have.get(`${pid}|${r.code.toLowerCase()}`);
      const { error } = id
        ? await supabase.from("product_uoms").update(payload).eq("id", id)
        : await supabase.from("product_uoms").insert(payload);
      error ? bad++ : ok++;
    }
    setBusy(false);
    setMsg(`${ok} imported${bad ? `, ${bad} failed` : ""}`);
    setRows([]);
  }

  if (pageBlocked) return null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold mb-1">Units of Measure</h1>
      <p className="text-sm text-slate-500 mb-5">
        One row per selling unit. Factor is how many base units it holds — a piece is 1, a carton
        of 24 is 24. Every product needs one row with factor 1.
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
            <span className="text-sm text-slate-500">A unit code that already exists is updated.</span>
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
            <table className="w-full text-xs min-w-[860px]">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  {["SKU", "Product", "Code", "Name", "Factor", "Barcode", "Price", "Base", "Note"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={"border-t border-slate-100 " + (r.ok ? "" : "bg-red-50")}>
                    <td className="px-3 py-1.5">{r.sku || "-"}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.product || "-"}</td>
                    <td className="px-3 py-1.5">{r.code || "-"}</td>
                    <td className="px-3 py-1.5">{r.name || "-"}</td>
                    <td className="px-3 py-1.5 text-right">{r.factor}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.barcode || "-"}</td>
                    <td className="px-3 py-1.5 text-right">
                      {r.price == null ? "-" : r.price.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-center">{r.base ? "✓" : ""}</td>
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
