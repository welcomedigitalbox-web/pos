"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

// Must match public.is_approver_role() in the database.
const APPROVER_ROLES = ["admin", "owner", "manager"];

export default function MyPinPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !APPROVER_ROLES.includes(profile.role)) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (profile) loadPinStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || !APPROVER_ROLES.includes(profile.role)) return null;

  // The PIN itself is never sent to the browser — only whether one is set.
  async function loadPinStatus() {
    const { data, error } = await supabase.rpc("my_approval_pin_status");
    if (error) {
      setHasPin(null);
      return;
    }
    setHasPin(Boolean(data?.[0]?.has_pin));
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
      // Hashing happens server side; the plaintext PIN is never stored.
      const { error } = await supabase.rpc("set_my_approval_pin", { p_pin: pin });
      if (error) throw error;
      showToast(t("myPin_saved"));
      setPin("");
      setConfirmPin("");
      await loadPinStatus();
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
          {hasPin === null
            ? "…"
            : hasPin
              ? `🔒 ${t("myPin_isSet")}`
              : `⚪ ${t("myPin_notSet")}`}
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-4">
        <label className="text-sm text-slate-600">{t("myPin_newPin")}</label>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
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
          autoComplete="new-password"
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
