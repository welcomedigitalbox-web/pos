"use client";

import { useEffect, useState } from "react";
import { supabase, Product, Customer, PaymentMethodRow } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { useRouter } from "next/navigation";
import { hasPermission } from "../permissions";

type CartItem = {
  product_id: string;
  name: string;
  price: number;
  qty: number;
  stock_qty: number;
  avg_cost: number;
};

type OrderStatus = "pending" | "processing" | "delivered" | "cancelled";

type MyOrderRow = {
  id: string;
  created_at: string;
  total: number;
  order_status: OrderStatus;
  customer_name: string | null;
  delivery_address: string | null;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function SaleOrderPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasPermission(profile, "sale-order")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerPhone, setCustomerPhone] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");

  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodRow[]>([]);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [orderStatus, setOrderStatus] = useState<OrderStatus>("pending");
  const [note, setNote] = useState("");

  const [myOrders, setMyOrders] = useState<MyOrderRow[]>([]);

  useEffect(() => {
    loadProducts();
    loadCustomers();
    loadPaymentMethods();
    loadMyOrders();
    resetOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function loadProducts() {
    const { data } = await supabase.from("products").select("*").eq("store_id", storeId).order("name");
    setProducts(data || []);
  }

  async function loadCustomers() {
    const { data } = await supabase.from("customers").select("*").eq("store_id", storeId).order("name");
    setCustomers(data || []);
  }

  async function loadPaymentMethods() {
    const { data } = await supabase
      .from("payment_methods")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("sort_order");
    setPaymentMethods(data || []);
    if (data && data.length > 0) setPaymentMethod(data[0].code);
  }

  async function loadMyOrders() {
    if (!profile) return;
    const { data } = await supabase
      .from("sales")
      .select("id, created_at, total, order_status, customer_name, delivery_address")
      .eq("store_id", storeId)
      .eq("cashier_email", profile.email)
      .neq("order_type", "walk_in")
      .order("created_at", { ascending: false })
      .limit(30);
    setMyOrders((data as MyOrderRow[]) || []);
  }

  function resetOrder() {
    setCart([]);
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPhone("");
    setDeliveryAddress("");
    setOrderStatus("pending");
    setNote("");
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function addToCart(p: Product) {
    if (p.stock_qty <= 0) return showToast(t("pos_outOfStock"));
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === p.id);
      if (existing) {
        if (existing.qty >= p.stock_qty) {
          showToast(t("pos_notEnoughStock"));
          return prev;
        }
        return prev.map((c) => (c.product_id === p.id ? { ...c, qty: c.qty + 1 } : c));
      }
      return [
        ...prev,
        { product_id: p.id, name: p.name, price: p.price, qty: 1, stock_qty: p.stock_qty, avg_cost: p.avg_cost },
      ];
    });
  }

  function changeQty(productId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.product_id !== productId) return c;
          const newQty = c.qty + delta;
          if (newQty > c.stock_qty) {
            showToast(t("pos_notEnoughStock"));
            return c;
          }
          return { ...c, qty: newQty };
        })
        .filter((c) => c.qty > 0)
    );
  }

  const filtered = products.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.sku || "").toLowerCase().includes(search.toLowerCase())
  );

  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
      (c.phone || "").includes(customerSearch)
  );
  const exactCustomerMatch = customers.some(
    (c) => c.name.toLowerCase() === customerSearch.trim().toLowerCase()
  );

  async function quickAddCustomer() {
    const name = customerSearch.trim();
    if (!name) return;
    const { data, error } = await supabase
      .from("customers")
      .insert({ name, phone: customerPhone.trim() || null, store_id: storeId })
      .select()
      .single();
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    setCustomers((prev) => [...prev, data]);
    setSelectedCustomer(data);
    setCustomerSearch(data.name);
    setShowCustomerDropdown(false);
  }

  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const orderTypeValue = profile?.role === "wholesale" ? "wholesale" : "online";

  async function submitOrder() {
    if (cart.length === 0) return;
    if (!selectedCustomer && !customerSearch.trim()) {
      return showToast(t("saleOrder_customerRequired"));
    }
    setLoading(true);
    try {
      const { data: sale, error: saleErr } = await supabase
        .from("sales")
        .insert({
          store_id: storeId,
          total,
          subtotal: total,
          cashier_email: profile?.email || null,
          payment_method: paymentMethod,
          order_type: orderTypeValue,
          order_status: orderStatus,
          customer_id: selectedCustomer?.id || null,
          customer_name: selectedCustomer?.name || customerSearch.trim(),
          delivery_address: deliveryAddress.trim() || null,
          note: note.trim() || null,
        })
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

        const { data: batches } = await supabase
          .from("stock_purchases")
          .select("id, remaining_qty, expiry_date, created_at")
          .eq("product_id", c.product_id)
          .gt("remaining_qty", 0)
          .order("expiry_date", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true });

        let remainingToDeduct = c.qty;
        for (const batch of batches || []) {
          if (remainingToDeduct <= 0) break;
          const deductFromBatch = Math.min(batch.remaining_qty, remainingToDeduct);
          await supabase
            .from("stock_purchases")
            .update({ remaining_qty: batch.remaining_qty - deductFromBatch })
            .eq("id", batch.id);
          remainingToDeduct -= deductFromBatch;
        }
      }

      showToast(`✅ ${t("saleOrder_created")} ${fmt(total)}`);
      resetOrder();
      await loadProducts();
      await loadMyOrders();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setLoading(false);
    }
  }

  async function updateOrderStatus(orderId: string, status: OrderStatus) {
    await supabase.from("sales").update({ order_status: status }).eq("id", orderId);
    await loadMyOrders();
  }

  const statusColor: Record<OrderStatus, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    processing: "bg-blue-100 text-blue-700",
    delivered: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-700",
  };

  if (!profile || !hasPermission(profile, "sale-order")) return null;

  return (
    <div className="pt-4 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
      <div>
        <input
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
          placeholder={t("pos_search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
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
              <div className={`text-xs mt-1 ${p.stock_qty <= 5 ? "text-red-600" : "text-slate-500"}`}>
                {t("pos_stock")}: {p.stock_qty}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-8">{t("pos_noProduct")}</div>
          )}
        </div>

        {/* My Orders list */}
        <h3 className="font-semibold mb-2">{t("saleOrder_myOrders")}</h3>
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("history_time")}</th>
                <th className="text-left px-3 py-2">{t("pos_customer")}</th>
                <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
                <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              </tr>
            </thead>
            <tbody>
              {myOrders.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{o.customer_name || "-"}</td>
                  <td className="px-3 py-2 font-medium">{fmt(o.total)}</td>
                  <td className="px-3 py-2">
                    <select
                      value={o.order_status}
                      onChange={(e) => updateOrderStatus(o.id, e.target.value as OrderStatus)}
                      className={`text-xs font-medium rounded px-2 py-1 border-0 ${statusColor[o.order_status]}`}
                    >
                      <option value="pending">{t("saleOrder_pending")}</option>
                      <option value="processing">{t("saleOrder_processing")}</option>
                      <option value="delivered">{t("saleOrder_delivered")}</option>
                      <option value="cancelled">{t("saleOrder_cancelled")}</option>
                    </select>
                  </td>
                </tr>
              ))}
              {myOrders.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-slate-400 py-6">
                    -
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order form panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-24">
        <h3 className="font-semibold mb-3">{t("saleOrder_newOrder")}</h3>

        {cart.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-6">{t("pos_emptyCart")}</div>
        ) : (
          <div className="space-y-2 mb-3">
            {cart.map((c) => (
              <div key={c.product_id} className="flex justify-between items-center border-b border-slate-100 pb-2 text-sm">
                <div>
                  <div>{c.name}</div>
                  <div className="text-slate-400">{fmt(c.price)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="w-6 h-6 border border-slate-200 rounded" onClick={() => changeQty(c.product_id, -1)}>-</button>
                  <span>{c.qty}</span>
                  <button className="w-6 h-6 border border-slate-200 rounded" onClick={() => changeQty(c.product_id, 1)}>+</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between font-bold text-lg border-t-2 border-slate-900 pt-2 mb-3">
          <span>{t("pos_total")}</span>
          <span>{fmt(total)}</span>
        </div>

        {/* Customer */}
        <label className="text-xs text-slate-500">{t("pos_customer")}</label>
        <div className="relative mt-1 mb-2">
          <input
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
            placeholder={t("pos_customerSearchPlaceholder")}
            value={customerSearch}
            onChange={(e) => {
              setCustomerSearch(e.target.value);
              setSelectedCustomer(null);
              setShowCustomerDropdown(true);
            }}
            onFocus={() => setShowCustomerDropdown(true)}
            onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
          />
          {showCustomerDropdown && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
              {filteredCustomers.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => {
                    setSelectedCustomer(c);
                    setCustomerSearch(c.name);
                    setShowCustomerDropdown(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                >
                  {c.name} {c.phone && <span className="text-slate-400">({c.phone})</span>}
                </button>
              ))}
              {customerSearch.trim() !== "" && !exactCustomerMatch && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={quickAddCustomer}
                  className="w-full text-left px-3 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50"
                >
                  {t("pos_customerAddNew").replace("{name}", customerSearch.trim())}
                </button>
              )}
            </div>
          )}
        </div>
        {customerSearch.trim() !== "" && !exactCustomerMatch && !selectedCustomer && (
          <input
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mb-2"
            placeholder={t("pos_customerPhone")}
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
          />
        )}

        {/* Delivery address */}
        <label className="text-xs text-slate-500">{t("saleOrder_deliveryAddress")}</label>
        <textarea
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-2"
          rows={2}
          value={deliveryAddress}
          onChange={(e) => setDeliveryAddress(e.target.value)}
        />

        {/* Payment method */}
        <label className="text-xs text-slate-500">{t("pos_paymentMethod")}</label>
        <select
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-2"
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
        >
          {paymentMethods.map((m) => (
            <option key={m.id} value={m.code}>
              {m.name}
            </option>
          ))}
        </select>

        {/* Order status */}
        <label className="text-xs text-slate-500">{t("saleOrder_status")}</label>
        <select
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-2"
          value={orderStatus}
          onChange={(e) => setOrderStatus(e.target.value as OrderStatus)}
        >
          <option value="pending">{t("saleOrder_pending")}</option>
          <option value="processing">{t("saleOrder_processing")}</option>
          <option value="delivered">{t("saleOrder_delivered")}</option>
        </select>

        {/* Note */}
        <label className="text-xs text-slate-500">{t("pos_note")}</label>
        <textarea
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-3"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <button
          onClick={submitOrder}
          disabled={cart.length === 0 || loading}
          className="w-full py-3 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold"
        >
          {loading ? t("pos_processing") : t("saleOrder_submit")}
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
