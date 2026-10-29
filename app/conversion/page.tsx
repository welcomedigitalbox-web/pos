"use client";

// =====================================================================
// Conversion.
//
// One article leaves the shelf and several come back: a water-bottle set
// becomes a body, a pipe and a cap, because that is how the customer
// wants to buy it, or because one part of it broke.
//
// The shape of the screen is the one the warehouse already knows from the
// old system: what comes in on top, what goes out below, a running total
// beside each. The one thing it does differently is the cost. What the
// article cost is carried over to the parts rather than invented again,
// so the warehouse is worth the same before and after.
//
// Codes are typed or scanned, not hunted for in a list, because the
// barcode is already on the box in somebody's hand.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Product = {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
  base_uom: string | null;
};

type Line = {
  key: string;
  code: string;          // what was typed or scanned
  product_id: string;
  name: string;
  unit: string;
  qty: string;
  salePrice: number;
  purPrice: string;      // left empty on the way in means "share it out"
  expiry: string;
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const blank = (): Line => ({
  key: crypto.randomUUID(),
  code: "", product_id: "", name: "", unit: "", qty: "1",
  salePrice: 0, purPrice: "", expiry: "",
});

export default function ConversionPage() {
  const { profile } = useAuth();
  const allowed = hasPermission(profile, "conversion");

  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState("");
  const [inLines, setInLines] = useState<Line[]>([blank()]);
  const [outLines, setOutLines] = useState<Line[]>([blank()]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [onHand, setOnHand] = useState<Record<string, { qty: number; cost: number }>>({});
  const looking = useRef<Record<string, boolean>>({});

  useEffect(() => {
    supabase
      .from("stores")
      .select("id,name")
      .order("name")
      .then(({ data }) => {
        const list = (data as { id: string; name: string }[]) || [];
        setStores(list);
        setStoreId((s) => s || list.find((x) => /wh/i.test(x.id))?.id || list[0]?.id || "");
      });
  }, []);

  const loadOnHand = useCallback(async () => {
    if (!storeId) return;
    const map: Record<string, { qty: number; cost: number }> = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("store_inventory")
        .select("product_id,stock_qty,avg_cost")
        .eq("store_id", storeId)
        .range(from, from + 999);
      const page = (data as { product_id: string; stock_qty: number; avg_cost: number }[]) || [];
      for (const r of page) {
        const cur = map[r.product_id] || { qty: 0, cost: 0 };
        cur.qty += Number(r.stock_qty || 0);
        cur.cost = Number(r.avg_cost || 0);
        map[r.product_id] = cur;
      }
      if (error || page.length < 1000) break;
    }
    setOnHand(map);
  }, [storeId]);

  useEffect(() => { loadOnHand(); }, [loadOnHand]);

  // Typing in the code box searches the catalogue, because the person at
  // the bench knows the product by its name as often as by its number.
  const [sugg, setSugg] = useState<{ key: string; items: Product[] }>({ key: "", items: [] });

  const search = useCallback(async (key: string, q: string) => {
    const term = q.trim();
    if (term.length < 2) { setSugg({ key, items: [] }); return; }
    const { data } = await supabase
      .from("products")
      .select("id,name,sku,price,base_uom")
      .eq("is_active", true)
      .or(`name.ilike.%${term}%,sku.ilike.%${term}%`)
      .order("name")
      .limit(8);
    setSugg({ key, items: (data as Product[]) || [] });
  }, []);

  // A code is whatever is printed on the box: one of ours, the supplier's,
  // or the article number. All three end at the same product.
  async function findByCode(raw: string): Promise<Product | null> {
    const code = raw.trim();
    if (!code) return null;

    const { data: bar } = await supabase
      .from("product_barcodes")
      .select("product_id")
      .eq("barcode", code)
      .eq("is_active", true)
      .limit(1);
    const hit = (bar as { product_id: string }[] | null)?.[0]?.product_id;

    const q = supabase.from("products").select("id,name,sku,price,base_uom").limit(1);
    const { data } = hit
      ? await q.eq("id", hit)
      : await q.or(`sku.eq.${code},name.eq.${code}`);
    return ((data as Product[]) || [])[0] || null;
  }

  function fill(side: "in" | "out", key: string, p: Product) {
    const set = side === "in" ? setInLines : setOutLines;
    setSugg({ key: "", items: [] });
    set((r) => {
      const next = r.map((l) => (l.key === key
        ? {
            ...l,
            code: p.sku || p.name,
            product_id: p.id,
            name: p.name,
            unit: p.base_uom || "PC",
            salePrice: Number(p.price || 0),
            purPrice: side === "out" ? String(Math.round(onHand[p.id]?.cost || 0)) : l.purPrice,
          }
        : l));
      return next[next.length - 1].product_id ? [...next, blank()] : next;
    });
  }

  async function resolve(side: "in" | "out", key: string, code: string) {
    if (looking.current[key]) return;
    looking.current[key] = true;
    const p = await findByCode(code);
    looking.current[key] = false;

    const set = side === "in" ? setInLines : setOutLines;
    if (!p) {
      set((r) => r.map((l) => (l.key === key
        ? { ...l, product_id: "", name: "not found", unit: "", salePrice: 0 } : l)));
      return;
    }
    set((r) => {
      const next = r.map((l) => (l.key === key
        ? {
            ...l,
            product_id: p.id,
            name: p.name,
            unit: p.base_uom || "PC",
            salePrice: Number(p.price || 0),
            // On the way out the cost is whatever the shelf says.
            purPrice: side === "out" ? String(Math.round(onHand[p.id]?.cost || 0)) : l.purPrice,
          }
        : l));
      // A filled last row earns an empty one under it, as the old screen did.
      return next[next.length - 1].product_id ? [...next, blank()] : next;
    });
  }

  function setLine(side: "in" | "out", key: string, patch: Partial<Line>) {
    (side === "in" ? setInLines : setOutLines)((r) =>
      r.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function dropLine(side: "in" | "out", key: string) {
    (side === "in" ? setInLines : setOutLines)((r) => {
      const next = r.filter((l) => l.key !== key);
      return next.length ? next : [blank()];
    });
  }

  const totals = useMemo(() => {
    const sum = (lines: Line[]) => {
      let qty = 0, pur = 0, sale = 0;
      for (const l of lines) {
        const q = Number(l.qty) || 0;
        if (!l.product_id || q <= 0) continue;
        qty += q;
        pur += q * (Number(l.purPrice) || 0);
        sale += q * l.salePrice;
      }
      return { qty, pur, sale };
    };
    return { in: sum(inLines), out: sum(outLines) };
  }, [inLines, outLines]);

  async function confirm() {
    setErr(""); setMsg("");
    const out = outLines
      .filter((l) => l.product_id && Number(l.qty) > 0)
      .map((l) => ({ product_id: l.product_id, qty: Number(l.qty) }));
    const into = inLines
      .filter((l) => l.product_id && Number(l.qty) > 0)
      .map((l) => ({
        product_id: l.product_id,
        qty: Number(l.qty),
        unit_cost: l.purPrice.trim() === "" ? null : Number(l.purPrice),
      }));

    if (out.length === 0) return setErr("Nothing in Stock Out");
    if (into.length === 0) return setErr("Nothing in Stock In");

    setBusy(true);
    const { data, error } = await supabase.rpc("convert_stock", {
      p_store: storeId,
      p_out: out,
      p_in: into,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(describeError(error)); return; }

    const res = (data as { cost?: number; lines_in?: number }) || {};
    setMsg(`Done - ${money(Number(res.cost || 0))} MMK carried across ${res.lines_in || 0} line(s)`);
    setInLines([blank()]); setOutLines([blank()]); setNote("");
    loadOnHand();
  }

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="text-sm text-slate-600">
          Converting stock belongs to the warehouse. Ask IT if you need it.
        </p>
        <Link href="/" className="text-sm text-blue-600">Back</Link>
      </main>
    );
  }

  const field = "border border-slate-300 rounded px-2 py-1 text-sm";

  return (
    <main className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-lg font-semibold">Conversion</h1>
      <p className="text-xs text-slate-500 mb-4">
        What goes out is taken off at what it cost; what comes in carries
        that cost, shared by what each part sells for.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-[11px] text-slate-500">Location</label>
          <select className={field} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[11px] text-slate-500">Remark</label>
          <input className={field + " w-full"} value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it was taken apart" />
        </div>
      </div>

      <Block
        title="STOCK IN"
        subtitle="The parts that go on the shelf. Leave Pur Price empty to let the cost be shared."
        tone="bg-blue-600"
        lines={inLines}
        side="in"
        showExpiry={false}
        onHand={onHand}
        onCode={(k, c) => resolve("in", k, c)}
        onSearch={(k, q) => search(k, q)}
        onPick={(k, p) => fill("in", k, p)}
        sugg={sugg}
        onSet={(k, patch) => setLine("in", k, patch)}
        onDrop={(k) => dropLine("in", k)}
        totals={totals.in}
      />

      <Block
        title="STOCK OUT"
        subtitle="The article that leaves the shelf."
        tone="bg-slate-700"
        lines={outLines}
        side="out"
        showExpiry
        onHand={onHand}
        onCode={(k, c) => resolve("out", k, c)}
        onSearch={(k, q) => search(k, q)}
        onPick={(k, p) => fill("out", k, p)}
        sugg={sugg}
        onSet={(k, patch) => setLine("out", k, patch)}
        onDrop={(k) => dropLine("out", k)}
        totals={totals.out}
      />

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button onClick={confirm} disabled={busy}
          className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-50">
          {busy ? "Working..." : "Confirm (F5)"}
        </button>
        {totals.out.pur > 0 && (
          <span className="text-xs text-slate-500">
            {money(totals.out.pur)} MMK leaves the shelf
            {totals.in.sale > 0 ? ` - the parts sell for ${money(totals.in.sale)} MMK` : ""}
          </span>
        )}
      </div>

      {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      {msg && <p className="text-sm text-green-700 mt-3">{msg}</p>}
    </main>
  );
}

function Block({
  title, subtitle, tone, lines, side, showExpiry, onHand, onCode, onSearch, onPick, sugg, onSet, onDrop, totals,
}: {
  title: string;
  subtitle: string;
  tone: string;
  lines: Line[];
  side: "in" | "out";
  showExpiry: boolean;
  onHand: Record<string, { qty: number; cost: number }>;
  onCode: (key: string, code: string) => void;
  onSearch: (key: string, q: string) => void;
  onPick: (key: string, p: Product) => void;
  sugg: { key: string; items: Product[] };
  onSet: (key: string, patch: Partial<Line>) => void;
  onDrop: (key: string) => void;
  totals: { qty: number; pur: number; sale: number };
}) {
  const cell = "border border-slate-200 px-2 py-1 text-sm";
  const input = "w-full outline-none text-sm";

  return (
    <section className="mb-5">
      <h2 className="text-sm font-semibold tracking-wide text-slate-700 mb-1">{title}</h2>
      <p className="text-[11px] text-slate-500 mb-2">{subtitle}</p>

      <div className="flex flex-col lg:flex-row gap-3">
        <div className="flex-1 overflow-x-auto">
          <table className="min-w-full border border-slate-200">
            <thead className="bg-slate-50">
              <tr className="text-left text-[11px] text-slate-500">
                <th className={cell + " w-10"}>Sr</th>
                <th className={cell + " w-36"}>Code</th>
                <th className={cell}>Description</th>
                <th className={cell + " w-20 text-right"}>Qty</th>
                <th className={cell + " w-16"}>Unit</th>
                <th className={cell + " w-24 text-right"}>Sale Price</th>
                <th className={cell + " w-24 text-right"}>Pur Price</th>
                <th className={cell + " w-28 text-right"}>Amount</th>
                {showExpiry && <th className={cell + " w-24"}>On hand</th>}
                <th className={cell + " w-10"}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const qty = Number(l.qty) || 0;
                const amount = qty * (Number(l.purPrice) || 0);
                return (
                  <tr key={l.key}>
                    <td className={cell + " text-slate-400"}>{i + 1}</td>
                    <td className={cell + " relative"}>
                      <input
                        className={input}
                        value={l.code}
                        placeholder="scan or search"
                        onChange={(e) => {
                          onSet(l.key, { code: e.target.value });
                          onSearch(l.key, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onCode(l.key, (e.target as HTMLInputElement).value);
                        }}
                      />
                      {sugg.key === l.key && sugg.items.length > 0 && (
                        <ul className="absolute z-20 left-0 top-full w-80 max-h-60 overflow-auto bg-white border border-slate-200 rounded shadow text-sm">
                          {sugg.items.map((p) => (
                            <li key={p.id}>
                              <button
                                onMouseDown={(e) => { e.preventDefault(); onPick(l.key, p); }}
                                className="block w-full text-left px-2 py-1 hover:bg-slate-100"
                              >
                                <span className="text-slate-800">{p.name}</span>
                                {p.sku && <span className="text-slate-400"> - {p.sku}</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={cell + (l.name === "not found" ? " text-red-600" : "")}>
                      {l.name || <span className="text-slate-300">-</span>}
                    </td>
                    <td className={cell}>
                      <input
                        type="number" min="0"
                        className={input + " text-right"}
                        value={l.qty}
                        onChange={(e) => onSet(l.key, { qty: e.target.value })}
                      />
                    </td>
                    <td className={cell + " text-slate-500"}>{l.unit || "-"}</td>
                    <td className={cell + " text-right text-slate-500"}>
                      {l.salePrice ? money(l.salePrice) : "-"}
                    </td>
                    <td className={cell}>
                      <input
                        type="number" min="0"
                        className={input + " text-right"}
                        placeholder={side === "in" ? "auto" : ""}
                        value={l.purPrice}
                        onChange={(e) => onSet(l.key, { purPrice: e.target.value })}
                      />
                    </td>
                    <td className={cell + " text-right"}>{amount ? money(amount) : "-"}</td>
                    {showExpiry && (
                      <td className={cell + " text-right text-slate-500"}>
                        {l.product_id ? (onHand[l.product_id]?.qty || 0).toLocaleString() : "-"}
                      </td>
                    )}
                    <td className={cell + " text-center"}>
                      <button onClick={() => onDrop(l.key)}
                        className="text-red-500 text-xs">&times;</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="lg:w-64 shrink-0">
          <div className={`${tone} text-white text-[11px] font-medium px-3 py-1 rounded-t`}>
            {title}
          </div>
          <div className="border border-slate-200 rounded-b divide-y divide-slate-100">
            <Row label="Qty" value={totals.qty.toLocaleString()} />
            <Row label="Total PurAmount" value={money(totals.pur)} />
            <Row label="Total SaleAmount" value={money(totals.sale)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
