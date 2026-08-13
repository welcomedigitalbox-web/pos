"use client";

import Link from "next/link";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

export default function ProfilePage() {
  const { profile, signOut } = useAuth();
  const { storeId, stores, isStoreLocked } = useStore();
  const { lang, setLang, t } = useLanguage();

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

      <button
        onClick={signOut}
        className="w-full py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-semibold"
      >
        {t("logout")}
      </button>
    </div>
  );
}
