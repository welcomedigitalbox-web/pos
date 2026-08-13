"use client";

import { useEffect, useState } from "react";
import { supabase, LoyaltyTier } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

export default function LoyaltyTiersPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "loyalty-tiers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "loyalty-tiers")) return null;

  async function load() {
    const { data } = await supabase
      .from("loyalty_tiers")
      .select("*")
      .eq("store_id", storeId)
      .order("sort_order");
    setTiers(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setEditingId(null);
    setName("");
    setDiscountPercent("");
    setShowForm(true);
  }

  function openEdit(tier: LoyaltyTier) {
    setEditingId(tier.id);
    setName(tier.name);
    setDiscountPercent(String(tier.discount_percent));
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const pct = Number(discountPercent);
    if (!name.trim()) return showToast(t("loyaltyTiers_nameRequired"));
    if (isNaN(pct) || pct < 0 || pct > 100) return showToast(t("loyaltyTiers_percentInvalid"));

    try {
      if (editingId) {
        const { error } = await supabase
          .from("loyalty_tiers")
          .update({ name: name.trim(), discount_percent: pct })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("loyalty_tiers").insert({
          store_id: storeId,
          name: name.trim(),
          discount_percent: pct,
          sort_order: tiers.length + 1,
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
    if (!confirm(t("loyaltyTiers_deleteConfirm"))) return;
    const { error } = await supabase.from("loyalty_tiers").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("loyaltyTiers_deleted"));
    await load();
  }

  return (
    <div className="pt-4 max-w-xl">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("nav_loyaltyTiers")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("loyaltyTiers_addNew")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("loyaltyTiers_name")}</th>
              <th className="text-left px-4 py-2">{t("loyaltyTiers_discount")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{tier.name}</td>
                <td className="px-4 py-2">{tier.discount_percent}%</td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button onClick={() => openEdit(tier)} className="text-blue-600 text-xs font-medium">
                    {t("products_edit")}
                  </button>
                  <button onClick={() => handleDelete(tier.id)} className="text-red-600 text-xs font-medium">
                    {t("products_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {tiers.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-8">
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
              {editingId ? t("products_edit") : t("loyaltyTiers_addNew")}
            </h3>

            <label className="text-sm text-slate-600">{t("loyaltyTiers_name")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Diamond, Premium..."
              required
            />

            <label className="text-sm text-slate-600">{t("loyaltyTiers_discount")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(e.target.value)}
              placeholder="7"
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
