"use client";

import { useEffect, useState } from "react";
import { supabase, Product } from "@/lib/supabase";
import { useStore } from "./store-context";

type CartItem = {
  product_id: string;
  name: string;
  price: number;
  qty: number;
  stock_qty: number;
  avg_cost: number;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function POSPage() {
  const { storeId } = useStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    loadProducts();
    setCart([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function loadProducts() {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("store_id", storeId)
      .order("name");
    if (!error) setProducts(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function addToCart(p: Product) {
    if (p.stock_qty <= 0) return showToast("Stock ကုန်နေပါတယ်");
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === p.id);
      if (existing) {
        if (existing.qty >= p.stock_qty) {
          showToast("Stock မလုံလောက်ပါ");
          return prev;
        }
        return prev.map((c) =>
          c.product_id === p.id ? { ...c, qty: c.qty + 1 } : c
        );
      }
      return [
        ...prev,
        { product_id: p.id, name: p.name, price: p.price, qty: 1, stock_qty: p.stock_qty, avg_cost: p.avg_cost },
      ];
    });
  }

  function changeQty(productId: string, delta: number) {
    setCart((prev) => {
      return prev
        .map((c) => {
          if (c.product_id !== productId) return c;
          const newQty = c.qty + delta;
          if (newQty > c.stock_qty) {
            showToast("Stock မလုံလောက်ပါ");
            return c;
          }
          return { ...c, qty: newQty };
        })
        .filter((c) => c.qty > 0);
    });
  }

  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  async function checkout() {
    if (cart.length === 0) return;
    setLoading(true);
    try {
      const { data: sale, error: saleErr } = await supabase
        .from("sales")
        .insert({ store_id: storeId, total, cashier: "POS" })
        .select()
        .single();
      if (saleErr) throw saleErr;

      const items = cart.map((c) => ({
        sale_id: sale.id,
        product_id: c.product_id,
        product_name: c.name,
        qty: c.qty,
        unit_price: c.price,
        line_total: c.price * c.qty,
        unit_cost: c.avg_cost,
        line_cogs: c.avg_cost * c.qty,
      }));
      const { error: itemsErr } = await supabase.from("sale_items").insert(items);
      if (itemsErr) throw itemsErr;

      for (const c of cart) {
        const newStock = c.stock_qty - c.qty;
        await supabase
          .from("products")
          .update({ stock_qty: newStock, updated_at: new Date().toISOString() })
          .eq("id", c.product_id);
      }

      showToast("✅ Sale success! Total: " + fmt(total));
      setCart([]);
      await loadProducts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ Error: " + message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pt-4 grid grid-cols-1 md:grid-cols-[1fr_340px] gap-4">
      <div>
        <input
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
          placeholder="Product ရှာပါ..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => addToCart(p)}
              className={`text-left bg-white border border-slate-200 rounded-xl p-3 hover:shadow-md hover:-translate-y-0.5 transition ${
                p.stock_qty <= 5 ? "border-red-300" : ""
              }`}
            >
              <div className="font-semibold text-sm">{p.name}</div>
              <div className="text-blue-600 font-bold text-sm">{fmt(p.price)}</div>
              <div
                className={`text-xs mt-1 ${
                  p.stock_qty <= 5 ? "text-red-600" : "text-slate-500"
                }`}
              >
                Stock: {p.stock_qty}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-8">
              Product မရှိပါ
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-24">
        <h3 className="font-semibold mb-3">ဈေးဝယ်စာရင်း</h3>
        {cart.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-6">Item ရွေးပါ</div>
        ) : (
          <div className="space-y-2">
            {cart.map((c) => (
              <div
                key={c.product_id}
                className="flex justify-between items-center border-b border-slate-100 pb-2 text-sm"
              >
                <div>
                  <div>{c.name}</div>
                  <div className="text-slate-400">{fmt(c.price)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="w-6 h-6 border border-slate-200 rounded"
                    onClick={() => changeQty(c.product_id, -1)}
                  >
                    -
                  </button>
                  <span>{c.qty}</span>
                  <button
                    className="w-6 h-6 border border-slate-200 rounded"
                    onClick={() => changeQty(c.product_id, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between font-bold text-lg border-t-2 border-slate-900 mt-3 pt-3">
          <span>Total</span>
          <span>{fmt(total)}</span>
        </div>
        <button
          onClick={checkout}
          disabled={cart.length === 0 || loading}
          className="w-full mt-3 py-3 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold"
        >
          {loading ? "Processing..." : "Checkout / Sale"}
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
