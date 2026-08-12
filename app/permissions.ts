export type PageKey =
  | "pos"
  | "history"
  | "my-sales"
  | "products"
  | "stock-in"
  | "barcode"
  | "ledger"
  | "warehouse"
  | "dashboard"
  | "admin";

export type UserRole =
  | "cashier"
  | "online_sale"
  | "wholesale"
  | "sale_manager"
  | "manager"
  | "owner"
  | "admin";

export const PAGE_OPTIONS: { key: PageKey; href: string; labelKey: string }[] = [
  { key: "pos", href: "/", labelKey: "nav_pos" },
  { key: "history", href: "/history", labelKey: "nav_history" },
  { key: "my-sales", href: "/my-sales", labelKey: "nav_mySales" },
  { key: "products", href: "/products", labelKey: "nav_products" },
  { key: "stock-in", href: "/stock-in", labelKey: "nav_stockIn" },
  { key: "barcode", href: "/barcode", labelKey: "nav_barcode" },
  { key: "ledger", href: "/ledger", labelKey: "nav_ledger" },
  { key: "warehouse", href: "/warehouse", labelKey: "nav_warehouse" },
  { key: "dashboard", href: "/dashboard", labelKey: "nav_dashboard" },
];

const ALL_KEYS_EXCEPT_ADMIN: PageKey[] = PAGE_OPTIONS.map((p) => p.key);
const ALL_KEYS: PageKey[] = [...ALL_KEYS_EXCEPT_ADMIN, "admin"];

export const DEFAULT_PERMISSIONS: Record<Exclude<UserRole, "admin">, PageKey[]> = {
  cashier: ["pos", "history", "my-sales"],
  online_sale: ["pos", "history", "my-sales"],
  wholesale: ["pos", "history", "my-sales"],
  sale_manager: ["pos", "history", "my-sales", "products", "stock-in", "barcode", "ledger", "warehouse", "dashboard"],
  manager: ["pos", "history", "products", "stock-in", "barcode", "ledger", "warehouse", "dashboard"],
  owner: ALL_KEYS_EXCEPT_ADMIN.concat(["my-sales"]).filter((v, i, a) => a.indexOf(v) === i),
};

export const ROLE_OPTIONS: UserRole[] = [
  "cashier",
  "online_sale",
  "wholesale",
  "sale_manager",
  "manager",
  "owner",
  "admin",
];

export function hasPermission(
  profile: { role: string; permissions: string[] } | null,
  key: PageKey
): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  return profile.permissions?.includes(key) ?? false;
}
