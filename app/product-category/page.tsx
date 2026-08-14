"use client";

import { useEffect, useState } from "react";
import { supabase, ProductCategory } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

export default function ProductCategoryPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [toast, setToast] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "product-category")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "product-category")) return null;

  async function load() {
    const { data } = await supabase.from("product_categories").select("*").order("sort_order");
    setCategories(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setEditingId(null);
    setName("");
    setShowForm(true);
  }

  function openEdit(c: ProductCategory) {
    setEditingId(c.id);
    setName(c.name);
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      if (editingId) {
        const { error } = await supabase.from("product_categories").update({ name: name.trim() }).eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("product_categories").insert({
          name: name.trim(),
          sort_order: categories.length + 1,
        });
        if (error) throw error;
      }
      showToast(t("loyaltyTiers_saved"));
      setShowForm(false);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("productCategory_deleteConfirm"))) return;
    const { error } = await supabase.from("product_categories").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    await load();
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-semibold text-lg">{t("nav_productCategory")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("productCategory_addNew")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{c.name}</td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button onClick={() => openEdit(c)} className="text-blue-600 text-xs font-medium">
                    {t("products_edit")}
                  </button>
                  <button onClick={() => handleDelete(c.id)} className="text-red-600 text-xs font-medium">
                    {t("products_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={2} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSave} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">
              {editingId ? t("products_edit") : t("productCategory_addNew")}
            </h3>
            <label className="text-sm text-slate-600">{t("customers_name")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Diapers, Feeding, Skincare..."
              required
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button type="submit" className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                {t("products_save")}
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
