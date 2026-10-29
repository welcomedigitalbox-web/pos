"use client";

// =====================================================================
// Conversion.
//
// One article leaves the shelf and several come back: a water-bottle set
// becomes a body, a pipe and a cap, because that is how the customer
// wants to buy it, or because one part of it broke.
//
// Both sides are one movement. The cost of what went out is carried over
// to what came in, so the warehouse is worth the same before and after.
// The database does the sharing; this page only says what went in and
// what came out.
// =====================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Product = {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
};

type Line = {
  key: string;
  product_id: string;
  name: string;
  qty: string;
  unit_cost: string; // only used on the way in, and only if typed
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

export default function ConversionPage() {
  const { profile } = useAuth();
  const allowed = hasPermission(profile, "conversion");

  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [outLines, setOutLines] = useState<Line[]>([]);
  const [inLines, setInLines] = useState<Line[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [onHand, setOnHand] = useState<Record<string, number>>({});

  useEffect(() => {
    supabase
      .from("stores")
      .select("id,name")
      .order("name")
      .then(({ data }) => {
        const list = (data as { id: string; name: string }[]) || [];
        setStores(list);
        setStoreId((s) => s || list.find((x) => /wh|warehouse/i.test(x.id))?.id || list[0]?.id || "");
      });

    // The catalogue, once. A warehouse list is long but it is only names.
    (async () => {
      const all: Product[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("products")
          .select("id,name,sku,price")
          .eq("is_active", true)
          .order("name")
          .range(from, from + 999);
        const page = (data as Product[]) || [];
        all.push(...page);
        if (error || page.length < 1000) break;
      }
      setProducts(all);
    })();
  }, []);

  // What is on the shelf here, so a line that cannot be taken apart is
  // obvious before the button is pressed rather than after.
  const loadOnHand = useCallback(async () => {
    if (!storeId) return;
    const map: Record<string, number> = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("store_inventory")
        .select("product_id,stock_qty")
        .eq("store_id", storeId)
        .range(from, from + 999);
      const page = (data as { product_id: string; stock_qty: number }[]) || [];
      for (const r of page) map[r.product_id] = (map[r.product_id] || 0) + Number(r.stock_qty || 0);
      if (error || page.length < 1000) break;
    }
    setOnHand(map);
  }, [storeId]);

  useEffect(() => { loadOnHand(); }, [loadOnHand]);

  function addLine(side: "out" | "in") {
    const row: Line = { key: crypto.randomUUID(), product_id: "", name: "", qty: "1", unit_cost: "" };
    (side === "out" ? setOutLines : setInLines)((r) => [...r, row]);
  }

  function setLine(side: "out" | "in", key: string, patch: Partial<Line>) {
    (side === "out" ? setOutLines : setInLines)((r) =>
      r.map((l) => (l.key === key ? { ...l, ...patch } : l))
    );
  }

  function dropLine(side: "out" | "in", key: string) {
    (side === "out" ? setOutLines : setInLines)((r) => r.filter((l) => l.key !== key));
  }

  const byId = useMemo(() => {
    const m: Record<string, Product> = {};
    for (const p of products) m[p.id] = p;
    return m;
  }, [products]);

  // What the parts would sell for, which is how the cost gets shared.
  const inValue = useMemo(
    () =>
      inLines.reduce((sum, l) => {
        const price = Number(byId[l.product_id]?.price || 0);
        return sum + price * (Number(l.qty) || 0);
      }, 0),
    [inLines, byId]
  );

  const outPieces = outLines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const inPieces = inLines.reduce((n, l) => n + (Number(l.qty) || 0), 0);

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
        unit_cost: l.unit_cost.trim() === "" ? null : Number(l.unit_cost),
      }));

    if (out.length === 0) return setErr("Nothing to take apart");
    if (into.length === 0) return setErr("Nothing comes back");

    setBusy(true);
    const { data, error } = await supabase.rpc("convert_stock", {
      p_store: storeId,
      p_out: out,
      p_in: into,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(describeError(error)); return; }

    const res = (data as { ref?: string; cost?: number; lines_in?: number }) || {};
    setMsg(`Done - ${money(Number(res.cost || 0))} MMK moved across ${res.lines_in || 0} line(s)`);
    setOutLines([]); setInLines([]); setNote("");
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

  const field = "border border-slate-300 rounded-lg px-2 py-1 text-sm";

  return (
    <main className="p-4 sm:p-6 max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold">Conversion</h1>
      <p className="text-xs text-slate-500 mb-4">
        Take one article off the shelf and put its parts on. What it cost
        goes with the parts, shared by what each of them sells for.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label className="block text-[11px] text-slate-500">Location</label>
          <select className={field} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[11px] text-slate-500">Note</label>
          <input
            className={field + " w-full"}
            placeholder="Why it was taken apart"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <Side
        title="Taken apart"
        hint="The article that leaves the shelf"
        lines={outLines}
        products={products}
        byId={byId}
        onHand={onHand}
        showCost={false}
        onAdd={() => addLine("out")}
        onSet={(k, patch) => setLine("out", k, patch)}
        onDrop={(k) => dropLine("out", k)}
      />

      <Side
        title="Comes back"
        hint="The parts that go on the shelf. Leave the cost empty to let it be shared automatically."
        lines={inLines}
        products={products}
        byId={byId}
        onHand={onHand}
        showCost
        onAdd={() => addLine("in")}
        onSet={(k, patch) => setLine("in", k, patch)}
        onDrop={(k) => dropLine("in", k)}
      />

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button
          onClick={confirm}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-50"
        >
          {busy ? "Working..." : "Confirm conversion"}
        </button>
        <span className="text-xs text-slate-500">
          {outPieces} piece(s) out, {inPieces} back
          {inValue > 0 ? ` - parts sell for ${money(inValue)} MMK` : ""}
        </span>
      </div>

      {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      {msg && <p className="text-sm text-green-700 mt-3">{msg}</p>}
    </main>
  );
}

function Side({
  title, hint, lines, products, byId, onHand, showCost, onAdd, onSet, onDrop,
}: {
  title: string;
  hint: string;
  lines: Line[];
  products: Product[];
  byId: Record<string, Product>;
  onHand: Record<string, number>;
  showCost: boolean;
  onAdd: () => void;
  onSet: (key: string, patch: Partial<Line>) => void;
  onDrop: (key: string) => void;
}) {
  const field = "border border-slate-300 rounded-lg px-2 py-1 text-sm";
  return (
    <section className="border border-slate-200 rounded-lg p-3 mb-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <button onClick={onAdd} className="text-xs text-blue-600">+ add line</button>
      </div>
      <p className="text-[11px] text-slate-500 mb-2">{hint}</p>

      {lines.length === 0 && (
        <p className="text-xs text-slate-400">No lines yet.</p>
      )}

      <div className="space-y-2">
        {lines.map((l) => (
          <div key={l.key} className="flex flex-wrap items-center gap-2">
            <select
              className={field + " flex-1 min-w-[220px]"}
              value={l.product_id}
              onChange={(e) => onSet(l.key, { product_id: e.target.value })}
            >
              <option value="">Pick a product...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.sku ? ` (${p.sku})` : ""}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              className={field + " w-20 text-right"}
              value={l.qty}
              onChange={(e) => onSet(l.key, { qty: e.target.value })}
            />
            {showCost && (
              <input
                type="number"
                min="0"
                placeholder="cost"
                className={field + " w-24 text-right"}
                value={l.unit_cost}
                onChange={(e) => onSet(l.key, { unit_cost: e.target.value })}
              />
            )}
            <span className="text-[11px] text-slate-400 w-28">
              {l.product_id
                ? `on hand ${(onHand[l.product_id] || 0).toLocaleString()}`
                : ""}
              {l.product_id && byId[l.product_id]?.price
                ? ` - ${money(Number(byId[l.product_id]?.price))}`
                : ""}
            </span>
            <button onClick={() => onDrop(l.key)} className="text-xs text-red-600 px-1">
              remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
