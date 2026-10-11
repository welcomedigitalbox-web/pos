"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Move = {
  at: string; kind: string; qty: number;
  ref: string | null; party: string | null;
  amount: number | null; store_id: string;
  who: string | null; balance: number | null;
};

export type DetailRow = {
  product_id: string;
  variant_id: string | null;
  display_name: string;
  sku: string | null;
  price: number;
  stock_qty: number;
  avg_cost: number;
};

const money = (n: number | null) =>
  n === null || n === undefined ? "" : Number(n).toLocaleString() + " MMK";

export default function ProductDetail({
  row, storeId, canSeeCost, onClose,
}: { row: DetailRow; storeId: string; canSeeCost: boolean; onClose: () => void }) {
  const [moves, setMoves] = useState<Move[]>([]);
  const [codes, setCodes] = useState<{ barcode: string; kind: string }[]>([]);
  const [allStores, setAllStores] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    (async () => {
      const [mv, bc] = await Promise.all([
        supabase.rpc("product_movements", {
          p_product: row.product_id,
          p_variant: row.variant_id,
          p_store: allStores ? null : storeId,
          p_limit: 200,
        }),
        supabase.from("product_barcodes")
          .select("barcode, kind")
          .eq("product_id", row.product_id)
          .eq("is_active", true),
      ]);
      if (!live) return;
      setMoves((mv.data as Move[]) || []);
      setCodes((bc.data as { barcode: string; kind: string }[]) || []);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [row.product_id, row.variant_id, storeId, allStores]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-slate-900/20" onClick={onClose} />
      <div className="w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">{row.display_name}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {allStores ? "Every shop" : storeId}
            </p>
          </div>
          <button onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Internal code</div>
            <div className="font-medium">{row.sku || "-"}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Sale price</div>
            <div className="font-medium">{money(row.price)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">On hand here</div>
            <div className="font-medium">{row.stock_qty.toLocaleString()}</div>
          </div>
          {canSeeCost && (
            <div>
              <div className="text-xs text-slate-500">Average cost</div>
              <div className="font-medium">{money(row.avg_cost)}</div>
            </div>
          )}
        </div>

        <div className="px-5 pb-4">
          <div className="text-xs text-slate-500 mb-1">Other codes</div>
          {codes.length === 0 ? (
            <div className="text-sm text-slate-400">
              No supplier barcode on record for this item.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {codes.map((c, i) => (
                <span key={i} className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700">
                  {c.barcode} <span className="text-slate-400">· {c.kind}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 pb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Movement</h4>
          <label className="text-xs text-slate-500 flex items-center gap-1.5">
            <input type="checkbox" checked={allStores}
              onChange={(e) => setAllStores(e.target.checked)} />
            Every shop
          </label>
        </div>

        <div className="px-5 pb-8">
          {loading && <div className="text-sm text-slate-400 py-6 text-center">…</div>}
          {!loading && moves.length === 0 && (
            <div className="text-sm text-slate-400 py-6 text-center">
              Nothing has moved yet.
            </div>
          )}
          {!loading && moves.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {["When", "What", "Qty", "Left", "Ref", "Who / Customer", "Amount", "Shop"].map((h) => (
                    <th key={h} className="text-left px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {moves.map((m, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">
                      {String(m.at).slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-2 py-1.5">{m.kind}</td>
                    <td className={"px-2 py-1.5 text-right font-medium " +
                      (Number(m.qty) < 0 ? "text-red-600" : "text-green-700")}>
                      {Number(m.qty) > 0 ? "+" : ""}{Number(m.qty).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-500">
                      {m.balance === null || m.balance === undefined
                        ? "" : Number(m.balance).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-slate-500">{m.ref || ""}</td>
                    <td className="px-2 py-1.5 text-slate-500">
                      {[m.party, m.who].filter(Boolean).join(" · ")}
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-500">{money(m.amount)}</td>
                    <td className="px-2 py-1.5 text-slate-400">{m.store_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
