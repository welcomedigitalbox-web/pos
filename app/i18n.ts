"use client";

import { useEffect, useState } from "react";
import { supabase, SalesRep } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

export default function SalesRepsPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [reps, setReps] = useState<SalesRep[]>([]);
  const [toast, setToast] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "sales-reps")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "sales-reps")) return null;

  async function load() {
    const { data } = await supabase.from("sales_reps").select("*").eq("store_id", storeId).order("name");
    setReps(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const { error } = await supabase.from("sales_reps").insert({ store_id: storeId, name: name.trim() });
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    setName("");
    setShowForm(false);
    await load();
  }

  async function toggleActive(rep: SalesRep) {
    await supabase.from("sales_reps").update({ is_active: !rep.is_active }).eq("id", rep.id);
    await load();
  }

  async function handleDelete(id: string) {
    if (!confirm(t("productCategory_deleteConfirm"))) return;
    const { error } = await supabase.from("sales_reps").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    await load();
  }

  return (
    <div className="pt-4 max-w-lg">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_salesReps")}</h2>
        <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("salesReps_addNew")}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">{t("salesReps_note")}</p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2">{t("admin_active")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2">
                  <button onClick={() => toggleActive(r)}>{r.is_active ? "🟢" : "⚪"}</button>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => handleDelete(r.id)} className="text-red-600 text-xs font-medium">
                    {t("products_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {reps.length === 0 && (
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
          <form onSubmit={handleAdd} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("salesReps_addNew")}</h3>
            <label className="text-sm text-slate-600">{t("customers_name")}</label>
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
