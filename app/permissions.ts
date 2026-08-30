export type PageKey =
  | "pos"
  | "sale-order"
  | "history"
  | "order-lookup"
  | "returns"
  | "cash-drawer"
  | "customers"
  | "sales-reps"
  | "loyalty-tiers"
  | "products"
  | "inventory"
  | "stock-in"
  | "stock-request"
  | "damage"
  | "incoming-transfers"
  | "barcode"
  | "ledger"
  | "sales-performance"
  | "warehouse"
  | "stock-transfer"
  | "request-approval"
  | "request-inbox"
  | "goods-received"
  | "warehouse-history"
  | "dashboard"
  | "sales-report"
  | "campaigns"
  | "settlements"
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
  { key: "order-lookup", href: "/order-lookup", labelKey: "nav_orderLookup", group: "sale" },
  { key: "returns", href: "/returns", labelKey: "nav_returns", group: "sale" },
  { key: "cash-drawer", href: "/cash-drawer", labelKey: "nav_cashDrawer", group: "sale" },
  { key: "customers", href: "/customers", labelKey: "nav_customers", group: "sale" },
  { key: "sales-reps", href: "/sales-reps", labelKey: "nav_salesReps", group: "sale" },
  { key: "loyalty-tiers", href: "/loyalty-tiers", labelKey: "nav_loyaltyTiers", group: "sale" },
  { key: "sales-performance", href: "/ledger", labelKey: "nav_salesPerformance", group: "sale" },
  { key: "products", href: "/products", labelKey: "nav_products", group: "merchandising" },
  { key: "inventory", href: "/inventory", labelKey: "nav_inventory", group: "inventory" },
  { key: "stock-in", href: "/stock-in", labelKey: "nav_stockIn", group: "inventory" },
  { key: "stock-request", href: "/stock-request", labelKey: "nav_stockRequest", group: "inventory" },
  { key: "damage", href: "/damage", labelKey: "nav_damage", group: "inventory" },
  { key: "incoming-transfers", href: "/incoming-transfers", labelKey: "nav_incomingTransfers", group: "inventory" },
  { key: "barcode", href: "/barcode", labelKey: "nav_barcode", group: "inventory" },
  { key: "warehouse", href: "/warehouse", labelKey: "nav_warehouse", group: "warehouse" },
  { key: "goods-received", href: "/goods-received", labelKey: "nav_goodsReceived", group: "warehouse" },
  { key: "request-approval", href: "/request-approval", labelKey: "nav_requestApproval", group: "sale" },
  { key: "request-inbox", href: "/request-inbox", labelKey: "nav_requestInbox", group: "warehouse" },
  { key: "stock-transfer", href: "/stock-transfer", labelKey: "nav_stockTransfer", group: "warehouse" },
  { key: "warehouse-history", href: "/warehouse-history", labelKey: "nav_warehouseHistory", group: "warehouse" },
  { key: "ledger", href: "/ledger", labelKey: "nav_ledger", group: "warehouse" },
  { key: "product-category", href: "/product-category", labelKey: "nav_productCategory", group: "merchandising" },
  { key: "product-variant", href: "/product-variant", labelKey: "nav_productVariant", group: "merchandising" },
  { key: "purchase-orders", href: "/purchase-orders", labelKey: "nav_purchaseOrders", group: "merchandising" },
  { key: "suppliers", href: "/suppliers", labelKey: "nav_suppliers", group: "merchandising" },
  { key: "dashboard", href: "/dashboard", labelKey: "nav_dashboard", group: "reports" },
  { key: "sales-report", href: "/sales-report", labelKey: "nav_salesReport", group: "reports" },
  { key: "campaigns", href: "/campaigns", labelKey: "nav_campaigns", group: "reports" },
  { key: "settlements", href: "/settlements", labelKey: "nav_settlements", group: "reports" },
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

// Built from PAGE_OPTIONS groups rather than hand-listed keys: a new page
// lands in the right roles automatically, and "sale manager gets everything
// on the sale side" stays true instead of drifting as pages are added.
function pagesIn(...groups: PageGroup[]): PageKey[] {
  return PAGE_OPTIONS.filter((p) => groups.includes(p.group)).map((p) => p.key);
}

export const DEFAULT_PERMISSIONS: Record<Exclude<UserRole, "admin">, PageKey[]> = {
  // Tills work one screen at a time, so these stay an explicit short list.
  cashier: [
    "pos", "history", "returns", "cash-drawer", "customers",
    "inventory", "stock-request", "incoming-transfers", "damage",
    "barcode", "sales-performance",
    ...COMMON_ALL_ROLES,
  ],
  online_sale: [
    "sale-order", "history", "order-lookup", "customers",
    "inventory", "warehouse", "sales-performance",
    ...COMMON_ALL_ROLES,
  ],
  wholesale: [
    "sale-order", "history", "customers", "inventory", "sales-performance",
    ...COMMON_ALL_ROLES,
  ],

  // Whole-department roles: everything in their own area, plus reports.
  sale_manager: [...pagesIn("sale", "reports"), ...COMMON_ALL_ROLES],
  manager: [
    ...pagesIn("sale", "inventory", "warehouse", "merchandising", "reports"),
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
