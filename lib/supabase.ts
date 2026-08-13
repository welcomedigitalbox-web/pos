import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Product = {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  stock_qty: number;
  store_id: string;
  avg_cost: number;
  previous_avg_cost: number;
  last_purchase_cost: number;
  category_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  date_of_birth: string | null;
  delivery_address: string | null;
  facebook: string | null;
  tiktok: string | null;
  loyalty_tier_id: string | null;
  store_id: string;
  created_at: string;
};

export type Sale = {
  id: string;
  sale_ref: string | null;
  store_id: string;
  cashier: string | null;
  total: number;
  payment_method: "cash" | "card" | "bank_transfer" | "cod";
  subtotal: number;
  discount_type: "percent" | "flat";
  discount_value: number;
  discount_amount: number;
  vat_percent: number;
  vat_amount: number;
  amount_received: number;
  change_amount: number;
  advance_payment: number;
  balance_due: number;
  note: string | null;
  customer_id: string | null;
  customer_name: string | null;
  cashier_email: string | null;
  created_at: string;
};

export type SaleItem = {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
};

export type StockBatch = {
  id: string;
  product_id: string;
  store_id: string;
  supplier: string | null;
  qty: number;
  unit_cost: number;
  total_cost: number;
  new_avg_cost: number;
  expiry_date: string | null;
  remaining_qty: number;
  created_at: string;
};

export type PaymentMethodRow = {
  id: string;
  store_id: string;
  name: string;
  code: string;
  is_cash: boolean;
  is_cod: boolean;
  is_active: boolean;
  sort_order: number;
};

export type StoreSettings = {
  store_id: string;
  business_name: string | null;
  phone: string | null;
  address: string | null;
  receipt_footer: string | null;
  logo_text: string | null;
};

export type StoreRow = {
  id: string;
  name: string;
  created_at: string;
};

export type LoyaltyTier = {
  id: string;
  store_id: string;
  name: string;
  discount_percent: number;
  sort_order: number;
  created_at: string;
};

export type StoreInventory = {
  id: string;
  store_id: string;
  product_id: string;
  stock_qty: number;
  avg_cost: number;
  previous_avg_cost: number;
  last_purchase_cost: number;
  updated_at: string;
};

// Merges the global product catalog with a specific store's stock/cost data.
// Returns the SAME shape the app always used (Product + stock_qty/avg_cost/etc),
// so existing UI code barely has to change.
export async function fetchProductsWithStock(storeId: string): Promise<Product[]> {
  const { data: products } = await supabase.from("products").select("*").order("name");
  const { data: inv } = await supabase.from("store_inventory").select("*").eq("store_id", storeId);
  const invMap = new Map((inv || []).map((i) => [i.product_id, i]));
  return (products || []).map((p) => {
    const i = invMap.get(p.id);
    return {
      ...p,
      stock_qty: i?.stock_qty ?? 0,
      avg_cost: i?.avg_cost ?? 0,
      previous_avg_cost: i?.previous_avg_cost ?? 0,
      last_purchase_cost: i?.last_purchase_cost ?? 0,
    } as Product;
  });
}

export async function fetchProductWithStock(productId: string, storeId: string): Promise<Product | null> {
  const { data: p } = await supabase.from("products").select("*").eq("id", productId).maybeSingle();
  if (!p) return null;
  const { data: i } = await supabase
    .from("store_inventory")
    .select("*")
    .eq("product_id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  return {
    ...p,
    stock_qty: i?.stock_qty ?? 0,
    avg_cost: i?.avg_cost ?? 0,
    previous_avg_cost: i?.previous_avg_cost ?? 0,
    last_purchase_cost: i?.last_purchase_cost ?? 0,
  } as Product;
}

// Creates or updates a store's stock/cost row for a product. Any field left out keeps its current value.
export async function upsertStoreInventory(
  storeId: string,
  productId: string,
  fields: Partial<Pick<StoreInventory, "stock_qty" | "avg_cost" | "previous_avg_cost" | "last_purchase_cost">>
) {
  const { data: existing } = await supabase
    .from("store_inventory")
    .select("*")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .maybeSingle();

  const merged = {
    store_id: storeId,
    product_id: productId,
    stock_qty: fields.stock_qty ?? existing?.stock_qty ?? 0,
    avg_cost: fields.avg_cost ?? existing?.avg_cost ?? 0,
    previous_avg_cost: fields.previous_avg_cost ?? existing?.previous_avg_cost ?? 0,
    last_purchase_cost: fields.last_purchase_cost ?? existing?.last_purchase_cost ?? 0,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await supabase.from("store_inventory").update(merged).eq("id", existing.id);
  } else {
    await supabase.from("store_inventory").insert(merged);
  }
}

export type ProductCategory = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
};

export type ProductVariant = {
  id: string;
  product_id: string;
  variant_name: string;
  sku: string | null;
  price_override: number | null;
  created_at: string;
};
