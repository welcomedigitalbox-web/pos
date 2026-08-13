"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useStore } from "../../store-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../../language-context";
import { useEffect } from "react";

export default function AdminStoresPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores, refreshStores } = useStore();
  const router = useRouter();

  const [showForm, setShowForm] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && profile.role !== "admin") router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || profile.role !== "admin") return null;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setId("");
    setName("");
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!id.trim() || !name.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("stores").insert({ id: id.trim(), name: name.trim() });
      if (error) throw error;

      // Payment methods and loyalty tiers are shared across all stores now —
      // no per-store seeding needed here.

      showToast("✅ " + t("admin_storeCreated"));
      setShowForm(false);
      await refreshStores();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(storeId: string) {
    if (!confirm(t("admin_storeDeleteConfirm"))) return;
    const { error } = await supabase.from("stores").delete().eq("id", storeId);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    await refreshStores();
  }

  return (
    <div className="pt-4 max-w-lg">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("admin_stores_title")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("admin_addStore")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("admin_storeId")}</th>
              <th className="text-left px-4 py-2">{t("admin_storeName")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-slate-400">{s.id}</td>
                <td className="px-4 py-2">{s.name}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => handleDelete(s.id)} className="text-red-600 text-xs font-medium">
                    {t("admin_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-6">
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
            <h3 className="font-semibold text-lg mb-4">{t("admin_addStore")}</h3>

            <label className="text-sm text-slate-600">{t("admin_storeId")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1"
              value={id}
              onChange={(e) => setId(e.target.value.toUpperCase())}
              placeholder="SR-NEW"
              required
            />
            <p className="text-xs text-slate-400 mb-3">{t("admin_storeIdHint")}</p>

            <label className="text-sm text-slate-600">{t("admin_storeName")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("admin_cancel")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? "..." : t("admin_save")}
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
