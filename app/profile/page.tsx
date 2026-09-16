"use client";

import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

export default function ProfilePage() {
  const { profile, signOut } = useAuth();
  const { storeId, stores, isStoreLocked } = useStore();
  const { lang, setLang, t } = useLanguage();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg("");

    if (next.length < 8) {
      setPwMsg(t("profile_pwTooShort"));
      return;
    }
    if (next !== confirm) {
      setPwMsg(t("profile_pwMismatch"));
      return;
    }

    setPwBusy(true);
    // Asking for the current password first: a signed-in till left open on the
    // shop floor shouldn't be enough to lock the owner out of their account.
    const { error: wrong } = await supabase.auth.signInWithPassword({
      email: profile!.email,
      password: current,
    });
    if (wrong) {
      setPwBusy(false);
      setPwMsg(t("profile_pwWrongCurrent"));
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: next });
    setPwBusy(false);
    if (error) {
      setPwMsg(error.message);
      return;
    }
    setCurrent(""); setNext(""); setConfirm("");
    setPwMsg(t("profile_pwChanged"));
  }

  if (!profile) return null;

  const canUsePin = profile.role === "sale_manager" || profile.role === "owner" || profile.role === "admin";

  return (
    <div className="pt-4 max-w-md">
      <h2 className="font-semibold text-lg mb-4">{t("dept_profile")}</h2>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 space-y-3">
        <div>
          <div className="text-xs text-slate-400 uppercase">{t("admin_email")}</div>
          <div className="text-sm mt-1">{profile.email}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 uppercase">{t("admin_role")}</div>
          <div className="text-sm mt-1 capitalize">{profile.role}</div>
        </div>
        {isStoreLocked && (
          <div>
            <div className="text-xs text-slate-400 uppercase">{t("admin_store")}</div>
            <div className="text-sm mt-1">🔒 {stores.find((s) => s.id === storeId)?.name || storeId}</div>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
        <div className="text-xs text-slate-400 uppercase mb-2">{t("profile_language")}</div>
        <div className="flex border border-slate-200 rounded-lg overflow-hidden text-sm w-fit">
          <button
            onClick={() => setLang("my")}
            className={`px-4 py-2 ${lang === "my" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
          >
            မြန်မာ
          </button>
          <button
            onClick={() => setLang("en")}
            className={`px-4 py-2 ${lang === "en" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
          >
            EN
          </button>
        </div>
      </div>

      {canUsePin && hasPermission(profile, "my-pin") && (
        <Link
          href="/my-pin"
          className="block bg-white border border-slate-200 rounded-xl p-4 mb-4 text-sm font-medium text-blue-600"
        >
          🔑 {t("nav_myPin")} →
        </Link>
      )}

      <form onSubmit={changePassword} className="bg-white border border-slate-200 rounded-xl p-4 mb-4 space-y-3">
        <div className="text-xs text-slate-400 uppercase">{t("profile_changePw")}</div>

        <input
          type="password"
          autoComplete="current-password"
          placeholder={t("profile_currentPw")}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t("profile_newPw")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t("profile_confirmPw")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          required
        />

        {pwMsg && <p className="text-xs text-slate-600">{pwMsg}</p>}

        <button
          type="submit"
          disabled={pwBusy}
          className="w-full py-2 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
        >
          {pwBusy ? t("profile_pwSaving") : t("profile_changePw")}
        </button>
      </form>

      <button
        onClick={signOut}
        className="w-full py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-semibold"
      >
        {t("logout")}
      </button>
    </div>
  );
}
