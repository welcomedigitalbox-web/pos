"use client";

import { useEffect, useState } from "react";
import { supabase, Product, Customer, PaymentMethodRow, LoyaltyTier } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { useRouter } from "next/navigation";
import { hasPermission } from "../permissions";
import { tierDiscountPercent } from "../loyalty";

type OrderLine = {
  tempId: string;
  product_id: string;
  name: string;
  qty: number;
  unit_price: number;
  avg_cost: number;
  available_stock: number;
};

type OrderStatus = "pending" | "processing" | "delivered" | "cancelled";

type MyOrderRow = {
  id: string;
  created_at: string;
  total: number;
  order_status: OrderStatus;
  customer_name: string | null;
  delivery_address: string | null;
  store_id: string;
  note: string | null;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function SaleOrderPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasPermission(profile, "sale-order")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [fulfillStoreId, setFulfillStoreId] = useState("");
  const [loyaltyTiers, setLoyaltyTiers] = useState<LoyaltyTier[]>([]);
  const [storeProducts, setStoreProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [showProductDropdown, setShowProductDropdown] = useState(false);

  const [lines, setLines] = useState<OrderLine[]>([]);
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
    if (storeId && !fulfillStoreId) setFulfillStoreId(storeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (fulfillStoreId) {
      loadStoreProducts();
      loadCustomers();
      loadPaymentMethods();
      loadLoyaltyTiers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillStoreId]);

  useEffect(() => {
    loadMyOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, profile]);

  async function loadStoreProducts() {
    const { data } = await supabase.from("products").select("*").eq("store_id", fulfillStoreId).order("name");
    setStoreProducts(data || []);
  }

  async function loadCustomers() {
    const { data } = await supabase.from("customers").select("*").eq("store_id", fulfillStoreId).order("name");
    setCustomers(data || []);
  }

  async function loadLoyaltyTiers() {
    const { data } = await supabase
      .from("loyalty_tiers")
      .select("*")
      .eq("store_id", fulfillStoreId)
      .order("sort_order");
    setLoyaltyTiers(data || []);
  }

  async function loadPaymentMethods() {
    const { data } = await supabase
      .from("payment_methods")
      .select("*")
      .eq("store_id", fulfillStoreId)
      .eq("is_active", true)
      .order("sort_order");
    setPaymentMethods(data || []);
    if (data && data.length > 0) setPaymentMethod(data[0].code);
  }

  async function loadMyOrders() {
    if (!profile) return;
    const { data } = await supabase
      .from("sales")
      .select("id, created_at, total, order_status, customer_name, delivery_address, store_id, note")
      .eq("cashier_email", profile.email)
      .neq("order_type", "walk_in")
      .order("created_at", { ascending: false })
      .limit(30);
    setMyOrders((data as MyOrderRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function resetOrder() {
    setLines([]);
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPhone("");
    setDeliveryAddress("");
    setOrderStatus("pending");
    setNote("");
  }

  const filteredProducts = storeProducts.filter(
    (p) =>
      p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
      (p.sku || "").toLowerCase().includes(productSearch.toLowerCase())
  );

  function addLine(p: Product) {
    setLines((prev) => {
      const existing = prev.find((l) => l.product_id === p.id);
      if (existing) {
        return prev.map((l) => (l.product_id === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [
        ...prev,
        {
          tempId: crypto.randomUUID(),
          product_id: p.id,
          name: p.name,
          qty: 1,
          unit_price: p.price,
          avg_cost: p.avg_cost,
          available_stock: p.stock_qty,
        },
      ];
    });
    setProductSearch("");
    setShowProductDropdown(false);
  }

  function updateLine(tempId: string, field: "qty" | "unit_price", value: number) {
    setLines((prev) => prev.map((l) => (l.tempId === tempId ? { ...l, [field]: value } : l)));
  }

  function removeLine(tempId: string) {
    setLines((prev) => prev.filter((l) => l.tempId !== tempId));
  }

  const filteredCustomers = customers.filter(
    (c) => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || (c.phone || "").includes(customerSearch)
  );
  const exactCustomerMatch = customers.some((c) => c.name.toLowerCase() === customerSearch.trim().toLowerCase());

  async function quickAddCustomer() {
    const name = customerSearch.trim();
    if (!name) return;
    const { data, error } = await supabase
      .from("customers")
      .insert({ name, phone: customerPhone.trim() || null, store_id: fulfillStoreId })
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

  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unit_price, 0);
  const discountPercent = tierDiscountPercent(loyaltyTiers, selectedCustomer?.loyalty_tier_id);
  const discountAmount = (subtotal * discountPercent) / 100;
  const total = subtotal - discountAmount;
  const orderTypeValue = profile?.role === "wholesale" ? "wholesale" : "online";
  const hasShortage = lines.some((l) => l.qty > l.available_stock);

  async function submitOrder() {
    if (lines.length === 0) return;
    if (!selectedCustomer && !customerSearch.trim()) return showToast(t("saleOrder_customerRequired"));

    setLoading(true);
    try {
      const shortageNotes: string[] = [];

      const { data: sale, error: saleErr } = await supabase
        .from("sales")
        .insert({
          store_id: fulfillStoreId,
          total,
          subtotal,
          discount_type: "percent",
          discount_value: discountPercent,
          discount_amount: discountAmount,
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

      const items = lines.map((l) => ({
        sale_id: sale.id,
        product_id: l.product_id,
        product_name: l.name,
        qty: l.qty,
        unit_price: l.unit_price,
        line_total: l.qty * l.unit_price,
        unit_cost: l.avg_cost,
        line_cogs: l.avg_cost * l.qty,
      }));
      const { error: itemsErr } = await supabase.from("sale_items").insert(items);
      if (itemsErr) throw itemsErr;

      for (const l of lines) {
        const deductQty = Math.min(l.qty, l.available_stock);
        const shortageQty = l.qty - deductQty;

        const newStock = l.available_stock - deductQty;
        await supabase
          .from("products")
          .update({ stock_qty: newStock, updated_at: new Date().toISOString() })
          .eq("id", l.product_id);

        if (deductQty > 0) {
          const { data: batches } = await supabase
            .from("stock_purchases")
            .select("id, remaining_qty")
            .eq("product_id", l.product_id)
            .gt("remaining_qty", 0)
            .order("expiry_date", { ascending: true, nullsFirst: false })
            .order("created_at", { ascending: true });

          let remainingToDeduct = deductQty;
          for (const batch of batches || []) {
            if (remainingToDeduct <= 0) break;
            const d = Math.min(batch.remaining_qty, remainingToDeduct);
            await supabase.from("stock_purchases").update({ remaining_qty: batch.remaining_qty - d }).eq("id", batch.id);
            remainingToDeduct -= d;
          }
        }

        if (shortageQty > 0) {
          await supabase.from("stock_requests").insert({
            store_id: fulfillStoreId,
            product_id: l.product_id,
            requested_qty: shortageQty,
            note: `Auto-requested: Sale Order #${sale.id.slice(0, 8).toUpperCase()} (${l.name})`,
            requested_by: profile?.email || null,
          });
          shortageNotes.push(`${l.name} (-${shortageQty})`);
        }
      }

      if (shortageNotes.length > 0) {
        showToast(`⚠️ ${t("saleOrder_created")} ${fmt(total)} — ${t("saleOrder_shortageWarning")}: ${shortageNotes.join(", ")}`);
      } else {
        showToast(`✅ ${t("saleOrder_created")} ${fmt(total)}`);
      }
      resetOrder();
      await loadStoreProducts();
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
    <div className="pt-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        {/* Order builder */}
        <div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
            <h3 className="font-semibold mb-3">{t("saleOrder_newOrder")}</h3>

            {/* Fulfilling store */}
            <label className="text-xs text-slate-500">{t("saleOrder_fulfillingStore")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-3"
              value={fulfillStoreId}
              onChange={(e) => {
                setFulfillStoreId(e.target.value);
                setLines([]);
              }}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            {/* Add product */}
            <label className="text-xs text-slate-500">{t("stockIn_product")}</label>
            <div className="relative mt-1 mb-3">
              <input
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                placeholder={t("stockIn_searchPlaceholder")}
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setShowProductDropdown(true);
                }}
                onFocus={() => setShowProductDropdown(true)}
                onBlur={() => setTimeout(() => setShowProductDropdown(false), 150)}
              />
              {showProductDropdown && filteredProducts.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredProducts.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addLine(p)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex justify-between"
                    >
                      <span>{p.name}</span>
                      <span className={`text-xs ${p.stock_qty <= 5 ? "text-red-500" : "text-slate-400"}`}>
                        {t("pos_stock")}: {p.stock_qty}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Order lines table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-2 py-2">{t("stockIn_product")}</th>
                    <th className="text-left px-2 py-2">{t("stockIn_qtyColumn")}</th>
                    <th className="text-left px-2 py-2">{t("products_price")}</th>
                    <th className="text-left px-2 py-2">{t("pos_total")}</th>
                    <th className="text-left px-2 py-2">{t("saleOrder_readiness")}</th>
                    <th className="text-left px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const ready = l.qty <= l.available_stock;
                    return (
                      <tr key={l.tempId} className="border-t border-slate-100">
                        <td className="px-2 py-2">{l.name}</td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            className="w-16 border border-slate-200 rounded px-2 py-1 text-sm"
                            value={l.qty}
                            min={1}
                            onChange={(e) => updateLine(l.tempId, "qty", Number(e.target.value) || 1)}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            className="w-24 border border-slate-200 rounded px-2 py-1 text-sm"
                            value={l.unit_price}
                            onChange={(e) => updateLine(l.tempId, "unit_price", Number(e.target.value) || 0)}
                          />
                        </td>
                        <td className="px-2 py-2 font-medium">{fmt(l.qty * l.unit_price)}</td>
                        <td className="px-2 py-2">
                          {ready ? (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                              {t("saleOrder_ready")}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
                              {t("saleOrder_notReady")} ({l.available_stock}/{l.qty})
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <button onClick={() => removeLine(l.tempId)} className="text-red-500 text-xs">
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-slate-400 py-6">
                        {t("saleOrder_noLines")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {hasShortage && (
              <div className="mt-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-700">
                ⚠️ {t("saleOrder_shortageNotice")}
              </div>
            )}
          </div>

          {/* My Orders list */}
          <h3 className="font-semibold mb-2">{t("saleOrder_myOrders")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[650px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("history_time")}</th>
                  <th className="text-left px-3 py-2">{t("admin_store")}</th>
                  <th className="text-left px-3 py-2">{t("pos_customer")}</th>
                  <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
                  <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
                </tr>
              </thead>
              <tbody>
                {myOrders.map((o) => (
                  <tr key={o.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-400">{o.store_id}</td>
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
                    <td colSpan={5} className="text-center text-slate-400 py-6">
                      -
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Side panel: customer + delivery + payment */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-24">
          {discountAmount > 0 && (
            <div className="text-xs space-y-1 mb-2">
              <div className="flex justify-between text-slate-500">
                <span>{t("pos_subtotal")}</span>
                <span>{fmt(subtotal)}</span>
              </div>
              <div className="flex justify-between text-green-600 font-medium">
                <span>
                  🎖️ {t("customers_loyaltyApplied")} ({discountPercent}%)
                </span>
                <span>-{fmt(discountAmount)}</span>
              </div>
            </div>
          )}
          <div className="flex justify-between font-bold text-lg border-b border-slate-100 pb-3 mb-3">
            <span>{t("pos_total")}</span>
            <span>{fmt(total)}</span>
          </div>

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
                    onMouseDown={(e) => e.preventDefault()}
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

          <label className="text-xs text-slate-500">{t("saleOrder_deliveryAddress")}</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-2"
            rows={2}
            value={deliveryAddress}
            onChange={(e) => setDeliveryAddress(e.target.value)}
          />

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

          <label className="text-xs text-slate-500">{t("pos_note")}</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 mb-3"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <button
            onClick={submitOrder}
            disabled={lines.length === 0 || loading}
            className="w-full py-3 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold"
          >
            {loading ? t("pos_processing") : t("saleOrder_submit")}
          </button>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
