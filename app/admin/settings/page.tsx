"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useStore } from "../../store-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../../language-context";



type StoreSettings = {
  store_id: string;
  business_name: string | null;
  phone: string | null;
  address: string | null;
  receipt_footer: string | null;
  logo_text: string | null;
};

export default function AdminSettingsPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();
  const router = useRouter();

  const [storeId, setStoreId] = useState("");
  const [settings, setSettings] = useState<StoreSettings>({
    store_id: "",
    business_name: "",
    phone: "",
    address: "",
    receipt_footer: "",
    logo_text: "",
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && profile.role !== "admin") router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (stores.length > 0 && !storeId) setStoreId(stores[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores]);

  useEffect(() => {
    if (storeId) loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || profile.role !== "admin") return null;

  async function loadSettings() {
    const { data } = await supabase.from("store_settings").select("*").eq("store_id", storeId).maybeSingle();
    if (data) {
      setSettings(data);
    } else {
      setSettings({
        store_id: storeId,
        business_name: "",
        phone: "",
        address: "",
        receipt_footer: "",
        logo_text: "",
      });
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { error } = await supabase
        .from("store_settings")
        .upsert({ ...settings, store_id: storeId, updated_at: new Date().toISOString() });
      if (error) throw error;
      showToast(t("admin_settingsSaved"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4 max-w-lg">
      <h2 className="font-semibold text-lg mb-3">{t("admin_settings_title")}</h2>

      <select
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div>
          <label className="text-sm text-slate-600">{t("admin_businessName")}</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            value={settings.business_name || ""}
            onChange={(e) => setSettings({ ...settings, business_name: e.target.value })}
            placeholder={storeId}
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">{t("admin_phone")}</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            value={settings.phone || ""}
            onChange={(e) => setSettings({ ...settings, phone: e.target.value })}
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">{t("admin_address")}</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            value={settings.address || ""}
            onChange={(e) => setSettings({ ...settings, address: e.target.value })}
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">{t("admin_logoText")}</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            value={settings.logo_text || ""}
            onChange={(e) => setSettings({ ...settings, logo_text: e.target.value })}
            placeholder="🛒"
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">{t("admin_receiptFooter")}</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
            rows={2}
            value={settings.receipt_footer || ""}
            onChange={(e) => setSettings({ ...settings, receipt_footer: e.target.value })}
            placeholder="Thank you!"
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
        >
          {saving ? "..." : t("admin_save")}
        </button>
      </form>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
