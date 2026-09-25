"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Row = {
  id: string; sku: string | null; name: string; category_id: string | null;
  price: number; is_active: boolean;
  allow_discount: boolean | null; allow_promotion: boolean | null; min_price: number | null;
  avg_cost: number;
};
type Cat = { id: string; name: string };

const n = (v: unknown) => Number(v || 0).toLocaleString();

export default function ProductGridPage() {
  // A page nobody navigated to can still be typed into the address bar,
  // so the page checks for itself.
  const { profile } = useAuth();
  const router = useRouter();
  const pageBlocked = !profile || !hasPermission(profile, "product-grid");
  useEffect(() => {
    if (profile && !hasPermission(profile, "product-grid")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [rows, setRows] = useState<Row[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [byStore, setByStore] = useState<Record<string, Record<string, number>>>({});
  const [onOrder, setOnOrder] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [dirty, setDirty] = useState<Record<string, Partial<Row>>>({});
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    const [p, c, inv] = await Promise.all([
      supabase.from("products")
        .select("id, sku, name, category_id, price, is_active, allow_discount, allow_promotion, min_price")
        .order("sku", { nullsFirst: false }).order("name"),
      supabase.from("product_categories").select("id,name").order("sort_order"),
      supabase.from("store_inventory").select("product_id, stock_qty, avg_cost"),
    ]);
    // One cost per product: the weighted average across every shop holding it.
    const cost: Record<string, { qty: number; value: number; last: number }> = {};
    for (const r of ((inv.data as { product_id: string; stock_qty: number; avg_cost: number }[]) || [])) {
      const e = cost[r.product_id] || { qty: 0, value: 0, last: 0 };
      e.qty += Number(r.stock_qty || 0);
      e.value += Number(r.stock_qty || 0) * Number(r.avg_cost || 0);
      if (Number(r.avg_cost || 0) > 0) e.last = Number(r.avg_cost);
      cost[r.product_id] = e;
    }
    setRows(((p.data as Omit<Row, "avg_cost">[]) || []).map((r) => {
      const e = cost[r.id];
      return { ...r, avg_cost: e && e.qty > 0 ? e.value / e.qty : e?.last || 0 };
    }));
    setCats((c.data as Cat[]) || []);

    const [st, mx, oo] = await Promise.all([
      supabase.from("stores").select("id,name").order("id"),
      supabase.rpc("product_stock_matrix"),
      supabase.rpc("product_on_order"),
    ]);
    setStores((st.data as { id: string; name: string }[]) || []);
    const grid: Record<string, Record<string, number>> = {};
    for (const r of ((mx.data as { product_id: string; store_id: string; stock_qty: number }[]) || [])) {
      (grid[r.product_id] ||= {})[r.store_id] = Number(r.stock_qty || 0);
    }
    setByStore(grid);
    setOnOrder(Object.fromEntries(((oo.data as { product_id: string; on_order: number }[]) || [])
      .map((r) => [r.product_id, Number(r.on_order || 0)])));
  }

  const shown = useMemo(() => {
    let out = rows;
    if (cat) out = out.filter((r) => (r.category_id || "") === cat);
    if (q) {
      const s = q.toLowerCase();
      out = out.filter((r) => (r.sku || "").toLowerCase().includes(s) || r.name.toLowerCase().includes(s));
    }
    return out;
  }, [rows, q, cat]);

  function edit(id: string, field: keyof Row, value: unknown) {
    setRows((old) => old.map((r) => (r.id === id ? { ...r, [field]: value } as Row : r)));
    setDirty((d) => ({ ...d, [id]: { ...d[id], [field]: value } }));
  }

  async function saveAll() {
    const ids = Object.keys(dirty);
    if (ids.length === 0) return setMsg("Nothing to save");
    setSaving(true);
    let bad = 0;
    for (const id of ids) {
      const patch = { ...dirty[id] } as Record<string, unknown>;
      delete patch.avg_cost;
      if (patch.price != null) patch.price = Number(patch.price) || 0;
      if (patch.min_price !== undefined)
        patch.min_price = patch.min_price === "" || patch.min_price == null ? null : Number(patch.min_price);
      const { error } = await supabase.from("products").update(patch).eq("id", id);
      if (error) bad++;
    }
    setSaving(false);
    setDirty({});
    setMsg(bad ? bad + "  failed" : ids.length + "  saved");
    load();
    setTimeout(() => setMsg(""), 4000);
  }

  function exportCsv() {
    const head = ["Code", "Description", "Category", "Cost", "Sale Price", "GP %",
      "Min Price", "Allow Discount", "Allow Promotion", "Active",
      ...stores.map((s2) => s2.name), "Total Stock", "On Order", "Stock Value"];
    const esc = (v: unknown) => {
      const t = String(v ?? "");
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const catName = (id: string | null) => cats.find((c) => c.id === id)?.name ?? "";
    const body = shown.map((r) => {
      const g = r.price > 0 ? ((r.price - r.avg_cost) / r.price) * 100 : null;
      return [r.sku, r.name, catName(r.category_id), Math.round(r.avg_cost), r.price,
        g == null ? "" : g.toFixed(1), r.min_price ?? "",
        r.allow_discount === false ? "No" : "Yes",
        r.allow_promotion === false ? "No" : "Yes",
        r.is_active ? "Yes" : "No",
        ...stores.map((s2) => byStore[r.id]?.[s2.id] ?? 0),
        stores.reduce((t, s2) => t + (byStore[r.id]?.[s2.id] ?? 0), 0),
        onOrder[r.id] ?? 0,
        Math.round(stores.reduce((t, s2) => t + (byStore[r.id]?.[s2.id] ?? 0), 0) * r.avg_cost),
      ].map(esc).join(",");
    });
    const csv = "\uFEFF" + [head.join(","), ...body].join("\n");
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a2.download = "products-" + new Date().toISOString().slice(0, 10) + ".csv";
    a2.click();
    URL.revokeObjectURL(a2.href);
  }

  const gp = (r: Row) => (r.price > 0 ? ((r.price - r.avg_cost) / r.price) * 100 : null);
  const cell = "border-r border-slate-100 px-2 py-1";
  const input = "w-full bg-transparent outline-none focus:bg-blue-50 px-1 py-0.5 rounded";

  if (pageBlocked) return null;

  return (
    <div className="max-w-full p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold">Product Grid</h1>
          <p className="text-sm text-slate-500">Edit in place, then save everything at once.</p>
        </div>
        <div className="flex items-center gap-2">
          {Object.keys(dirty).length > 0 && (
            <span className="text-xs text-amber-700">{Object.keys(dirty).length}  edited</span>
          )}
          <button onClick={exportCsv}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm">Export</button>
          <button onClick={saveAll} disabled={saving || Object.keys(dirty).length === 0}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-40">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {msg && <div className="mb-3 text-sm px-3 py-2 rounded-lg bg-blue-50 text-blue-700">{msg}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or name"
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[220px]" />
        <select value={cat} onChange={(e) => setCat(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="text-xs text-slate-400">{shown.length} </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[70vh]">
        <table className="text-xs min-w-[1100px] w-full border-collapse">
          <thead className="bg-slate-100 text-slate-600 sticky top-0 z-10">
            <tr>
              {["Code", "Description", "Category", "Cost", "Sale Price", "GP %",
                "Min Price", "Disc", "Promo", "Active",
                ...stores.map((s2) => s2.name), "Total", "On Order"].map((h) => (
                <th key={h} className="border border-slate-200 px-2 py-2 text-left font-semibold whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const g = gp(r);
              const touched = !!dirty[r.id];
              return (
                <tr key={r.id} className={"border-b border-slate-100 " + (touched ? "bg-amber-50" : "hover:bg-slate-50")}>
                  <td className={cell + " w-28"}>
                    <input className={input} value={r.sku || ""}
                      onChange={(e) => edit(r.id, "sku", e.target.value)} />
                  </td>
                  <td className={cell + " min-w-[260px]"}>
                    <input className={input} value={r.name}
                      onChange={(e) => edit(r.id, "name", e.target.value)} />
                  </td>
                  <td className={cell + " w-36"}>
                    <select className={input} value={r.category_id || ""}
                      onChange={(e) => edit(r.id, "category_id", e.target.value || null)}>
                      <option value="">-</option>
                      {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className={cell + " w-24 text-right text-slate-500"}>{n(Math.round(r.avg_cost))}</td>
                  <td className={cell + " w-28"}>
                    <input type="number" className={input + " text-right"} value={r.price}
                      onChange={(e) => edit(r.id, "price", e.target.value)} />
                  </td>
                  <td className={cell + " w-20 text-right " + (g == null ? "text-slate-400" : g < 15 ? "text-red-600" : "text-green-700")}>
                    {g == null ? "-" : g.toFixed(1) + "%"}
                  </td>
                  <td className={cell + " w-28"}>
                    <input type="number" className={input + " text-right"} value={r.min_price ?? ""}
                      onChange={(e) => edit(r.id, "min_price", e.target.value)} />
                  </td>
                  <td className={cell + " w-14 text-center"}>
                    <input type="checkbox" checked={r.allow_discount !== false}
                      onChange={(e) => edit(r.id, "allow_discount", e.target.checked)} />
                  </td>
                  <td className={cell + " w-14 text-center"}>
                    <input type="checkbox" checked={r.allow_promotion !== false}
                      onChange={(e) => edit(r.id, "allow_promotion", e.target.checked)} />
                  </td>
                  <td className="px-2 py-1 w-14 text-center">
                    <input type="checkbox" checked={r.is_active}
                      onChange={(e) => edit(r.id, "is_active", e.target.checked)} />
                  </td>
                  {stores.map((s2) => (
                    <td key={s2.id} className={cell + " w-16 text-right text-slate-500"}>
                      {byStore[r.id]?.[s2.id] ? n(byStore[r.id][s2.id]) : "-"}
                    </td>
                  ))}
                  <td className={cell + " w-16 text-right font-medium"}>
                    {n(stores.reduce((t, s2) => t + (byStore[r.id]?.[s2.id] ?? 0), 0))}
                  </td>
                  <td className="px-2 py-1 w-16 text-right text-blue-700">
                    {onOrder[r.id] ? n(onOrder[r.id]) : "-"}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-slate-400" colSpan={12 + stores.length}>No products.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-2">
        Cost is the weighted average across every shop and is set by goods received, not here.
      </p>
    </div>
  );
}
