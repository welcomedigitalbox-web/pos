"use client";

import { useEffect, useState } from "react";
import { supabase, Product, Customer } from "@/lib/supabase";
import { useStore } from "./store-context";
import { useLanguage } from "./language-context";
import { useAuth } from "./auth-context";
import Receipt, { ReceiptData } from "./receipt";

type CartItem = {
  product_id: string;
  name: string;
  price: number;
  qty: number;
  stock_qty: number;
  avg_cost: number;
};

type PaymentMethod = "cash" | "card" | "bank_transfer" | "cod";
type DiscountType = "percent" | "flat";

const STANDARD_VAT_PERCENT = 5;

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function POSPage() {
  const { storeId } = useStore();
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [discountType, setDiscountType] = useState<DiscountType>("flat");
  const [discountValue, setDiscountValue] = useState("");
  const [vatEnabled, setVatEnabled] = useState(false);
  const [amountReceived, setAmountReceived] = useState("");
  const [advancePayment, setAdvancePayment] = useState("");
  const [note, setNote] = useState("");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerPhone, setCustomerPhone] = useState("");

  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  useEffect(() => {
    loadProducts();
    loadCustomers();
    resetOrder();
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

  async function loadCustomers() {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .eq("store_id", storeId)
      .order("name");
    setCustomers(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function resetOrder() {
    setCart([]);
    setPaymentMethod("cash");
    setDiscountType("flat");
    setDiscountValue("");
    setVatEnabled(false);
    setAmountReceived("");
    setAdvancePayment("");
    setNote("");
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPhone("");
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
            showToast(t("pos_notEnoughStock"));
            return c;
          }
          return { ...c, qty: newQty };
        })
        .filter((c) => c.qty > 0);
    });
  }

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
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

  // ---- Calculations ----
  const subtotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const discountValueNum = Number(discountValue) || 0;
  const discountAmount =
    discountType === "percent" ? (subtotal * discountValueNum) / 100 : discountValueNum;
  const afterDiscount = Math.max(subtotal - discountAmount, 0);
  const vatPercentNum = vatEnabled ? STANDARD_VAT_PERCENT : 0;
  const vatAmount = (afterDiscount * vatPercentNum) / 100;
  const grandTotal = afterDiscount + vatAmount;

  const amountReceivedNum = Number(amountReceived) || 0;
  const change = paymentMethod === "cash" ? Math.max(amountReceivedNum - grandTotal, 0) : 0;

  const advancePaymentNum = Number(advancePayment) || 0;
  const codOverpaid = paymentMethod === "cod" && advancePaymentNum > grandTotal;
  const balanceDue = paymentMethod === "cod" ? Math.max(grandTotal - advancePaymentNum, 0) : 0;
  const codChange = codOverpaid ? advancePaymentNum - grandTotal : 0;

  const canCheckout =
    cart.length > 0 &&
    (paymentMethod !== "cash" || amountReceivedNum >= grandTotal);

  async function checkout() {
    if (cart.length === 0) return;
    if (paymentMethod === "cash" && amountReceivedNum < grandTotal) {
      return showToast(t("pos_amountInsufficient"));
    }
    setLoading(true);
    try {
      const { data: sale, error: saleErr } = await supabase
        .from("sales")
        .insert({
          store_id: storeId,
          total: grandTotal,
          cashier: "POS",
          payment_method: paymentMethod,
          subtotal,
          discount_type: discountType,
          discount_value: discountValueNum,
          discount_amount: discountAmount,
          vat_percent: vatPercentNum,
          vat_amount: vatAmount,
          amount_received: paymentMethod === "cash" ? amountReceivedNum : grandTotal,
          change_amount: paymentMethod === "cod" ? codChange : change,
          advance_payment: paymentMethod === "cod" ? advancePaymentNum : 0,
          balance_due: balanceDue,
          note: note.trim() || null,
          customer_id: selectedCustomer?.id || null,
          customer_name: selectedCustomer?.name || (customerSearch.trim() || null),
          cashier_email: profile?.email || null,
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
      }

      const paymentLabelMap: Record<PaymentMethod, string> = {
        cash: "Cash",
        card: "Card",
        bank_transfer: "Bank Transfer",
        cod: "COD",
      };

      setReceiptData({
        storeId,
        saleRef: sale.id.slice(0, 8).toUpperCase(),
        createdAt: sale.created_at,
        items: cart.map((c) => ({ name: c.name, qty: c.qty, price: c.price, lineTotal: c.price * c.qty })),
        subtotal,
        discountLabel: discountType === "percent" ? `${discountValueNum}%` : fmt(discountAmount),
        discountAmount,
        vatPercent: vatPercentNum,
        vatAmount,
        grandTotal,
        paymentMethod: paymentLabelMap[paymentMethod],
        amountReceived: amountReceivedNum,
        change: paymentMethod === "cod" ? codChange : change,
        advancePayment: advancePaymentNum,
        balanceDue,
        note: note.trim(),
        customerName: selectedCustomer?.name || customerSearch.trim() || "",
        cashierEmail: profile?.email || "",
      });

      showToast(`${t("pos_saleSuccess")} ${fmt(grandTotal)}`);
      resetOrder();
      await loadProducts();

      setTimeout(() => window.print(), 300);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pt-4 grid grid-cols-1 md:grid-cols-[1fr_360px] gap-4">
      <div>
        <input
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
          placeholder={t("pos_search")}
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
                {t("pos_stock")}: {p.stock_qty}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-8">
              {t("pos_noProduct")}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-24">
        <h3 className="font-semibold mb-3">{t("pos_cart")}</h3>
        {cart.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-6">{t("pos_emptyCart")}</div>
        ) : (
          <div className="space-y-2 mb-3">
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

        {cart.length > 0 && (
          <>
            {/* Customer */}
            <div className="mb-2">
              <label className="text-xs text-slate-500">{t("pos_customer")}</label>
              <div className="relative mt-1">
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
                    {customerSearch.trim() === "" && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(null);
                          setCustomerSearch("");
                          setShowCustomerDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 text-slate-400"
                      >
                        {t("pos_customerWalkIn")}
                      </button>
                    )}
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
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  placeholder={t("pos_customerPhone")}
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              )}
            </div>

            {/* Discount */}
            <div className="mb-2">
              <label className="text-xs text-slate-500">{t("pos_discount")}</label>
              <div className="flex gap-1 mt-1">
                <input
                  type="number"
                  className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder="0"
                />
                <select
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as DiscountType)}
                >
                  <option value="flat">{t("pos_discountFlat")}</option>
                  <option value="percent">{t("pos_discountPercent")}</option>
                </select>
              </div>
            </div>

            {/* VAT */}
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs text-slate-500">
                {t("pos_vatToggle")} ({STANDARD_VAT_PERCENT}%)
              </label>
              <button
                type="button"
                onClick={() => setVatEnabled((v) => !v)}
                className={`w-10 h-5 rounded-full transition relative ${
                  vatEnabled ? "bg-blue-600" : "bg-slate-200"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition ${
                    vatEnabled ? "left-5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            {/* Totals */}
            <div className="text-xs space-y-1 border-t border-slate-100 pt-2 mt-2">
              <div className="flex justify-between text-slate-500">
                <span>{t("pos_subtotal")}</span>
                <span>{fmt(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>{t("pos_discount")}</span>
                  <span>-{fmt(discountAmount)}</span>
                </div>
              )}
              {vatAmount > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>VAT</span>
                  <span>{fmt(vatAmount)}</span>
                </div>
              )}
            </div>

            <div className="flex justify-between font-bold text-lg border-t-2 border-slate-900 mt-2 pt-2">
              <span>{t("pos_grandTotal")}</span>
              <span>{fmt(grandTotal)}</span>
            </div>

            {/* Payment method */}
            <div className="mt-3">
              <label className="text-xs text-slate-500">{t("pos_paymentMethod")}</label>
              <select
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">{t("pos_cash")}</option>
                <option value="card">{t("pos_card")}</option>
                <option value="bank_transfer">{t("pos_bankTransfer")}</option>
                <option value="cod">{t("pos_cod")}</option>
              </select>
            </div>

            {paymentMethod === "cash" && (
              <div className="mt-2">
                <label className="text-xs text-slate-500">{t("pos_amountReceived")}</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  value={amountReceived}
                  onChange={(e) => setAmountReceived(e.target.value)}
                  placeholder="0"
                />
                {amountReceivedNum > 0 && (
                  <div className="flex justify-between text-xs mt-1 text-green-700 font-medium">
                    <span>{t("pos_change")}</span>
                    <span>{fmt(change)}</span>
                  </div>
                )}
              </div>
            )}

            {paymentMethod === "cod" && (
              <div className="mt-2">
                <label className="text-xs text-slate-500">{t("pos_advancePayment")}</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  value={advancePayment}
                  onChange={(e) => setAdvancePayment(e.target.value)}
                  placeholder="0"
                />
                <div className="flex justify-between text-xs mt-1 text-orange-600 font-medium">
                  <span>{t("pos_balanceDue")}</span>
                  <span>{fmt(balanceDue)}</span>
                </div>
                {codOverpaid && (
                  <div className="flex justify-between text-xs mt-1 text-green-700 font-medium">
                    <span>{t("pos_change")}</span>
                    <span>{fmt(codChange)}</span>
                  </div>
                )}
              </div>
            )}

            {/* Note */}
            <div className="mt-2">
              <label className="text-xs text-slate-500">{t("pos_note")}</label>
              <textarea
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("pos_notePlaceholder")}
              />
            </div>
          </>
        )}

        <button
          onClick={checkout}
          disabled={!canCheckout || loading}
          className="w-full mt-3 py-3 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold"
        >
          {loading ? t("pos_processing") : t("pos_checkout")}
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}

      <Receipt data={receiptData} />
    </div>
  );
}
