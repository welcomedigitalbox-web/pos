"use client";

import { useEffect, useState } from "react";
import { supabase, Product } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type FormState = {
  id: string | null;
  name: string;
  sku: string;
  price: string;
  stock_qty: string;
  avg_cost: string;
};

const emptyForm: FormState = { id: null, name: "", sku: "", price: "", stock_qty: "", avg_cost: "" };

export default function ProductsPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && profile.role === "cashier") {
      router.replace("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || profile.role === "cashier") return null;

  async function load() {
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

  function generateSku() {
    const storePrefix = storeId.replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase();
    const timestampPart = Date.now().toString().slice(-6);
    const randomPart = Math.floor(Math.random() * 90 + 10); // 2-digit
    return `${storePrefix}-${timestampPart}${randomPart}`;
  }

  function openNew() {
    setForm({ ...emptyForm, sku: generateSku() });
    setShowForm(true);
  }

  function openEdit(p: Product) {
    setForm({
      id: p.id,
      name: p.name,
      sku: p.sku || "",
      price: String(p.price),
      stock_qty: String(p.stock_qty),
      avg_cost: String(p.avg_cost),
    });
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return showToast(t("products_nameRequired"));
    if (!form.sku.trim()) return showToast(t("products_skuRequired"));
    const price = Number(form.price);
    const stock_qty = Number(form.stock_qty);
    const avg_cost = form.avg_cost === "" ? 0 : Number(form.avg_cost);
    if (isNaN(price) || price < 0) return showToast(t("products_priceInvalid"));
    if (isNaN(stock_qty) || stock_qty < 0) return showToast(t("products_stockInvalid"));
    if (isNaN(avg_cost) || avg_cost < 0) return showToast(t("products_avgCostInvalid"));

    setSaving(true);
    try {
      if (form.id) {
        const { error } = await supabase
          .from("products")
          .update({
            name: form.name.trim(),
            sku: form.sku.trim() || null,
            price,
            stock_qty,
            avg_cost,
            updated_at: new Date().toISOString(),
          })
          .eq("id", form.id);
        if (error) throw error;
        showToast(t("products_updateSuccess"));
      } else {
        const { error } = await supabase.from("products").insert({
          name: form.name.trim(),
          sku: form.sku.trim() || null,
          price,
          stock_qty,
          avg_cost,
          store_id: storeId,
        });
        if (error) throw error;
        showToast(t("products_createSuccess"));
      }
      setShowForm(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("products_deleteConfirm"))) return;
    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("products_deleteSuccess"));
    await load();
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("products_title")} ({storeId})</h2>
        <button
          onClick={openNew}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("products_addNew")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("products_name")}</th>
              <th className="text-left px-4 py-2">{t("products_sku")}</th>
              <th className="text-left px-4 py-2">{t("products_price")}</th>
              <th className="text-left px-4 py-2">{t("products_avgCost")}</th>
              <th className="text-left px-4 py-2">{t("products_stock")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2 text-slate-400">{p.sku || "-"}</td>
                <td className="px-4 py-2">{fmt(p.price)}</td>
                <td className="px-4 py-2 text-slate-500">
                  {p.previous_avg_cost > 0 && p.previous_avg_cost !== p.avg_cost ? (
                    <span>
                      <span className="line-through text-slate-300">{fmt(p.previous_avg_cost)}</span>
                      {" → "}
                      <span className="font-medium text-slate-700">{fmt(p.avg_cost)}</span>
                    </span>
                  ) : (
                    fmt(p.avg_cost)
                  )}
                </td>
                <td className={`px-4 py-2 ${p.stock_qty <= 5 ? "text-red-600 font-medium" : ""}`}>
                  {p.stock_qty}
                </td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button
                    onClick={() => openEdit(p)}
                    className="text-blue-600 text-xs font-medium"
                  >
                    {t("products_edit")}
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-red-600 text-xs font-medium"
                  >
                    {t("products_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  {t("products_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleSave}
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg"
          >
            <h3 className="font-semibold text-lg mb-4">
              {form.id ? t("products_modalEditTitle") : t("products_modalNewTitle")}
            </h3>

            <label className="text-sm text-slate-600">{t("products_productName")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("products_skuOptional")}</label>
            <div className="flex gap-1 mt-1 mb-1">
              <input
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                required
              />
              {!form.id && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, sku: generateSku() })}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-500"
                  title={t("products_skuRegenerate")}
                >
                  🔄
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400 mb-3">
              {!form.id ? t("products_skuAutoHint") : ""}
            </p>

            <label className="text-sm text-slate-600">{t("products_priceMmk")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("products_stockQty")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.stock_qty}
              onChange={(e) => setForm({ ...form, stock_qty: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("products_avgCostMmk")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={form.avg_cost}
              onChange={(e) => setForm({ ...form, avg_cost: e.target.value })}
              placeholder="0"
            />
            <p className="text-xs text-slate-400 -mt-3 mb-4">{t("products_avgCostWarning")}</p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? t("products_saving") : t("products_save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
