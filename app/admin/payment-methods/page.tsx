"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../../language-context";

const STORES = ["SR-BAK", "SR-MDY", "SR-NOKL", "SR-WZYD"];

type PaymentMethod = {
  id: string;
  store_id: string;
  name: string;
  code: string;
  is_cash: boolean;
  is_cod: boolean;
  is_active: boolean;
  sort_order: number;
};

export default function AdminPaymentMethodsPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [storeId, setStoreId] = useState("SR-BAK");
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [isCash, setIsCash] = useState(false);
  const [isCod, setIsCod] = useState(false);

  useEffect(() => {
    if (profile && profile.role !== "admin") router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadMethods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || profile.role !== "admin") return null;

  async function loadMethods() {
    const { data } = await supabase
      .from("payment_methods")
      .select("*")
      .eq("store_id", storeId)
      .order("sort_order");
    setMethods(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setName("");
    setCode("");
    setIsCash(false);
    setIsCod(false);
    setShowForm(true);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const finalCode = code.trim() || name.trim().toLowerCase().replace(/\s+/g, "_");
    const { error } = await supabase.from("payment_methods").insert({
      store_id: storeId,
      name: name.trim(),
      code: finalCode,
      is_cash: isCash,
      is_cod: isCod,
      sort_order: methods.length + 1,
    });
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    setShowForm(false);
    await loadMethods();
  }

  async function toggleActive(m: PaymentMethod) {
    await supabase.from("payment_methods").update({ is_active: !m.is_active }).eq("id", m.id);
    await loadMethods();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this payment method?")) return;
    await supabase.from("payment_methods").delete().eq("id", id);
    await loadMethods();
  }

  return (
    <div className="pt-4 max-w-2xl">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("admin_paymentMethods_title")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("admin_addMethod")}
        </button>
      </div>

      <select
        className="w-full sm:w-60 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
      >
        {STORES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("admin_methodName")}</th>
              <th className="text-left px-4 py-2">{t("admin_methodCode")}</th>
              <th className="text-left px-4 py-2">{t("admin_isCash")}</th>
              <th className="text-left px-4 py-2">{t("admin_isCod")}</th>
              <th className="text-left px-4 py-2">{t("admin_active")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{m.name}</td>
                <td className="px-4 py-2 text-slate-400">{m.code}</td>
                <td className="px-4 py-2">{m.is_cash ? "✅" : "-"}</td>
                <td className="px-4 py-2">{m.is_cod ? "✅" : "-"}</td>
                <td className="px-4 py-2">
                  <button onClick={() => toggleActive(m)}>
                    {m.is_active ? "🟢" : "⚪"}
                  </button>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => handleDelete(m.id)} className="text-red-600 text-xs font-medium">
                    {t("admin_delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleAdd} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("admin_addMethod")}</h3>

            <label className="text-sm text-slate-600">{t("admin_methodName")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <label className="text-sm text-slate-600">{t("admin_methodCode")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="auto"
            />

            <label className="flex items-center gap-2 text-sm mb-2">
              <input type="checkbox" checked={isCash} onChange={(e) => setIsCash(e.target.checked)} />
              {t("admin_isCash")}
            </label>
            <label className="flex items-center gap-2 text-sm mb-4">
              <input type="checkbox" checked={isCod} onChange={(e) => setIsCod(e.target.checked)} />
              {t("admin_isCod")}
            </label>

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
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold"
              >
                {t("admin_save")}
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
