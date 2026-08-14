import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Product = {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  store_id: string;
  category_id: string | null;
  variation_theme: string | null;
  is_active: boolean;
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
  is_warehouse: boolean;
  created_at: string;
};

export const CENTRAL_WAREHOUSE_ID = "CENTRAL-WH";

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
  variant_id: string | null;
  stock_qty: number;
  avg_cost: number;
  previous_avg_cost: number;
  last_purchase_cost: number;
  updated_at: string;
};

// ============================================================
// SellableItem — the flattened unit that is actually stocked and sold.
// For a product with NO variants  -> one item, variant_id = null
// For a product WITH variants     -> one item per child variant (the parent
//                                    itself is never sellable, like Amazon)
// Every page (POS, Stock-In, Damage, Warehouse...) works off this uniform
// list so it never has to branch on "does this product have variants?".
// ============================================================
export type SellableItem = {
  key: string; // unique per (product, variant) — safe for React keys and Maps
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  display_name: string; // "Baby Diaper (L)" or just "Baby Powder"
  sku: string | null;
  price: number;
  category_id: string | null;
  is_active: boolean;
  stock_qty: number;
  avg_cost: number;
  previous_avg_cost: number;
  last_purchase_cost: number;
};

export function inventoryKey(productId: string, variantId: string | null) {
  return `${productId}:${variantId || "base"}`;
}

