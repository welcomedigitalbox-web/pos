"use client";
import { supabase } from "@/lib/supabase";
import { useEffect, useState } from "react";

type P = { id: string; name: string; sku: string | null; price: number | null };
type U = { id: string; product_id: string; code: string; name: string; factor: number;
  barcode: string | null; price: number | null; is_base: boolean; sort_order: number; is_active: boolean };

export default function UomsPage() {
  const [q, setQ] = useState("");
  const [prods, setProds] = useState<P[]>([]);
  const [pid, setPid] = useState("");
  const [rows, setRows] = useState<U[]>([]);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ code: "CTN", name: "Carton", factor: "12", barcode: "", price: "" });

  useEffect(() => {
    const t = setTimeout(() => {
      let sel = supabase.from("products").select("id,name,sku,price").eq("is_active", true).order("name").limit(30);
      if (q.trim()) sel = sel.or("name.ilike.%" + q.trim() + "%,sku.ilike.%" + q.trim() + "%");
      sel.then(({ data }: any) => setProds(data || []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = (id: string) => {
    setPid(id);
    supabase.from("product_uoms").select("*").eq("product_id", id).is("variant_id", null)
      .order("sort_order").then(({ data }: any) => setRows(data || []));
  };

  const add = async () => {
    setMsg("");
    const factor = Number(form.factor);
    if (!pid || !form.code.trim() || !(factor > 0)) { setMsg("Code and a factor above 0 are required."); return; }
    const { error } = await supabase.from("product_uoms").insert({
      product_id: pid, code: form.code.trim().toUpperCase(), name: form.name.trim() || form.code.trim(),
      factor, barcode: form.barcode.trim() || null, price: form.price ? Number(form.price) : null,
      is_base: false, sort_order: rows.length,
    });
    if (error) setMsg(error.message); else { setForm({ ...form, barcode: "", price: "" }); load(pid); }
  };

  const save = async (u: U, patch: Partial<U>) => {
    const { error } = await supabase.from("product_uoms").update(patch).eq("id", u.id);
    if (error) setMsg(error.message); else load(pid);
  };

  const del = async (u: U) => {
    if (u.is_base) { setMsg("The base unit cannot be deleted."); return; }
    const { error } = await supabase.from("product_uoms").delete().eq("id", u.id);
    if (error) setMsg(error.message); else load(pid);
  };

  const prod = prods.find((p) => p.id === pid);

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold">Units of measure</h1>
      <p className="text-sm text-gray-500">Stock is always counted in the base unit. A carton of 12 deducts 12 pcs.</p>

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product by name or SKU"
        className="border rounded px-3 py-2 w-full max-w-md" />

      <div className="flex flex-wrap gap-2">
        {prods.map((p) => (
          <button key={p.id} onClick={() => load(p.id)}
            className={"px-3 py-1.5 rounded border text-sm " + (p.id === pid ? "bg-black text-white" : "bg-white")}>
            {p.name}{p.sku ? " · " + p.sku : ""}
          </button>
        ))}
      </div>

      {msg && <div className="text-red-600 text-sm">{msg}</div>}

      {pid && (
        <div className="border rounded-lg p-3 space-y-3">
          <div className="font-medium">{prod?.name} <span className="text-sm text-gray-500">base price {prod?.price ?? "—"}</span></div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 border-b">
              <th className="py-1">Code</th><th>Name</th><th>= how many base</th><th>Barcode</th><th>Price</th><th>Base</th><th></th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="py-1 font-mono">{u.code}</td>
                  <td><input defaultValue={u.name} onBlur={(e) => e.target.value !== u.name && save(u, { name: e.target.value })}
                    className="border rounded px-2 py-1 w-28" /></td>
                  <td><input type="number" defaultValue={u.factor} disabled={u.is_base}
                    onBlur={(e) => Number(e.target.value) !== u.factor && save(u, { factor: Number(e.target.value) })}
                    className="border rounded px-2 py-1 w-24" /></td>
                  <td><input defaultValue={u.barcode || ""} onBlur={(e) => e.target.value !== (u.barcode || "") && save(u, { barcode: e.target.value || null })}
                    className="border rounded px-2 py-1 w-36" /></td>
                  <td><input type="number" defaultValue={u.price ?? ""} placeholder="auto"
                    onBlur={(e) => save(u, { price: e.target.value ? Number(e.target.value) : null })}
                    className="border rounded px-2 py-1 w-28" /></td>
                  <td>{u.is_base ? "✓" : ""}</td>
                  <td>{!u.is_base && <button onClick={() => del(u)} className="text-red-600">Delete</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex flex-wrap items-end gap-2 pt-2 border-t">
            <div><div className="text-xs text-gray-500">Code</div>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="border rounded px-2 py-1 w-24" /></div>
            <div><div className="text-xs text-gray-500">Name</div>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border rounded px-2 py-1 w-32" /></div>
            <div><div className="text-xs text-gray-500">= base units</div>
              <input type="number" value={form.factor} onChange={(e) => setForm({ ...form, factor: e.target.value })} className="border rounded px-2 py-1 w-24" /></div>
            <div><div className="text-xs text-gray-500">Barcode</div>
              <input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="border rounded px-2 py-1 w-36" /></div>
            <div><div className="text-xs text-gray-500">Price (blank = auto)</div>
              <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="border rounded px-2 py-1 w-28" /></div>
            <button onClick={add} className="px-3 py-1.5 bg-black text-white rounded">Add unit</button>
          </div>
        </div>
      )}
    </div>
  );
}
