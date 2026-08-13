"use client";

import { useEffect, useState } from "react";
import { supabase, Customer } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type FormState = {
  id: string | null;
  name: string;
  phone: string;
  email: string;
  date_of_birth: string;
  delivery_address: string;
  facebook: string;
  tiktok: string;
};

const emptyForm: FormState = {
  id: null,
  name: "",
  phone: "",
  email: "",
  date_of_birth: "",
  delivery_address: "",
  facebook: "",
  tiktok: "",
};

export default function CustomersPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "customers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "customers")) return null;

  async function load() {
    const { data } = await supabase.from("customers").select("*").eq("store_id", storeId).order("name");
    setCustomers(data || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(c: Customer) {
    setForm({
      id: c.id,
      name: c.name,
      phone: c.phone || "",
      email: c.email || "",
      date_of_birth: c.date_of_birth || "",
      delivery_address: c.delivery_address || "",
      facebook: c.facebook || "",
      tiktok: c.tiktok || "",
    });
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return showToast(t("customers_nameRequired"));

    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      date_of_birth: form.date_of_birth || null,
      delivery_address: form.delivery_address.trim() || null,
      facebook: form.facebook.trim() || null,
      tiktok: form.tiktok.trim() || null,
      store_id: storeId,
    };

    setSaving(true);
    try {
      if (form.id) {
        const { error } = await supabase.from("customers").update(payload).eq("id", form.id);
        if (error) throw error;
        showToast(t("customers_updated"));
      } else {
        const { error } = await supabase.from("customers").insert(payload);
        if (error) throw error;
        showToast(t("customers_created"));
      }
      setShowForm(false);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("customers_deleteConfirm"))) return;
    const { error } = await supabase.from("customers").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("customers_deleted"));
    await load();
  }

  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.phone || "").includes(search) ||
      (c.email || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("nav_customers")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("customers_addNew")}
        </button>
      </div>

      <input
        className="w-full sm:w-80 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        placeholder={t("pos_customerSearchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[750px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2">{t("pos_customerPhone")}</th>
              <th className="text-left px-4 py-2">{t("customers_email")}</th>
              <th className="text-left px-4 py-2">{t("customers_dob")}</th>
              <th className="text-left px-4 py-2">{t("saleOrder_deliveryAddress")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{c.name}</td>
                <td className="px-4 py-2 text-slate-400">{c.phone || "-"}</td>
                <td className="px-4 py-2 text-slate-400">{c.email || "-"}</td>
                <td className="px-4 py-2 text-slate-400">{c.date_of_birth || "-"}</td>
                <td className="px-4 py-2 text-slate-400 max-w-[180px] truncate">{c.delivery_address || "-"}</td>
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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={handleSave} className="bg-white rounded-2xl p-6 w-full max-w-md shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">
              {form.id ? t("customers_editTitle") : t("customers_addNew")}
            </h3>

            <label className="text-sm text-slate-600">{t("customers_name")} *</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("pos_customerPhone")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />

            <label className="text-sm text-slate-600">{t("customers_email")}</label>
            <input
              type="email"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />

            <label className="text-sm text-slate-600">{t("customers_dob")}</label>
            <input
              type="date"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
            />

            <label className="text-sm text-slate-600">{t("saleOrder_deliveryAddress")}</label>
            <textarea
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              rows={2}
              value={form.delivery_address}
              onChange={(e) => setForm({ ...form, delivery_address: e.target.value })}
            />

            <label className="text-sm text-slate-600">{t("customers_facebook")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.facebook}
              onChange={(e) => setForm({ ...form, facebook: e.target.value })}
              placeholder="facebook.com/..."
            />

            <label className="text-sm text-slate-600">{t("customers_tiktok")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={form.tiktok}
              onChange={(e) => setForm({ ...form, tiktok: e.target.value })}
              placeholder="@username"
            />

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