export async function fetchSellableItems(storeId: string, includeInactive = false): Promise<SellableItem[]> {
  let productQuery = supabase.from("products").select("*").order("name");
  if (!includeInactive) productQuery = productQuery.eq("is_active", true);
  const { data: products } = await productQuery;

  let variantQuery = supabase.from("product_variants").select("*").order("created_at");
  if (!includeInactive) variantQuery = variantQuery.eq("is_active", true);
  const { data: variants } = await variantQuery;

  const { data: inv } = await supabase.from("store_inventory").select("*").eq("store_id", storeId);
  const invMap = new Map(
    (inv || []).map((i) => [inventoryKey(i.product_id, i.variant_id), i])
  );

  const variantsByProduct = new Map<string, ProductVariant[]>();
  for (const v of (variants || []) as ProductVariant[]) {
    const list = variantsByProduct.get(v.product_id) || [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  const items: SellableItem[] = [];
  for (const p of (products || []) as Product[]) {
    const children = variantsByProduct.get(p.id) || [];

    if (children.length === 0) {
      const i = invMap.get(inventoryKey(p.id, null));
      items.push({
        key: inventoryKey(p.id, null),
        product_id: p.id,
        variant_id: null,
        product_name: p.name,
        variant_name: null,
        display_name: p.name,
        sku: p.sku,
        price: p.price,
        category_id: p.category_id,
        is_active: p.is_active,
        stock_qty: i?.stock_qty ?? 0,
        avg_cost: i?.avg_cost ?? 0,
        previous_avg_cost: i?.previous_avg_cost ?? 0,
        last_purchase_cost: i?.last_purchase_cost ?? 0,
      });
      continue;
    }

    // Parent with children: only the children are sellable/stockable
    for (const v of children) {
      const i = invMap.get(inventoryKey(p.id, v.id));
      items.push({
        key: inventoryKey(p.id, v.id),
        product_id: p.id,
        variant_id: v.id,
        product_name: p.name,
        variant_name: v.variant_name,
        display_name: `${p.name} (${v.variant_name})`,
        sku: v.sku || p.sku,
        price: v.price_override ?? p.price,
        category_id: p.category_id,
        is_active: p.is_active && v.is_active,
        stock_qty: i?.stock_qty ?? 0,
        avg_cost: i?.avg_cost ?? 0,
        previous_avg_cost: i?.previous_avg_cost ?? 0,
        last_purchase_cost: i?.last_purchase_cost ?? 0,
      });
    }
  }
  return items;
}

export async function fetchSellableItem(
  productId: string,
  variantId: string | null,
  storeId: string
): Promise<SellableItem | null> {
  const items = await fetchSellableItems(storeId, true);
  return items.find((i) => i.product_id === productId && i.variant_id === variantId) || null;
}

// Creates or updates a store's stock/cost row for a product+variant.
// Any field left out keeps its current value.
export async function upsertStoreInventory(
  storeId: string,
  productId: string,
  variantId: string | null,
  fields: Partial<Pick<StoreInventory, "stock_qty" | "avg_cost" | "previous_avg_cost" | "last_purchase_cost">>
) {
  let query = supabase
    .from("store_inventory")
    .select("*")
    .eq("store_id", storeId)
    .eq("product_id", productId);
  query = variantId ? query.eq("variant_id", variantId) : query.is("variant_id", null);
  const { data: existing } = await query.maybeSingle();

  const merged = {
    store_id: storeId,
    product_id: productId,
    variant_id: variantId,
    stock_qty: fields.stock_qty ?? existing?.stock_qty ?? 0,
    avg_cost: fields.avg_cost ?? existing?.avg_cost ?? 0,
    previous_avg_cost: fields.previous_avg_cost ?? existing?.previous_avg_cost ?? 0,
    last_purchase_cost: fields.last_purchase_cost ?? existing?.last_purchase_cost ?? 0,
    updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from("store_inventory").update(merged).eq("id", existing.id)
    : await supabase.from("store_inventory").insert(merged);
  if (error) throw error;
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
  is_active: boolean;
  created_at: string;
};

export type SalesRep = {
  id: string;
  store_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
};

export type StockTransfer = {
  id: string;
  product_id: string;
  to_store_id: string;
  qty: number;
  transferred_by: string | null;
  note: string | null;
  created_at: string;
};

export type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  is_active: boolean;
  created_at: string;
};

export type PoStatus = "draft" | "ordered" | "partial" | "received" | "cancelled";
export type PaymentTerm = "advance" | "cod" | "credit" | "paid";

export type PurchaseOrder = {
  id: string;
  po_number: string;
  supplier_id: string | null;
  status: PoStatus;
  payment_term: PaymentTerm;
  order_date: string;
  expected_date: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type PurchaseOrderItem = {
  id: string;
  po_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  unit_cost: number;
  received_qty: number;
  update_cost: boolean;
  created_at: string;
};

export type PoPayment = {
  id: string;
  po_id: string;
  amount: number;
  paid_at: string;
  method: string | null;
  note: string | null;
  paid_by: string | null;
  created_at: string;
};

// Receiving goods against a PO line: adds a batch, then updates the store's
// stock and cost. Cost rule:
//   - consignment product      -> moving average (never overwritten)
//   - update_cost ticked       -> avg_cost REPLACED by this receipt's unit cost
//   - otherwise                -> moving average
export async function receivePoItem(params: {
  storeId: string;
  productId: string;
  variantId: string | null;
  qty: number;
  unitCost: number;
  updateCost: boolean;
  isConsignment: boolean;
  poId?: string | null;
  supplier?: string | null;
  expiryDate?: string | null;
}) {
  const {
    storeId, productId, variantId, qty, unitCost,
    updateCost, isConsignment, poId, supplier, expiryDate,
  } = params;

  const current = await fetchSellableItem(productId, variantId, storeId);
  const existingQty = current?.stock_qty ?? 0;
  const existingCost = current?.avg_cost ?? 0;

  const newQty = existingQty + qty;
  const movingAvg = newQty > 0 ? (existingQty * existingCost + qty * unitCost) / newQty : 0;
  const useLatestCost = updateCost && !isConsignment;
  const newAvgCost = useLatestCost ? unitCost : movingAvg;

  const { error: batchError } = await supabase.from("stock_purchases").insert({
    product_id: productId,
    variant_id: variantId,
    store_id: storeId,
    supplier: supplier || null,
    qty,
    unit_cost: unitCost,
    total_cost: qty * unitCost,
    new_avg_cost: newAvgCost,
    remaining_qty: qty,
    expiry_date: expiryDate || null,
    po_id: poId || null,
  });
  // Surface batch failures instead of silently updating stock without a ledger entry
  if (batchError) throw batchError;

  await upsertStoreInventory(storeId, productId, variantId, {
    stock_qty: newQty,
    avg_cost: newAvgCost,
    previous_avg_cost: existingCost,
    last_purchase_cost: unitCost,
  });

  return { newQty, newAvgCost };
}
