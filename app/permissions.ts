export type PageKey =
  | "pos"
  | "sale-order"
  | "history"
  | "my-sales"
  | "customers"
  | "sales-reps"
  | "loyalty-tiers"
  | "products"
  | "stock-in"
  | "stock-request"
  | "damage"
  | "incoming-transfers"
  | "barcode"
  | "ledger"
  | "warehouse"
  | "stock-transfer"
  | "goods-received"
  | "warehouse-history"
  | "dashboard"
  | "sales-report"
  | "my-pin"
  | "product-category"
  | "product-variant"
  | "suppliers"
  | "purchase-orders"
  | "ai-agent"
  | "profile"
  | "admin";

export type UserRole =
  | "cashier"
  | "online_sale"
  | "wholesale"
  | "sale_manager"
  | "manager"
  | "owner"
  | "admin";

export type PageGroup = "sale" | "inventory" | "warehouse" | "merchandising" | "reports" | "ai-agent" | "profile";

export const PAGE_OPTIONS: { key: PageKey; href: string; labelKey: string; group: PageGroup }[] = [
  { key: "pos", href: "/", labelKey: "nav_pos", group: "sale" },
  { key: "sale-order", href: "/sale-order", labelKey: "nav_saleOrder", group: "sale" },
  { key: "history", href: "/history", labelKey: "nav_history", group: "sale" },
  { key: "my-sales", href: "/my-sales", labelKey: "nav_mySales", group: "sale" },
  { key: "customers", href: "/customers", labelKey: "nav_customers", group: "sale" },
  { key: "sales-reps", href: "/sales-reps", labelKey: "nav_salesReps", group: "sale" },
  { key: "loyalty-tiers", href: "/loyalty-tiers", labelKey: "nav_loyaltyTiers", group: "sale" },
  { key: "products", href: "/products", labelKey: "nav_products", group: "merchandising" },
  { key: "stock-in", href: "/stock-in", labelKey: "nav_stockIn", group: "inventory" },
  { key: "stock-request", href: "/stock-request", labelKey: "nav_stockRequest", group: "inventory" },
  { key: "damage", href: "/damage", labelKey: "nav_damage", group: "inventory" },
  { key: "incoming-transfers", href: "/incoming-transfers", labelKey: "nav_incomingTransfers", group: "inventory" },
  { key: "barcode", href: "/barcode", labelKey: "nav_barcode", group: "inventory" },
  { key: "warehouse", href: "/warehouse", labelKey: "nav_warehouse", group: "warehouse" },
  { key: "goods-received", href: "/goods-received", labelKey: "nav_goodsReceived", group: "warehouse" },
  { key: "stock-transfer", href: "/stock-transfer", labelKey: "nav_stockTransfer", group: "warehouse" },
  { key: "warehouse-history", href: "/warehouse-history", labelKey: "nav_warehouseHistory", group: "warehouse" },
  { key: "ledger", href: "/ledger", labelKey: "nav_ledger", group: "warehouse" },
  { key: "product-category", href: "/product-category", labelKey: "nav_productCategory", group: "merchandising" },
  { key: "product-variant", href: "/product-variant", labelKey: "nav_productVariant", group: "merchandising" },
  { key: "purchase-orders", href: "/purchase-orders", labelKey: "nav_purchaseOrders", group: "merchandising" },
  { key: "suppliers", href: "/suppliers", labelKey: "nav_suppliers", group: "merchandising" },
  { key: "dashboard", href: "/dashboard", labelKey: "nav_dashboard", group: "reports" },
  { key: "sales-report", href: "/sales-report", labelKey: "nav_salesReport", group: "reports" },
  { key: "my-pin", href: "/my-pin", labelKey: "nav_myPin", group: "reports" },
  { key: "ai-agent", href: "/ai-agent", labelKey: "nav_aiAgent", group: "ai-agent" },
  { key: "profile", href: "/profile", labelKey: "nav_profile", group: "profile" },
];

export const GROUP_LABELS: Record<PageGroup, string> = {
  sale: "dept_sale",
  inventory: "dept_inventory",
  warehouse: "dept_warehouse",
  merchandising: "dept_merchandising",
  reports: "dept_reports",
  "ai-agent": "dept_aiAgent",
  profile: "dept_profile",
};

const ALL_KEYS_EXCEPT_ADMIN: PageKey[] = PAGE_OPTIONS.map((p) => p.key);
const ALL_KEYS: PageKey[] = [...ALL_KEYS_EXCEPT_ADMIN, "admin"];

const COMMON_ALL_ROLES: PageKey[] = ["ai-agent", "profile"];

export const DEFAULT_PERMISSIONS: Record<Exclude<UserRole, "admin">, PageKey[]> = {
  cashier: ["pos", "history", "my-sales", "customers", ...COMMON_ALL_ROLES],
  online_sale: ["sale-order", "history", "my-sales", "customers", ...COMMON_ALL_ROLES],
  wholesale: ["sale-order", "history", "my-sales", "customers", ...COMMON_ALL_ROLES],
  sale_manager: [
    "pos",
    "sale-order",
    "history",
    "my-sales",
    "customers",
    "sales-reps",
    "loyalty-tiers",
    "products",
    "stock-in",
    "stock-request",
    "damage",
    "incoming-transfers",
    "barcode",
    "ledger",
    "warehouse",
    "stock-transfer",
    "goods-received",
    "warehouse-history",
    "dashboard",
    "sales-report",
    "my-pin",
    "product-category",
    "product-variant",
    "purchase-orders",
    "suppliers",
    ...COMMON_ALL_ROLES,
  ],
  manager: [
    "pos",
    "history",
    "customers",
    "sales-reps",
    "products",
    "stock-in",
    "stock-request",
    "damage",
    "incoming-transfers",
    "barcode",
    "ledger",
    "warehouse",
    "stock-transfer",
    "goods-received",
    "warehouse-history",
    "dashboard",
    "product-category",
    "product-variant",
    "purchase-orders",
    "suppliers",
    ...COMMON_ALL_ROLES,
  ],
  owner: ALL_KEYS_EXCEPT_ADMIN,
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
