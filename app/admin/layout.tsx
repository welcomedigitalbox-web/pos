"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "../language-context";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useLanguage();

  const tabs = [
    { href: "/admin/users", label: t("admin_users_title") },
    { href: "/admin/stores", label: t("admin_stores_title") },
    { href: "/admin/settings", label: t("admin_settings_title") },
    { href: "/admin/payment-methods", label: t("admin_paymentMethods_title") },
  ];

  return (
    <div>
      <div className="flex gap-1 border-b border-slate-200 mb-2 overflow-x-auto">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-2 text-sm whitespace-nowrap ${
              pathname === tab.href ? "text-blue-600 font-semibold border-b-2 border-blue-600" : "text-slate-500"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
