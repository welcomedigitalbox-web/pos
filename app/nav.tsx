"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "./store-context";

const STORES = ["SR-BAK", "SR-MDY", "SR-NOKL", "SR-WZYD"];

export default function Nav() {
  const pathname = usePathname();
  const { storeId, setStoreId } = useStore();

  const tabs = [
    { href: "/", label: "POS" },
    { href: "/history", label: "Sale History" },
    { href: "/dashboard", label: "Dashboard" },
  ];

  return (
    <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <h1 className="font-semibold text-lg">🛒 POS MVP</h1>
        <select
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          {STORES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="max-w-6xl mx-auto px-4 flex gap-1">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 text-sm rounded-t-lg ${
              pathname === t.href
                ? "bg-slate-50 text-blue-600 font-semibold"
                : "text-slate-500"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
