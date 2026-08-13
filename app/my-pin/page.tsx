"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

const APPROVER_ROLES = ["sale_manager", "owner", "admin"];

export default function MyPinPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !APPROVER_ROLES.includes(profile.role)) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (profile) loadCurrentPin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || !APPROVER_ROLES.includes(profile.role)) return null;

  async function loadCurrentPin() {
    const { data } = await supabase.from("profiles").select("approval_pin").eq("id", profile!.id).single();
    setCurrentPin(data?.approval_pin || null);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) return showToast(t("myPin_invalidFormat"));
    if (pin !== confirmPin) return showToast(t("myPin_mismatch"));

    setSaving(true);
    try {
      const { error } = await supabase.from("profiles").update({ approval_pin: pin }).eq("id", profile!.id);
      if (error) throw error;
      showToast(t("myPin_saved"));
      setPin("");
      setConfirmPin("");
      await loadCurrentPin();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4 max-w-sm">
      <h2 className="font-semibold text-lg mb-1">{t("myPin_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("myPin_subtitle")}</p>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
        <div className="text-xs text-slate-400 uppercase mb-1">{t("myPin_currentStatus")}</div>
        <div className="text-sm font-medium">
          {currentPin ? `🔒 ${t("myPin_isSet")}` : `⚪ ${t("myPin_notSet")}`}
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-4">
        <label className="text-sm text-slate-600">{t("myPin_newPin")}</label>
        <input
          type="password"
          inputMode="numeric"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="4-6 digit PIN"
          maxLength={6}
        />

        <label className="text-sm text-slate-600">{t("myPin_confirmPin")}</label>
        <input
          type="password"
          inputMode="numeric"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
          placeholder="4-6 digit PIN"
          maxLength={6}
        />

        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
        >
          {saving ? "..." : t("myPin_save")}
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
