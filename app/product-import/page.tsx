"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import * as XLSX from "xlsx";

type Draft = {
  sku: string; name: string; category: string; price: number;
  min_price: number | null; allow_discount: boolean; allow_promotion: boolean;
  status: "new" | "update" | "skip"; reason?: string;
};

const HEADERS = ["SKU", "Product Name", "Category Name", "Retail Price (MMK)",
  "Min Price", "Allow Discount", "Allow Promotion"];

const yes = (v: unknown) => {
  const t = String(v ?? "").trim().toLowerCase();
  return !(t === "no" || t === "n" || t === "false" || t === "0");
};
const num = (v: unknown) => {
  const t = String(v ?? "").replace(/[, ]/g, "");
  return t === "" ? null : Number(t);
};

export default function ProductImportPage() {
  // A page nobody navigated to can still be typed into the address bar,
  // so the page checks for itself.
  const { profile } = useAuth();
  const router = useRouter();
  const pageBlocked = !profile || !hasPermission(profile, "product-import");
  useEffect(() => {
    if (profile && !hasPermission(profile, "product-import")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [rows, setRows] = useState<Draft[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");

  async function pick(file: File) {
    setMsg(""); setFileName(file.name);
    const wb = XLSX.read(await file.arrayBuffer());
    // The template puts products on a sheet of that name; any other workbook
    // falls back to its first sheet.
    const sheet = wb.Sheets["Products"] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const [{ data: existing }, { data: cats }] = await Promise.all([
      supabase.from("products").select("id, sku, name"),
      supabase.from("product_categories").select("id, name"),
    ]);
    const bySku = new Map(((existing as { id: string; sku: string | null }[]) || [])
      .filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p.id]));
    const catNames = new Set(((cats as { name: string }[]) || []).map((c) => c.name.trim().toLowerCase()));

    const seen = new Set<string>();
    const out: Draft[] = [];
    for (const r of raw) {
      const sku = String(r["SKU"] ?? r["sku"] ?? "").trim();
      const name = String(r["Product Name"] ?? r["name"] ?? r["Description"] ?? "").trim();
      const price = num(r["Retail Price (MMK)"] ?? r["price"] ?? r["Price"]);
      const category = String(r["Category Name"] ?? r["Category"] ?? "").trim();
      if (!sku && !name) continue;

      const d: Draft = {
        sku, name, category,
        price: price ?? 0,
        min_price: num(r["Min Price"] ?? r["min_price"]),
        allow_discount: yes(r["Allow Discount"] ?? "Yes"),
        allow_promotion: yes(r["Allow Promotion"] ?? "Yes"),
        status: "new",
      };
      if (!sku) { d.status = "skip"; d.reason = "SKU missing"; }
      else if (!name) { d.status = "skip"; d.reason = "Name missing"; }
      else if (price == null || isNaN(price)) { d.status = "skip"; d.reason = "Price missing"; }
      else if (seen.has(sku.toLowerCase())) { d.status = "skip"; d.reason = "SKU repeated in file"; }
      else if (bySku.has(sku.toLowerCase())) d.status = "update";
      seen.add(sku.toLowerCase());
      if (category && !catNames.has(category.toLowerCase()) && d.status !== "skip")
        d.reason = "new category will be created";
      out.push(d);
    }
    setRows(out);
    setMsg(`${out.length} rows read · ${out.filter((x) => x.status === "new").length} new · ` +
           `${out.filter((x) => x.status === "update").length} updates · ` +
           `${out.filter((x) => x.status === "skip").length} skipped`);
  }

  async function run() {
    const work = rows.filter((r) => r.status !== "skip");
    if (work.length === 0) return setMsg("Nothing to import");
    setBusy(true);

    // Categories first, so every product can point at one.
    const { data: cats } = await supabase.from("product_categories").select("id, name");
    const catId = new Map(((cats as { id: string; name: string }[]) || [])
      .map((c) => [c.name.trim().toLowerCase(), c.id]));
    const missing = Array.from(new Set(work.map((r) => r.category).filter(
      (c) => c && !catId.has(c.toLowerCase()))));
    if (missing.length) {
      const { data: made } = await supabase.from("product_categories")
        .insert(missing.map((name) => ({ name }))).select("id, name");
      for (const c of ((made as { id: string; name: string }[]) || []))
        catId.set(c.name.trim().toLowerCase(), c.id);
    }

    const { data: existing } = await supabase.from("products").select("id, sku");
    const bySku = new Map(((existing as { id: string; sku: string | null }[]) || [])
      .filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p.id]));

    let ok = 0, bad = 0;
    for (const r of work) {
      const payload = {
        sku: r.sku, name: r.name, price: r.price,
        category_id: r.category ? catId.get(r.category.toLowerCase()) ?? null : null,
        min_price: r.min_price, allow_discount: r.allow_discount,
        allow_promotion: r.allow_promotion, is_active: true,
      };
      const id = bySku.get(r.sku.toLowerCase());
      const { error } = id
        ? await supabase.from("products").update(payload).eq("id", id)
        : await supabase.from("products").insert(payload);
      error ? bad++ : ok++;
    }
    setBusy(false);
    setMsg(`${ok} imported${bad ? `, ${bad} failed` : ""}`);
    setRows([]);
  }

  // The blank workbook, with one example row showing the expected shape.
  function template() {
    const rows = [
      HEADERS,
      ["EB-1001", "Baby Llama Milk Powder 400g", "Milk Powder", 28500, 24000, "Yes", "Yes"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 16 }, { wch: 42 }, { wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 15 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    XLSX.writeFile(wb, "product-import-template.xlsx");
  }

  const tone: Record<Draft["status"], string> = {
    new: "bg-green-50 text-green-700",
    update: "bg-blue-50 text-blue-700",
    skip: "bg-red-50 text-red-600",
  };

  if (pageBlocked) return null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold mb-1">Import Products</h1>
      <p className="text-sm text-slate-500 mb-5">
        An .xlsx or .csv file. Products are matched by SKU — a known SKU is updated, a new one is added.
        Nothing is ever deleted.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
        <div className="text-xs text-slate-500 mb-2">Expected columns</div>
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
          onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
          className="text-sm" />
        {fileName && <span className="text-xs text-slate-400 ml-2">{fileName}</span>}
      </div>

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-700">{msg}</div>}

      {rows.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-500">Check the rows below, then import.</span>
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
            <table className="w-full text-xs min-w-[900px]">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  {["", "SKU", "Name", "Category", "Price", "Min Price", "Disc", "Promo", "Note"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">
                      <span className={"px-2 py-0.5 rounded " + tone[r.status]}>{r.status}</span>
                    </td>
                    <td className="px-3 py-1.5">{r.sku || "-"}</td>
                    <td className="px-3 py-1.5">{r.name || "-"}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.category || "-"}</td>
                    <td className="px-3 py-1.5 text-right">{r.price.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">
                      {r.min_price == null ? "-" : r.min_price.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-center">{r.allow_discount ? "✓" : "—"}</td>
                    <td className="px-3 py-1.5 text-center">{r.allow_promotion ? "✓" : "—"}</td>
                    <td className="px-3 py-1.5 text-slate-400">{r.reason || ""}</td>
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
