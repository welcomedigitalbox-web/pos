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
  created_at: string;
  updated_at: string;
};

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
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
