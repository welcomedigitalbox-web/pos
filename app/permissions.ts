export type PageKey =
  | "pos"
  | "history"
  | "products"
  | "stock-in"
  | "barcode"
  | "ledger"
  | "warehouse"
  | "dashboard"
  | "admin";

export const PAGE_OPTIONS: { key: PageKey; href: string; labelKey: string }[] = [
  { key: "pos", href: "/", labelKey: "nav_pos" },
  { key: "history", href: "/history", labelKey: "nav_history" },
  { key: "products", href: "/products", labelKey: "nav_products" },
  { key: "stock-in", href: "/stock-in", labelKey: "nav_stockIn" },
  { key: "barcode", href: "/barcode", labelKey: "nav_barcode" },
  { key: "ledger", href: "/ledger", labelKey: "nav_ledger" },
  { key: "warehouse", href: "/warehouse", labelKey: "nav_warehouse" },
  { key: "dashboard", href: "/dashboard", labelKey: "nav_dashboard" },
];

export const DEFAULT_PERMISSIONS: Record<"cashier" | "manager", PageKey[]> = {
  cashier: ["pos", "history"],
  manager: ["pos", "history", "products", "stock-in", "barcode", "ledger", "warehouse", "dashboard"],
};

export function hasPermission(
  profile: { role: string; permissions: string[] } | null,
  key: PageKey
): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  return profile.permissions?.includes(key) ?? false;
}
