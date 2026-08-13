"use client";

import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";

export default function AiAgentPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();

  if (!profile) return null;

  return (
    <div className="pt-4 max-w-lg">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
        <div className="text-5xl mb-3">🤖</div>
        <h2 className="font-semibold text-lg mb-2">{t("aiAgent_title")}</h2>
        <p className="text-sm text-slate-500">{t("aiAgent_comingSoon")}</p>
      </div>
    </div>
  );
}
