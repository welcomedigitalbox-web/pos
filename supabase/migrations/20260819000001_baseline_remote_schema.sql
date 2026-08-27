


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."guard_profile_privileged_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_is_admin boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

  select public.is_admin() into v_is_admin;
  if v_is_admin then
    return new;
  end if;

  if new.role         is distinct from old.role         then raise exception 'Not authorised to change role'; end if;
  if new.permissions  is distinct from old.permissions  then raise exception 'Not authorised to change permissions'; end if;
  if new.store_id     is distinct from old.store_id     then raise exception 'Not authorised to change store_id'; end if;
  if new.approval_pin is distinct from old.approval_pin then raise exception 'Not authorised to change approval_pin'; end if;
  if new.id           is distinct from old.id           then raise exception 'Not authorised to change id'; end if;
  if new.email        is distinct from old.email        then raise exception 'Email changes must go through auth'; end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_profile_privileged_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_owner_or_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'owner')
  );
$$;


ALTER FUNCTION "public"."is_owner_or_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_store"("source_id" "text", "target_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  if source_id = target_id then
    raise exception 'Source and target must be different';
  end if;
  if not exists (select 1 from stores where id = target_id) then
    raise exception 'Target location does not exist';
  end if;

  -- Combine inventory rows that exist in both locations
  update store_inventory t
  set stock_qty = t.stock_qty + s.stock_qty,
      avg_cost = case
        when (t.stock_qty + s.stock_qty) > 0
          then ((t.stock_qty * t.avg_cost) + (s.stock_qty * s.avg_cost))
               / (t.stock_qty + s.stock_qty)
        else t.avg_cost
      end,
      updated_at = now()
  from store_inventory s
  where s.store_id = source_id
    and t.store_id = target_id
    and t.product_id = s.product_id
    and coalesce(t.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(s.variant_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- Rows that only exist in the source simply move across
  delete from store_inventory s
  where s.store_id = source_id
    and exists (
      select 1 from store_inventory t
      where t.store_id = target_id
        and t.product_id = s.product_id
        and coalesce(t.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(s.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );
  update store_inventory set store_id = target_id where store_id = source_id;

  -- Reassign history so reports stay complete
  update sales            set store_id    = target_id where store_id    = source_id;
  update stock_purchases  set store_id    = target_id where store_id    = source_id;
  update stock_damages    set store_id    = target_id where store_id    = source_id;
  update stock_requests   set store_id    = target_id where store_id    = source_id;
  update stock_transfers  set to_store_id = target_id where to_store_id = source_id;
  update sales_reps       set store_id    = target_id where store_id    = source_id;
  update profiles         set store_id    = target_id where store_id    = source_id;

  -- Settings and payment methods: keep the target's, drop the source's
  delete from store_settings where store_id = source_id;

  update stores set is_active = false where id = source_id;
end;
$$;


ALTER FUNCTION "public"."merge_store"("source_id" "text", "target_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "action" "text" NOT NULL,
    "detail" "text",
    "actor" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_drawer_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "opening_amount" numeric DEFAULT 0 NOT NULL,
    "opened_by" "text",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "counted_amount" numeric,
    "expected_amount" numeric,
    "variance" numeric,
    "closed_by" "text",
    "closed_at" timestamp with time zone,
    "note" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    CONSTRAINT "cash_drawer_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."cash_drawer_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "reason" "text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "cash_movements_direction_check" CHECK (("direction" = ANY (ARRAY['in'::"text", 'out'::"text"])))
);


ALTER TABLE "public"."cash_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "store_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    "date_of_birth" "date",
    "delivery_address" "text",
    "facebook" "text",
    "tiktok" "text",
    "loyalty_tier_id" "uuid",
    "store_credit" numeric DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inter_store_settlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owing_store_id" "text" NOT NULL,
    "owed_store_id" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "reason" "text" DEFAULT 'cross_store_refund'::"text" NOT NULL,
    "sale_return_id" "uuid",
    "note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "settled_by" "text",
    "settled_at" timestamp with time zone,
    "settle_method" "text",
    CONSTRAINT "inter_store_settlements_reason_check" CHECK (("reason" = ANY (ARRAY['cross_store_refund'::"text", 'manual'::"text"]))),
    CONSTRAINT "inter_store_settlements_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'settled'::"text"])))
);


ALTER TABLE "public"."inter_store_settlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."loyalty_tiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "discount_percent" numeric DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."loyalty_tiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_methods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text",
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "is_cash" boolean DEFAULT false NOT NULL,
    "is_cod" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."payment_methods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."po_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_id" "uuid" NOT NULL,
    "amount" numeric NOT NULL,
    "paid_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "method" "text",
    "note" "text",
    "paid_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."po_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."product_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "variant_name" "text" NOT NULL,
    "sku" "text",
    "price_override" numeric,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."product_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "sku" "text",
    "price" numeric DEFAULT 0 NOT NULL,
    "store_id" "text" DEFAULT 'default'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "category_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_consignment" boolean DEFAULT false NOT NULL,
    "requires_expiry" boolean DEFAULT false NOT NULL,
    "variation_theme" "text"
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "role" "text" DEFAULT 'cashier'::"text" NOT NULL,
    "store_id" "text" DEFAULT 'SR-BAK'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "permissions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "approval_pin" "text",
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['cashier'::"text", 'manager'::"text", 'admin'::"text", 'owner'::"text", 'sale_manager'::"text", 'online_sale'::"text", 'wholesale'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "variant_id" "uuid",
    "qty" numeric NOT NULL,
    "unit_cost" numeric DEFAULT 0 NOT NULL,
    "received_qty" numeric DEFAULT 0 NOT NULL,
    "update_cost" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."purchase_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_number" "text" NOT NULL,
    "supplier_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "payment_term" "text" DEFAULT 'credit'::"text" NOT NULL,
    "order_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expected_date" "date",
    "note" "text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    CONSTRAINT "purchase_orders_payment_term_check" CHECK (("payment_term" = ANY (ARRAY['advance'::"text", 'cod'::"text", 'credit'::"text", 'paid'::"text"]))),
    CONSTRAINT "purchase_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'ordered'::"text", 'partial'::"text", 'received'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_id" "uuid",
    "product_id" "uuid",
    "product_name" "text" NOT NULL,
    "qty" numeric NOT NULL,
    "unit_price" numeric NOT NULL,
    "line_total" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "unit_cost" numeric DEFAULT 0 NOT NULL,
    "line_cogs" numeric DEFAULT 0 NOT NULL,
    "batch_id" "uuid",
    "variant_id" "uuid"
);


ALTER TABLE "public"."sale_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_return_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "return_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "variant_id" "uuid",
    "product_name" "text",
    "qty" numeric NOT NULL,
    "unit_price" numeric DEFAULT 0 NOT NULL,
    "unit_cogs" numeric DEFAULT 0 NOT NULL,
    "condition" "text" DEFAULT 'good'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "line_type" "text" DEFAULT 'return'::"text" NOT NULL,
    CONSTRAINT "sale_return_items_condition_check" CHECK (("condition" = ANY (ARRAY['good'::"text", 'damaged'::"text"]))),
    CONSTRAINT "sale_return_items_line_type_check" CHECK (("line_type" = ANY (ARRAY['return'::"text", 'exchange'::"text"])))
);


ALTER TABLE "public"."sale_return_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_returns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "return_number" "text" NOT NULL,
    "original_sale_id" "uuid",
    "store_id" "text" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text",
    "refund_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "refund_amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason" "text",
    "voucher_url" "text",
    "requested_by" "text",
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "rejected_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "refund_payment_method" "text",
    "exchange_sale_id" "uuid",
    "processed_store_id" "text",
    "return_transfer_id" "uuid",
    CONSTRAINT "sale_returns_refund_method_check" CHECK (("refund_method" = ANY (ARRAY['cash'::"text", 'exchange'::"text"]))),
    CONSTRAINT "sale_returns_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."sale_returns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_ref" "text",
    "store_id" "text" DEFAULT 'default'::"text" NOT NULL,
    "cashier" "text",
    "total" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "payment_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "subtotal" numeric DEFAULT 0 NOT NULL,
    "discount_type" "text" DEFAULT 'flat'::"text",
    "discount_value" numeric DEFAULT 0 NOT NULL,
    "discount_amount" numeric DEFAULT 0 NOT NULL,
    "vat_percent" numeric DEFAULT 0 NOT NULL,
    "vat_amount" numeric DEFAULT 0 NOT NULL,
    "amount_received" numeric DEFAULT 0 NOT NULL,
    "change_amount" numeric DEFAULT 0 NOT NULL,
    "advance_payment" numeric DEFAULT 0 NOT NULL,
    "balance_due" numeric DEFAULT 0 NOT NULL,
    "note" "text",
    "customer_id" "uuid",
    "customer_name" "text",
    "cashier_email" "text",
    "order_type" "text" DEFAULT 'walk_in'::"text" NOT NULL,
    "order_status" "text" DEFAULT 'completed'::"text" NOT NULL,
    "delivery_address" "text",
    "channel" "text",
    "discount_approved_by" "text",
    "discount_approved_at" timestamp with time zone,
    "sale_rep_id" "uuid",
    "sale_rep_name" "text",
    CONSTRAINT "sales_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['percent'::"text", 'flat'::"text"]))),
    CONSTRAINT "sales_order_status_check" CHECK (("order_status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'delivered'::"text", 'cancelled'::"text", 'completed'::"text"]))),
    CONSTRAINT "sales_order_type_check" CHECK (("order_type" = ANY (ARRAY['walk_in'::"text", 'online'::"text", 'wholesale'::"text"])))
);


ALTER TABLE "public"."sales" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_reps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sales_reps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_damages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "qty" numeric NOT NULL,
    "reason" "text",
    "reported_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "variant_id" "uuid"
);


ALTER TABLE "public"."stock_damages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "store_id" "text" NOT NULL,
    "supplier" "text",
    "qty" numeric NOT NULL,
    "unit_cost" numeric NOT NULL,
    "total_cost" numeric NOT NULL,
    "new_avg_cost" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expiry_date" "date",
    "remaining_qty" numeric DEFAULT 0 NOT NULL,
    "po_id" "uuid",
    "stock_request_id" "uuid",
    "variant_id" "uuid",
    "received_by" "text",
    "received_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."stock_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "requested_qty" numeric NOT NULL,
    "received_qty" numeric,
    "note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_by" "text",
    "received_by" "text",
    "approved_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "received_at" timestamp with time zone,
    "approved_at" timestamp with time zone,
    "variant_id" "uuid",
    "rejected_reason" "text",
    "requested_warehouse_id" "text",
    "request_no" "text",
    CONSTRAINT "stock_requests_status_check" CHECK (("status" = ANY (ARRAY['awaiting_approval'::"text", 'pending'::"text", 'received'::"text", 'mismatch'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."stock_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "to_store_id" "text" NOT NULL,
    "qty" numeric NOT NULL,
    "transferred_by" "text",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "variant_id" "uuid",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "received_qty" numeric,
    "received_by" "text",
    "received_at" timestamp with time zone,
    "discrepancy_note" "text",
    "from_store_id" "text",
    "photo_url" "text",
    "discrepancy_approved_by" "text",
    "resolution" "text",
    "resolved_by" "text",
    "resolved_at" timestamp with time zone,
    "resolution_note" "text",
    CONSTRAINT "stock_transfers_resolution_check" CHECK ((("resolution" IS NULL) OR ("resolution" = ANY (ARRAY['miscount'::"text", 'damaged'::"text"])))),
    CONSTRAINT "stock_transfers_status_check" CHECK (("status" = ANY (ARRAY['in_transit'::"text", 'received'::"text", 'discrepancy'::"text", 'pending_approval'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."stock_transfers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_id" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "stock_qty" numeric DEFAULT 0 NOT NULL,
    "avg_cost" numeric DEFAULT 0 NOT NULL,
    "previous_avg_cost" numeric DEFAULT 0 NOT NULL,
    "last_purchase_cost" numeric DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "variant_id" "uuid"
);


ALTER TABLE "public"."store_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_product_settings" (
    "store_id" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "is_available" boolean DEFAULT true NOT NULL,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."store_product_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_settings" (
    "store_id" "text" NOT NULL,
    "business_name" "text",
    "phone" "text",
    "address" "text",
    "receipt_footer" "text",
    "logo_text" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."store_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stores" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_warehouse" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "region" "text",
    "supply_warehouse_id" "text"
);


ALTER TABLE "public"."stores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "address" "text",
    "note" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_drawer_sessions"
    ADD CONSTRAINT "cash_drawer_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inter_store_settlements"
    ADD CONSTRAINT "inter_store_settlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loyalty_tiers"
    ADD CONSTRAINT "loyalty_tiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."po_payments"
    ADD CONSTRAINT "po_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_categories"
    ADD CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_return_items"
    ADD CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_returns"
    ADD CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_reps"
    ADD CONSTRAINT "sales_reps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_damages"
    ADD CONSTRAINT "stock_damages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_purchases"
    ADD CONSTRAINT "stock_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_requests"
    ADD CONSTRAINT "stock_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_inventory"
    ADD CONSTRAINT "store_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_product_settings"
    ADD CONSTRAINT "store_product_settings_pkey" PRIMARY KEY ("store_id", "product_id");



ALTER TABLE ONLY "public"."store_settings"
    ADD CONSTRAINT "store_settings_pkey" PRIMARY KEY ("store_id");



ALTER TABLE ONLY "public"."stores"
    ADD CONSTRAINT "stores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_activity_log_entity" ON "public"."activity_log" USING "btree" ("entity_type", "entity_id", "created_at" DESC);



CREATE INDEX "idx_cash_movements_session" ON "public"."cash_movements" USING "btree" ("session_id");



CREATE INDEX "idx_customers_store" ON "public"."customers" USING "btree" ("store_id");



CREATE UNIQUE INDEX "idx_drawer_one_open" ON "public"."cash_drawer_sessions" USING "btree" ("store_id") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_drawer_store_date" ON "public"."cash_drawer_sessions" USING "btree" ("store_id", "opened_at" DESC);



CREATE INDEX "idx_loyalty_tiers_store" ON "public"."loyalty_tiers" USING "btree" ("store_id");



CREATE INDEX "idx_payment_methods_store" ON "public"."payment_methods" USING "btree" ("store_id");



CREATE INDEX "idx_po_items_po" ON "public"."purchase_order_items" USING "btree" ("po_id");



CREATE INDEX "idx_po_payments_po" ON "public"."po_payments" USING "btree" ("po_id");



CREATE INDEX "idx_product_variants_active" ON "public"."product_variants" USING "btree" ("product_id") WHERE ("is_active" = true);



CREATE INDEX "idx_product_variants_product" ON "public"."product_variants" USING "btree" ("product_id");



CREATE INDEX "idx_product_variants_sku" ON "public"."product_variants" USING "btree" ("lower"("sku"));



CREATE INDEX "idx_products_active" ON "public"."products" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_products_category" ON "public"."products" USING "btree" ("category_id");



CREATE INDEX "idx_products_sku" ON "public"."products" USING "btree" ("lower"("sku"));



CREATE INDEX "idx_products_store" ON "public"."products" USING "btree" ("store_id");



CREATE INDEX "idx_purchase_orders_status" ON "public"."purchase_orders" USING "btree" ("status");



CREATE INDEX "idx_purchase_orders_supplier" ON "public"."purchase_orders" USING "btree" ("supplier_id");



CREATE INDEX "idx_sale_items_product" ON "public"."sale_items" USING "btree" ("product_id");



CREATE INDEX "idx_sale_items_sale" ON "public"."sale_items" USING "btree" ("sale_id");



CREATE INDEX "idx_sale_items_variant" ON "public"."sale_items" USING "btree" ("variant_id");



CREATE INDEX "idx_sale_return_items_return" ON "public"."sale_return_items" USING "btree" ("return_id");



CREATE INDEX "idx_sale_returns_original" ON "public"."sale_returns" USING "btree" ("original_sale_id");



CREATE INDEX "idx_sale_returns_processed" ON "public"."sale_returns" USING "btree" ("processed_store_id");



CREATE INDEX "idx_sale_returns_sale" ON "public"."sale_returns" USING "btree" ("original_sale_id");



CREATE INDEX "idx_sale_returns_status" ON "public"."sale_returns" USING "btree" ("status");



CREATE INDEX "idx_sale_returns_store" ON "public"."sale_returns" USING "btree" ("store_id", "created_at" DESC);



CREATE INDEX "idx_sale_returns_transfer_back" ON "public"."sale_returns" USING "btree" ("processed_store_id", "return_transfer_id") WHERE ("return_transfer_id" IS NULL);



CREATE INDEX "idx_sales_cashier" ON "public"."sales" USING "btree" ("cashier_email");



CREATE INDEX "idx_sales_created" ON "public"."sales" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sales_customer_name" ON "public"."sales" USING "btree" ("lower"("customer_name"));



CREATE INDEX "idx_sales_order_status" ON "public"."sales" USING "btree" ("order_type", "order_status");



CREATE INDEX "idx_sales_reps_store" ON "public"."sales_reps" USING "btree" ("store_id");



CREATE INDEX "idx_sales_store_created" ON "public"."sales" USING "btree" ("store_id", "created_at" DESC);



CREATE INDEX "idx_sales_store_date" ON "public"."sales" USING "btree" ("store_id", "created_at");



CREATE INDEX "idx_settlements_owed" ON "public"."inter_store_settlements" USING "btree" ("owed_store_id", "status");



CREATE INDEX "idx_settlements_owing" ON "public"."inter_store_settlements" USING "btree" ("owing_store_id", "status");



CREATE INDEX "idx_stock_purchases_fefo" ON "public"."stock_purchases" USING "btree" ("product_id", "expiry_date", "created_at");



CREATE INDEX "idx_stock_purchases_product" ON "public"."stock_purchases" USING "btree" ("product_id");



CREATE INDEX "idx_stock_purchases_store" ON "public"."stock_purchases" USING "btree" ("store_id", "created_at");



CREATE INDEX "idx_stock_purchases_variant" ON "public"."stock_purchases" USING "btree" ("variant_id");



CREATE INDEX "idx_stock_requests_no" ON "public"."stock_requests" USING "btree" ("request_no");



CREATE INDEX "idx_stock_transfers_from" ON "public"."stock_transfers" USING "btree" ("from_store_id");



CREATE INDEX "idx_stock_transfers_status" ON "public"."stock_transfers" USING "btree" ("to_store_id", "status");



CREATE INDEX "idx_stock_transfers_store" ON "public"."stock_transfers" USING "btree" ("to_store_id");



CREATE INDEX "idx_store_inventory_product" ON "public"."store_inventory" USING "btree" ("product_id");



CREATE INDEX "idx_store_inventory_store" ON "public"."store_inventory" USING "btree" ("store_id");



CREATE INDEX "idx_store_inventory_variant" ON "public"."store_inventory" USING "btree" ("variant_id");



CREATE INDEX "idx_store_product_settings_store" ON "public"."store_product_settings" USING "btree" ("store_id");



CREATE INDEX "idx_stores_supply_wh" ON "public"."stores" USING "btree" ("supply_warehouse_id");



CREATE UNIQUE INDEX "store_inventory_store_product_variant_key" ON "public"."store_inventory" USING "btree" ("store_id", "product_id", COALESCE("variant_id", '00000000-0000-0000-0000-000000000000'::"uuid"));



CREATE OR REPLACE TRIGGER "trg_guard_profile_privileged_columns" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_profile_privileged_columns"();



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_loyalty_tier_id_fkey" FOREIGN KEY ("loyalty_tier_id") REFERENCES "public"."loyalty_tiers"("id");



ALTER TABLE ONLY "public"."inter_store_settlements"
    ADD CONSTRAINT "inter_store_settlements_sale_return_id_fkey" FOREIGN KEY ("sale_return_id") REFERENCES "public"."sale_returns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."po_payments"
    ADD CONSTRAINT "po_payments_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_purchases"("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."sale_return_items"
    ADD CONSTRAINT "sale_return_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."sale_return_items"
    ADD CONSTRAINT "sale_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "public"."sale_returns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_return_items"
    ADD CONSTRAINT "sale_return_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."sale_returns"
    ADD CONSTRAINT "sale_returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."sale_returns"
    ADD CONSTRAINT "sale_returns_exchange_sale_id_fkey" FOREIGN KEY ("exchange_sale_id") REFERENCES "public"."sales"("id");



ALTER TABLE ONLY "public"."sale_returns"
    ADD CONSTRAINT "sale_returns_original_sale_id_fkey" FOREIGN KEY ("original_sale_id") REFERENCES "public"."sales"("id");



ALTER TABLE ONLY "public"."sale_returns"
    ADD CONSTRAINT "sale_returns_return_transfer_id_fkey" FOREIGN KEY ("return_transfer_id") REFERENCES "public"."stock_transfers"("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_sale_rep_id_fkey" FOREIGN KEY ("sale_rep_id") REFERENCES "public"."sales_reps"("id");



ALTER TABLE ONLY "public"."stock_damages"
    ADD CONSTRAINT "stock_damages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."stock_damages"
    ADD CONSTRAINT "stock_damages_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_purchases"
    ADD CONSTRAINT "stock_purchases_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id");



ALTER TABLE ONLY "public"."stock_purchases"
    ADD CONSTRAINT "stock_purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."stock_purchases"
    ADD CONSTRAINT "stock_purchases_stock_request_id_fkey" FOREIGN KEY ("stock_request_id") REFERENCES "public"."stock_requests"("id");



ALTER TABLE ONLY "public"."stock_purchases"
    ADD CONSTRAINT "stock_purchases_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_requests"
    ADD CONSTRAINT "stock_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."stock_requests"
    ADD CONSTRAINT "stock_requests_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_inventory"
    ADD CONSTRAINT "store_inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_inventory"
    ADD CONSTRAINT "store_inventory_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_product_settings"
    ADD CONSTRAINT "store_product_settings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stores"
    ADD CONSTRAINT "stores_supply_warehouse_id_fkey" FOREIGN KEY ("supply_warehouse_id") REFERENCES "public"."stores"("id");



ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin can delete profiles" ON "public"."profiles" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin can insert profiles" ON "public"."profiles" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin can update all profiles" ON "public"."profiles" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin can view all profiles" ON "public"."profiles" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "authenticated insert - activity_log" ON "public"."activity_log" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read - activity_log" ON "public"."activity_log" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - cash_drawer_sessions" ON "public"."cash_drawer_sessions" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - cash_movements" ON "public"."cash_movements" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - customers" ON "public"."customers" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - inter_store_settlements" ON "public"."inter_store_settlements" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - loyalty_tiers" ON "public"."loyalty_tiers" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - payment_methods" ON "public"."payment_methods" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - po_payments" ON "public"."po_payments" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - product_categories" ON "public"."product_categories" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - product_variants" ON "public"."product_variants" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - products" ON "public"."products" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - purchase_order_items" ON "public"."purchase_order_items" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - purchase_orders" ON "public"."purchase_orders" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - sale_items" ON "public"."sale_items" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - sale_return_items" ON "public"."sale_return_items" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - sale_returns" ON "public"."sale_returns" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - sales" ON "public"."sales" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - sales_reps" ON "public"."sales_reps" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - stock_damages" ON "public"."stock_damages" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - stock_purchases" ON "public"."stock_purchases" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - stock_requests" ON "public"."stock_requests" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - stock_transfers" ON "public"."stock_transfers" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - store_inventory" ON "public"."store_inventory" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - store_product_settings" ON "public"."store_product_settings" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - store_settings" ON "public"."store_settings" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - stores" ON "public"."stores" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated read/write - suppliers" ON "public"."suppliers" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."cash_drawer_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cash_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inter_store_settlements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loyalty_tiers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_methods" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."po_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_variants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sale_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sale_return_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sale_returns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_reps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_damages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_purchases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_transfers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."store_inventory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."store_product_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."store_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."guard_profile_privileged_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_profile_privileged_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_profile_privileged_columns"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_owner_or_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_owner_or_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_owner_or_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."merge_store"("source_id" "text", "target_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."merge_store"("source_id" "text", "target_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."merge_store"("source_id" "text", "target_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";


















GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."cash_drawer_sessions" TO "anon";
GRANT ALL ON TABLE "public"."cash_drawer_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_drawer_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."cash_movements" TO "anon";
GRANT ALL ON TABLE "public"."cash_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_movements" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."inter_store_settlements" TO "anon";
GRANT ALL ON TABLE "public"."inter_store_settlements" TO "authenticated";
GRANT ALL ON TABLE "public"."inter_store_settlements" TO "service_role";



GRANT ALL ON TABLE "public"."loyalty_tiers" TO "anon";
GRANT ALL ON TABLE "public"."loyalty_tiers" TO "authenticated";
GRANT ALL ON TABLE "public"."loyalty_tiers" TO "service_role";



GRANT ALL ON TABLE "public"."payment_methods" TO "anon";
GRANT ALL ON TABLE "public"."payment_methods" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_methods" TO "service_role";



GRANT ALL ON TABLE "public"."po_payments" TO "anon";
GRANT ALL ON TABLE "public"."po_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."po_payments" TO "service_role";



GRANT ALL ON TABLE "public"."product_categories" TO "anon";
GRANT ALL ON TABLE "public"."product_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."product_categories" TO "service_role";



GRANT ALL ON TABLE "public"."product_variants" TO "anon";
GRANT ALL ON TABLE "public"."product_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."product_variants" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_items" TO "anon";
GRANT ALL ON TABLE "public"."purchase_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."sale_items" TO "anon";
GRANT ALL ON TABLE "public"."sale_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_items" TO "service_role";



GRANT ALL ON TABLE "public"."sale_return_items" TO "anon";
GRANT ALL ON TABLE "public"."sale_return_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_return_items" TO "service_role";



GRANT ALL ON TABLE "public"."sale_returns" TO "anon";
GRANT ALL ON TABLE "public"."sale_returns" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_returns" TO "service_role";



GRANT ALL ON TABLE "public"."sales" TO "anon";
GRANT ALL ON TABLE "public"."sales" TO "authenticated";
GRANT ALL ON TABLE "public"."sales" TO "service_role";



GRANT ALL ON TABLE "public"."sales_reps" TO "anon";
GRANT ALL ON TABLE "public"."sales_reps" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_reps" TO "service_role";



GRANT ALL ON TABLE "public"."stock_damages" TO "anon";
GRANT ALL ON TABLE "public"."stock_damages" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_damages" TO "service_role";



GRANT ALL ON TABLE "public"."stock_purchases" TO "anon";
GRANT ALL ON TABLE "public"."stock_purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_purchases" TO "service_role";



GRANT ALL ON TABLE "public"."stock_requests" TO "anon";
GRANT ALL ON TABLE "public"."stock_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_requests" TO "service_role";



GRANT ALL ON TABLE "public"."stock_transfers" TO "anon";
GRANT ALL ON TABLE "public"."stock_transfers" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_transfers" TO "service_role";



GRANT ALL ON TABLE "public"."store_inventory" TO "anon";
GRANT ALL ON TABLE "public"."store_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."store_inventory" TO "service_role";



GRANT ALL ON TABLE "public"."store_product_settings" TO "anon";
GRANT ALL ON TABLE "public"."store_product_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."store_product_settings" TO "service_role";



GRANT ALL ON TABLE "public"."store_settings" TO "anon";
GRANT ALL ON TABLE "public"."store_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."store_settings" TO "service_role";



GRANT ALL ON TABLE "public"."stores" TO "anon";
GRANT ALL ON TABLE "public"."stores" TO "authenticated";
GRANT ALL ON TABLE "public"."stores" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































