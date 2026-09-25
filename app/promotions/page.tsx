"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Kind = "percent" | "amount" | "fixed_price" | "bxgy" | "bundle";

const KIND_LABEL: Record<Kind, string> = {
  percent: "% လျှော့",
  amount: "ငွေပမာဏ လျှော့",
  fixed_price: "အထူးဈေး",
  bxgy: "X ဝယ် Y လက်ဆောင်",
  bundle: "Bundle ဈေး",
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
    if (!name.trim()) return setMsg("နာမည် ထည့်ပါ");
    if (buyIds.length === 0 && catIds.length === 0) return setMsg("ပစ္စည်း သို့ အမျိုးအစား အနည်းဆုံး တစ်ခု ရွေးပါ");
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
    setOpen(null); reset(); setMsg("သိမ်းပြီး");
    load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function toggle(p: Promo) {
    await supabase.from("promotions").update({ active: !p.active }).eq("id", p.id);
    load();
  }

  async function remove(p: Promo) {
    if (!confirm(p.name + " ကို ဖျက်မလား?")) return;
    await supabase.from("promotions").delete().eq("id", p.id);
    load();
  }

  const shown = useMemo(
    () => products.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 40),
    [products, search]
  );

  const state = (p: Promo) => {
    const d = today();
    if (!p.active) return ["ပိတ်ထား", "bg-slate-100 text-slate-500"];
    if (p.starts_on > d) return ["စောင့်ဆိုင်းဆဲ", "bg-amber-50 text-amber-700"];
    if (p.ends_on && p.ends_on < d) return ["ကုန်ဆုံး", "bg-slate-100 text-slate-400"];
    return ["သက်ရောက်နေ", "bg-green-50 text-green-700"];
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
        {list.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">မရှိပါ</div>}
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold">Promotions</h1>
          <p className="text-sm text-slate-500">ရက်ကြိုပြီး စီစဉ်လို့ရတယ်။ စတင်ရက် ရောက်မှ သက်ရောက်မယ်။</p>
        </div>
        <button onClick={() => { reset(); setOpen("new"); }}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">+ အသစ်</button>
      </div>

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-blue-50 text-blue-700">{msg}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              {["Promotion", "အမျိုးအစား", "တန်ဖိုး", "ကာလ", "ဆိုင်", "အခြေအနေ", ""].map((h) => (
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
                    <div className="text-xs text-slate-400">{n} ပစ္စည်း/အမျိုးအစား</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{KIND_LABEL[p.kind]}</td>
                  <td className="px-3 py-2">
                    {p.kind === "bxgy" ? `${fmt(p.buy_qty)} ဝယ် ${fmt(p.get_qty)} လက်ဆောင်`
                      : p.kind === "percent" ? `${fmt(p.value)}%` : fmt(p.value)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.starts_on} → {p.ends_on || "အကန့်အသတ်မရှိ"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.stores?.length ? p.stores.join(", ") : "အားလုံး"}</td>
                  <td className="px-3 py-2">
                    <span className={"text-xs px-2 py-0.5 rounded " + tone}>{label}</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => edit(p)} className="text-xs text-blue-600 mr-3">ပြင်</button>
                    <button onClick={() => toggle(p)} className="text-xs text-slate-500 mr-3">{p.active ? "ပိတ်" : "ဖွင့်"}</button>
                    <button onClick={() => remove(p)} className="text-xs text-red-600">ဖျက်</button>
                  </td>
                </tr>
              );
            })}
            {promos.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-slate-400" colSpan={7}>Promotion မရှိသေးပါ။</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="font-semibold mb-4">{open === "new" ? "Promotion အသစ်" : "ပြင်ဆင်ရန်"}</h2>

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
                  <span className="text-xs text-slate-500 block mb-1">ဝယ်ရမယ့် အရေအတွက်</span>
                  <input type="number" value={buyQty} onChange={(e) => setBuyQty(e.target.value)}
                    className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-slate-500 block mb-1">လက်ဆောင် အရေအတွက်</span>
                  <input type="number" value={getQty} onChange={(e) => setGetQty(e.target.value)}
                    className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
                </label>
              </>
            ) : (
              <label className="block text-sm">
                <span className="text-xs text-slate-500 block mb-1">
                  {kind === "percent" ? "လျှော့ရာခိုင်နှုန်း" : kind === "amount" ? "လျှော့ငွေ (MMK)"
                    : kind === "fixed_price" ? "အထူးဈေး (MMK)" : "Bundle ဈေး (MMK)"}
                </span>
                <input type="number" value={value} onChange={(e) => setValue(e.target.value)}
                  className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
              </label>
            )}

            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">အနည်းဆုံး အရေအတွက် (ရွေးချယ်)</span>
              <input type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">စတင်ရက်</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">ပြီးဆုံးရက် (ဗလာ = အကန့်အသတ်မရှိ)</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-slate-500 block mb-1">ဦးစားပေး (ငယ်လေ အရင်လေ)</span>
              <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full" />
            </label>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
              တခြား promo နဲ့ ထပ်လို့ရ
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            <Pick list={stores} chosen={pickStores} set={setPickStores} label="ဆိုင် (မရွေးရင် အားလုံး)" />
            <Pick list={cats} chosen={catIds} set={setCatIds} label="အမျိုးအစား တစ်ခုလုံး" />
          </div>

          <div className="mb-4">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ပစ္စည်း ရှာရန်"
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-full mb-2" />
            <div className="grid sm:grid-cols-2 gap-4">
              <Pick list={shown} chosen={buyIds} set={setBuyIds}
                label={kind === "bundle" ? "Bundle ထဲပါမယ့် ပစ္စည်းများ" : "သက်ရောက်မယ့် ပစ္စည်းများ"} />
              {kind === "bxgy" && (
                <Pick list={shown} chosen={getIds} set={setGetIds} label="လက်ဆောင်ပေးမယ့် ပစ္စည်းများ" />
              )}
            </div>
            {buyIds.length > 0 && (
              <div className="text-xs text-slate-500 mt-1">ရွေးထားသည် {buyIds.length} ခု</div>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={save} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">သိမ်း</button>
            <button onClick={() => { setOpen(null); reset(); }}
              className="px-4 py-2 border border-slate-200 rounded-lg text-sm">ပိတ်</button>
          </div>
        </div>
      )}
    </div>
  );
}
