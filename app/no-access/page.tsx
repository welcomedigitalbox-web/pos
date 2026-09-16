"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

// Where the other apps send someone who is signed in but whose department has
// no business in them. It has to be a real page — without it those redirects
// land on a 404 and look like the sign-in broke.
function NoAccessBody() {
  const app = useSearchParams().get("app") || "";

  const names: Record<string, string> = {
    report: "Daily Reports",
    finance: "Finance",
    onlineorder: "Online Order",
    pos: "POS",
  };

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 p-4">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-sm text-center shadow-sm">
        <h1 className="text-lg font-semibold mb-2">ဝင်ရောက်ခွင့် မရှိပါ</h1>
        <p className="text-sm text-slate-500 mb-6">
          {names[app] ? `${names[app]} ကို ` : ""}
          ဝင်ရောက်ခွင့် မရှိပါ။ လိုအပ်ပါက HR သို့မဟုတ် admin ထံ ဆက်သွယ်ပါ။
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold"
        >
          POS သို့ ပြန်သွားရန်
        </Link>
      </div>
    </div>
  );
}

export default function NoAccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <NoAccessBody />
    </Suspense>
  );
}
