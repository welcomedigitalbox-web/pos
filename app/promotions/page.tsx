"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Kind = "percent" | "amount" | "fixed_price" | "bxgy" | "bundle";

const KIND_LABEL: Record<Kind, string> = {
  percent: "% off",
  amount: "Amount off",
  fixed_price: "Special price",
  bxgy: "Buy X get Y",
  bundle: "Bundle price",
};

type Promo = {
  id: string; name: string; kind: Kind; value: number | null;
  buy_qty: number | null; get_qty: number | null;
  min_qty: number | null; min_amount: number | null;
  starts_on: string; ends_on: string | null;
  stores: string[] | null; priority: number; stackable: boolean;
  active: boolean; note: string | null;
};
type Item = { id: string; promotion_id: string; product_id: string | null; category_id: string | null; role: string; qty: number | null };
type Named = { id: string; name: string };

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: unknown) => (n == null || n === "" ? "-" : Number(n).toLocaleString());

export default function PromotionsPage() {
  // A page nobody navigated to can still be typed into the address bar,
  // so the page checks for itself.
  const { profile } = useAuth();
  const router = useRouter();
  const pageBlocked = !profile || !hasPermission(profile, "promotions");
  useEffect(() => {
    if (profile && !hasPermission(profile, "promotions")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [promos, setPromos] = useState<Promo[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Named[]>([]);
  const [cats, setCats] = useState<Named[]>([]);
  const [stores, setStores] = useState<Named[]>([]);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<Promo | "new" | null>(null);

  // form
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("percent");
  const [value, setValue] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [getQty, setGetQty] = useState("");
  const [minQty, setMinQty] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const [priority, setPriority] = useState("100");
  const [stackable, setStackable] = useState(false);
  const [pickStores, setPickStores] = useState<string[]>([]);
  const [buyIds, setBuyIds] = useState<string[]>([]);
  const [getIds, setGetIds] = useState<string[]>([]);
  const [catIds, setCatIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    const [p, i, pr, c, st] = await Promise.all([
      supabase.from("promotions").select("*").order("priority").order("starts_on", { ascending: false }),
      supabase.from("promotion_items").select("*"),
      supabase.from("products").select("id,name").eq("is_active", true).order("name"),
      supabase.from("product_categories").select("id,name").order("sort_order"),
      supabase.from("stores").select("id,name").order("id"),
    ]);
    setPromos((p.data as Promo[]) || []);
    setItems((i.data as Item[]) || []);
    setProducts((pr.data as Named[]) || []);
    setCats((c.data as Named[]) || []);
    setStores(((st.data as { id: string; name: string }[]) || []).map((x) => ({ id: x.id, name: x.name })));
  }

  function reset() {
    setName(""); setKind("percent"); setValue(""); setBuyQty(""); setGetQty("");
    setMinQty(""); setFrom(today()); setTo(""); setPriority("100"); setStackable(false);
    setPickStores([]); setBuyIds([]); setGetIds([]); setCatIds([]); setSearch("");
  }

  function edit(p: Promo) {
    const mine = items.filter((x) => x.promotion_id === p.id);
    setOpen(p);
    setName(p.name); setKind(p.kind); setValue(p.value == null ? "" : String(p.value));
    setBuyQty(p.buy_qty == null ? "" : String(p.buy_qty));
    setGetQty(p.get_qty == null ? "" : String(p.get_qty));
    setMinQty(p.min_qty == null ? "" : String(p.min_qty));
    setFrom(p.starts_on); setTo(p.ends_on || "");
    setPriority(String(p.priority)); setStackable(p.stackable);
    setPickStores(p.stores || []);
    setBuyIds(mine.filter((x) => x.role !== "get" && x.product_id).map((x) => x.product_id!));
    setGetIds(mine.filter((x) => x.role === "get" && x.product_id).map((x) => x.product_id!));
    setCatIds(mine.filter((x) => x.category_id).map((x) => x.category_id!));
  }

  const num = (v: string) => (v === "" ? null : Number(v));

  async function save() {
    if (!name.trim()) return setMsg("Name is required");
    if (buyIds.length === 0 && catIds.length === 0) return setMsg("Pick at least one product or category");
    const payload = {
      name: name.trim(), kind, value: num(value),
      buy_qty: kind === "bxgy" ? num(buyQty) : null,
      get_qty: kind === "bxgy" ? num(getQty) : null,
      min_qty: num(minQty),
      starts_on: from || today(), ends_on: to || null,
      stores: pickStores.length ? pickStores : null,
      priority: Number(priority) || 100, stackable, active: true,
    };

    let id: string;
    if (open && open !== "new") {
      const { error } = await supabase.from("promotions").update(payload).eq("id", open.id);
      if (error) return setMsg(error.message);
      id = open.id;
      await supabase.from("promotion_items").delete().eq("promotion_id", id);
    } else {
      const { data, error } = await supabase.from("promotions").insert(payload).select("id").single();
      if (error) return setMsg(error.message);
      id = (data as { id: string }).id;
    }

    const rows = [
      ...buyIds.map((pid) => ({ promotion_id: id, product_id: pid, role: kind === "bundle" ? "bundle" : "buy" })),
      ...getIds.map((pid) => ({ promotion_id: id, product_id: pid, role: "get" })),
      ...catIds.map((cid) => ({ promotion_id: id, category_id: cid, role: "buy" })),
    ];
    if (rows.length) {
      const { error } = await supabase.from("promotion_items").insert(rows);
      if (error) return setMsg(error.message);
    }
    setOpen(null); reset(); setMsg("Saved");
    load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function toggle(p: Promo) {
    await supabase.from("promotions").update({ active: !p.active }).eq("id", p.id);
    load();
  }

  async function remove(p: Promo) {
    if (!confirm(p.name + "  — delete?")) return;
    await supabase.from("promotions").delete().eq("id", p.id);
    load();
  }

  const shown = useMemo(
    () => products.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 40),
    [products, search]
  );

  const state = (p: Promo) => {
    const d = today();
    if (!p.active) return ["Off", "bg-slate-100 text-slate-500"];
    if (p.starts_on > d) return ["Scheduled", "bg-amber-50 text-amber-700"];
    if (p.ends_on && p.ends_on < d) return ["Ended", "bg-slate-100 text-slate-400"];
    return ["Live", "bg-green-50 text-green-700"];
  };

  const Pick = ({ list, chosen, set, label }: { list: Named[]; chosen: string[]; set: (v: string[]) => void; label: string }) => (
    <div>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="border border-slate-200 rounded-lg max-h-40 overflow-y-auto">
        {list.map((x) => (
          <label key={x.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={chosen.includes(x.id)}
              onChange={(e) => set(e.target.checked ? [...chosen, x.id] : chosen.filter((y) => y !== x.id))} />
            {x.name}
          </label>
        ))}
        {list.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">None</div>}
      </div>
    </div>
  );

  if (pageBlocked) return null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold">Promotions</h1>
          <p className="text-sm text-slate-500">Schedule ahead — an offer starts on its start date.</p>
        </div>
        <button onClick={() => { reset(); setOpen("new"); }}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">+ New</button>
      </div>

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-blue-50 text-blue-700">{msg}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              {["Promotion", "Type", "Value", "Period", "Shops", "Status", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => {
              const [label, tone] = state(p);
              const n = items.filter((x) => x.promotion_id === p.id).length;
              return (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">{n}  items</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{KIND_LABEL[p.kind]}</td>
                  <td className="px-3 py-2">
                    {p.kind === "bxgy" ? `${fmt(p.buy_qty)}  buy → ${fmt(p.get_qty)} free`
                      : p.kind === "percent" ? `${fmt(p.value)}%` : fmt(p.value)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.starts_on} → {p.ends_on || "no end"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.stores?.length ? p.stores.join(", ") : "အားလုံး"}</td>
                  <td className="px-3 py-2">
                    <span className={"text-xs px-2 py-0.5 rounded " + tone}>{label}</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => edit(p)} className="text-xs text-blue-600 mr-3">Edit</button>
                    <button onClick={() => toggle(p)} className="text-xs text-slate-500 mr-3">{p.active ? "Off" : "On"}</button>
                    <button onClick={() => remove(p)} className="text-xs text-red-600">Delete</button>
                  </td>
                </tr>
              );
            })}
            {promos.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-slate-400" colSpan={7}>No promotions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="font-semibold mb-4">{open === "new" ? "New promotion" : "Edit promotion"}</h2>

          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">နာမည်</span>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">အမျိုးအစား</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full">
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>

            {kind === "bxgy" ? (
              <>
                <label className="block text-sm">
                  <span className="text-xs text-slate-500 block mb-1">Buy quantity</span>
                  <input type="number" value={buyQty} onChange={(e) => setBuyQty(e.target.value)}
                    className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-slate-500 block mb-1">Free quantity</span>
                  <input type="number" value={getQty} onChange={(e) => setGetQty(e.target.value)}
                    className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
                </label>
              </>
            ) : (
              <label className="block text-sm">
                <span className="text-xs text-slate-500 block mb-1">
                  {kind === "percent" ? "Percent off" : kind === "amount" ? "Amount off (MMK)"
                    : kind === "fixed_price" ? "Special price (MMK)" : "Bundle price (MMK)"}
                </span>
                <input type="number" value={value} onChange={(e) => setValue(e.target.value)}
                  className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
              </label>
            )}

            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">Minimum quantity (optional)</span>
              <input type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">Starts on</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">ပြီးဆုံးရက် (ဗလာ = no end)</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">Priority (lower wins)</span>
              <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
              Can stack with other offers
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            <Pick list={stores} chosen={pickStores} set={setPickStores} label="Shops (none = all)" />
            <Pick list={cats} chosen={catIds} set={setCatIds} label="Whole categories" />
          </div>

          <div className="mb-4">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products"
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full mb-2" />
            <div className="grid sm:grid-cols-2 gap-4">
              <Pick list={shown} chosen={buyIds} set={setBuyIds}
                label={kind === "bundle" ? "Bundle members" : "Products it applies to"} />
              {kind === "bxgy" && (
                <Pick list={shown} chosen={getIds} set={setGetIds} label="Free items" />
              )}
            </div>
            {buyIds.length > 0 && (
              <div className="text-xs text-slate-500 mt-1">Selected {buyIds.length} </div>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={save} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">Save</button>
            <button onClick={() => { setOpen(null); reset(); }}
              className="px-4 py-2 border border-slate-200 rounded-lg text-sm">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
