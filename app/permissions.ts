export type PageKey =
  | "pos"
  | "sale-order"
  | "history"
  | "my-sales"
  | "products"
  | "stock-in"
  | "stock-request"
  | "damage"
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

export type PageGroup = "sale" | "inventory" | "reports";

export const PAGE_OPTIONS: { key: PageKey; href: string; labelKey: string; group: PageGroup }[] = [
  { key: "pos", href: "/", labelKey: "nav_pos", group: "sale" },
  { key: "sale-order", href: "/sale-order", labelKey: "nav_saleOrder", group: "sale" },
  { key: "history", href: "/history", labelKey: "nav_history", group: "sale" },
  { key: "my-sales", href: "/my-sales", labelKey: "nav_mySales", group: "sale" },
  { key: "products", href: "/products", labelKey: "nav_products", group: "inventory" },
  { key: "stock-in", href: "/stock-in", labelKey: "nav_stockIn", group: "inventory" },
  { key: "stock-request", href: "/stock-request", labelKey: "nav_stockRequest", group: "inventory" },
  { key: "damage", href: "/damage", labelKey: "nav_damage", group: "inventory" },
  { key: "barcode", href: "/barcode", labelKey: "nav_barcode", group: "inventory" },
  { key: "ledger", href: "/ledger", labelKey: "nav_ledger", group: "inventory" },
  { key: "warehouse", href: "/warehouse", labelKey: "nav_warehouse", group: "inventory" },
  { key: "dashboard", href: "/dashboard", labelKey: "nav_dashboard", group: "reports" },
];

export const GROUP_LABELS: Record<PageGroup, string> = {
  sale: "nav_group_sale",
  inventory: "nav_group_inventory",
  reports: "nav_group_reports",
};

const ALL_KEYS_EXCEPT_ADMIN: PageKey[] = PAGE_OPTIONS.map((p) => p.key);
const ALL_KEYS: PageKey[] = [...ALL_KEYS_EXCEPT_ADMIN, "admin"];

export const DEFAULT_PERMISSIONS: Record<Exclude<UserRole, "admin">, PageKey[]> = {
  cashier: ["pos", "history", "my-sales"],
  online_sale: ["sale-order", "history", "my-sales"],
  wholesale: ["sale-order", "history", "my-sales"],
  sale_manager: [
    "pos",
    "sale-order",
    "history",
    "my-sales",
    "products",
    "stock-in",
    "stock-request",
    "damage",
    "barcode",
    "ledger",
    "warehouse",
    "dashboard",
  ],
  manager: [
    "pos",
    "history",
    "products",
    "stock-in",
    "stock-request",
    "damage",
    "barcode",
    "ledger",
    "warehouse",
    "dashboard",
  ],
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
