"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { matchesSearch } from "@/lib/search";
import { supabase, Customer, PaymentMethodRow, StoreSettings, LoyaltyTier, SalesRep, ProductCategory, SellableItem, fetchSellableItems, upsertStoreInventory, yangonToday } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { hasPermission } from "../permissions";
import { tierDiscountPercent } from "../loyalty";
import Receipt, { ReceiptData } from "../receipt";

type CartItem = {
  key: string; // productId:variantId â one cart line per sellable item
  product_id: string;
  variant_id: string | null;
  name: string;
  price: number;
  qty: number;
  stock_qty: number;
  avg_cost: number;
  base_price?: number;   // price of one base unit (pc)
  uom_code?: string;
  uom_name?: string;
  factor?: number;       // base units in one selling unit
  line_discount?: number; // money off this line, before any invoice discount
};

type Uom = { id: string; product_id: string; code: string; name: string; factor: number; price: number | null; is_base: boolean };

type PromoItem = { product_id: string | null; category_id: string | null; role: string; qty: number | null };
type Promo = {
  id: string; name: string; kind: "percent" | "amount" | "fixed_price" | "bxgy" | "bundle";
  value: number | null; buy_qty: number | null; get_qty: number | null;
  min_qty: number | null; min_amount: number | null;
  priority: number; stackable: boolean; items: PromoItem[];
};

// The same Myanmar number gets written 09..., +959... and 959..., and a
// cashier types whichever one the customer says. Comparing the digits that
// are common to all three finds the person either way.
function phoneCore(raw: string) {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("95")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  return d.length >= 4 ? d : "";
}

type HeldOrder = {
  id: string;
  label: string;
  at: string;
  cart: CartItem[];
  customerId: string | null;
  customerName: string;
  note: string;
};

// Parked baskets live in this till's own browser: they are a few minutes of
// counter work, not business records, and they must survive a stray refresh
// without a round trip to the database.
const HELD_KEY = "edu.held.";

function readHeld(storeId: string): HeldOrder[] {
  try {
    const raw = localStorage.getItem(HELD_KEY + storeId);
    return raw ? (JSON.parse(raw) as HeldOrder[]) : [];
  } catch {
    return [];
  }
}

function writeHeld(storeId: string, rows: HeldOrder[]) {
  try {
    localStorage.setItem(HELD_KEY + storeId, JSON.stringify(rows));
  } catch {
    /* a full or blocked store just means no parking today */
  }
}

type DiscountType = "percent" | "flat";

const STANDARD_VAT_PERCENT = 5;

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function POSPage() {
  const { storeId, stores } = useStore();
  const { t } = useLanguage();
  const { profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasPermission(profile, "pos")) router.replace("/sale-order");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const [items, setItems] = useState<SellableItem[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  // A customer who wanders off to look at one more thing should not hold up
  // the queue. Their basket waits here until they come back.
  const [held, setHeld] = useState<HeldOrder[]>([]);
  const [noDiscount, setNoDiscount] = useState<Record<string, string>>({});
  const [minPrice, setMinPrice] = useState<Record<string, number>>({});
  const [noPromo, setNoPromo] = useState<Record<string, boolean>>({});
  const [uoms, setUoms] = useState<Record<string, Uom[]>>({});
  const idempotencyKeyRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  // Discount approval workflow (cashier-tier roles need Sale Manager/Owner/Admin sign-off)
  const [discountApproved, setDiscountApproved] = useState(false);
  const [discountApprovedBy, setDiscountApprovedBy] = useState<string | null>(null);
  const [approvedPin, setApprovedPin] = useState<string | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<"" | "waiting" | "rejected">("");
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalMode, setApprovalMode] = useState<"pin" | "password">("pin");
  const [approverPin, setApproverPin] = useState("");
  const [approverEmail, setApproverEmail] = useState("");
  const [approverPassword, setApproverPassword] = useState("");
  const [approverError, setApproverError] = useState("");
  const [approving, setApproving] = useState(false);

  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodRow[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<string>("cash");
  const [storeSettings, setStoreSettings] = useState<StoreSettings | null>(null);
  const [discountType, setDiscountType] = useState<DiscountType>("flat");
  const [discountValue, setDiscountValue] = useState("");
  const [vatEnabled, setVatEnabled] = useState(false);
  const [amountReceived, setAmountReceived] = useState("");
  // A customer paying half in cash and half by wallet is one sale, not two.
  const [splitting, setSplitting] = useState(false);
  // Wholesale takes part of the money now and the rest on a later visit.
  const [creditSale, setCreditSale] = useState(false);
  const [paidNow, setPaidNow] = useState("");
  const [splitLines, setSplitLines] = useState<{ method: string; amount: string }[]>([]);
  const [advancePayment, setAdvancePayment] = useState("");
  const [note, setNote] = useState("");
  // Shops settle in notes; the cashier says what to round to.
  const [roundTo, setRoundTo] = useState("");
  const [lineRaw, setLineRaw] = useState<Record<string, string>>({});
  const [lineMode, setLineMode] = useState<Record<string, string>>({});

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loyaltyTiers, setLoyaltyTiers] = useState<LoyaltyTier[]>([]);
  const [salesReps, setSalesReps] = useState<SalesRep[]>([]);
  const [saleRepId, setSaleRepId] = useState("");
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [variantPickerProductId, setVariantPickerProductId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerPhone, setCustomerPhone] = useState("");

  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  // Parked baskets belong to the branch the till is set to.
  useEffect(() => {
    if (storeId) setHeld(readHeld(storeId));
  }, [storeId]);

  // Auto-apply loyalty tier discount whenever a loyalty customer is selected
  useEffect(() => {
    const tierPercent = tierDiscountPercent(loyaltyTiers, selectedCustomer?.loyalty_tier_id);
    if (tierPercent > 0) {
      setDiscountType("percent");
      setDiscountValue(String(tierPercent));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer, loyaltyTiers]);

  // Typing in the customer box asks the database a moment after the typing
  // stops, so a till on a slow line is not sending a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerSearch]);

  // Any change to the discount invalidates a prior approval â must re-approve
  useEffect(() => {
    setDiscountApproved(false);
    setDiscountApprovedBy(null);
  }, [discountValue, discountType]);

  useEffect(() => {
    loadProducts();
    loadCustomers();
    loadLoyaltyTiers();
    loadSalesReps();
    loadCategoriesAndVariants();
    loadPaymentMethods();
    loadStoreSettings();
    resetOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function loadPaymentMethods() {
    const { data } = await supabase
      .from("pay_methods_v")
      .select("*")
      .eq("use_in_pos", true)
      .order("sort_order");
    setPaymentMethods(data || []);
    if (data && data.length > 0) setPaymentMethod(data[0].code);
  }

  async function loadStoreSettings() {
    const { data } = await supabase.from("store_settings").select("*").eq("store_id", storeId).maybeSingle();
    setStoreSettings(data);
  }

  async function loadProducts() {
    // A price merchandising scheduled for this morning should already be in
    // force. The nightly job does that; this is the second belt, and it costs
    // one cheap call that does nothing on the days nothing is due.
    await supabase.rpc("apply_due_price_changes_if_any");

    const data = await fetchSellableItems(storeId);

    // A package holds no stock of its own, so it never comes back from the
    // sellable list. How many can be sold is however many the parts on the
    // shelf can make up, which the database works out for us.
    const [{ data: pkgs }, { data: avail }] = await Promise.all([
      supabase
        .from("products")
        .select("id,name,sku,price,category_id")
        .eq("is_package", true)
        .eq("is_active", true),
      supabase
        .from("package_availability")
        .select("package_product_id,can_make")
        .eq("store_id", storeId),
    ]);
    const canMake = new Map(
      ((avail as { package_product_id: string; can_make: number }[]) || []).map(
        (a) => [a.package_product_id, Number(a.can_make) || 0]
      )
    );
    const packageItems = ((pkgs as {
      id: string; name: string; sku: string | null;
      price: number | null; category_id: string | null;
    }[]) || []).map((p) => ({
      key: `${p.id}:pkg`,
      product_id: p.id,
      variant_id: null,
      product_name: p.name,
      variant_name: null,
      display_name: `\u{1f381} ${p.name}`,
      sku: p.sku,
      price: Number(p.price) || 0,
      category_id: p.category_id,
      is_active: true,
      requires_expiry: false,
      stock_qty: canMake.get(p.id) ?? 0,
      avg_cost: 0,
      previous_avg_cost: 0,
      last_purchase_cost: 0,
      consigned_qty: 0,
      owned_qty: canMake.get(p.id) ?? 0,
    })) as unknown as SellableItem[];

    setItems([...packageItems, ...data]);
  }

  // The till does not need every customer in the business on screen before
  // the first sale of the day â it needs the ones likely to walk in, and a
  // way to find anybody else. Pulling the whole table made the page slower
  // every month, and past a thousand rows the ones beyond the cap could not
  // be found at all.
  async function loadCustomers() {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    setCustomers(data || []);
  }

  // Anyone not in that window is found by asking the database, which is what
  // an index is for.
  async function searchCustomers(q: string) {
    const term = q.trim();
    if (term.length < 2) return;
    const like = `%${term}%`;
    const core = phoneCore(term);
    const { data } = await supabase
      .from("customers")
      .select("*")
      .or(
        core
          ? `name.ilike.${like},phone.ilike.%${core}%`
          : `name.ilike.${like},phone.ilike.${like}`
      )
      .order("name")
      .limit(25);
    if (!data?.length) return;
    setCustomers((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      return [...prev, ...data.filter((c) => !seen.has(c.id))];
    });
  }

  async function loadLoyaltyTiers() {
    const { data } = await supabase
      .from("loyalty_tiers")
      .select("*")
      .order("sort_order");
    setLoyaltyTiers(data || []);
  }

  async function loadSalesReps() {
    const { data } = await supabase
      .from("sales_reps")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("name");
    setSalesReps(data || []);
  }

  async function loadCategoriesAndVariants() {
    const { data: cats } = await supabase.from("product_categories").select("*").order("sort_order");
    setCategories(cats || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function holdOrder() {
    if (cart.length === 0) return;
    const label =
      selectedCustomer?.name ||
      customerSearch.trim() ||
      cart[0]?.name ||
      "Basket";
    const row: HeldOrder = {
      id: crypto.randomUUID(),
      label,
      at: new Date().toISOString(),
      cart,
      customerId: selectedCustomer?.id ?? null,
      customerName: selectedCustomer?.name || customerSearch.trim(),
      note,
    };
    const next = [...held, row];
    setHeld(next);
    writeHeld(storeId, next);
    resetOrder();
    showToast(`${label} parked`);
  }

  // Bringing one back puts whatever is on screen now into its place, so the
  // cashier can flip between two customers without losing either basket.
  function resumeOrder(row: HeldOrder) {
    let next = held.filter((h) => h.id !== row.id);
    if (cart.length > 0) {
      next = [
        ...next,
        {
          id: crypto.randomUUID(),
          label: selectedCustomer?.name || customerSearch.trim() || cart[0]?.name || "Basket",
          at: new Date().toISOString(),
          cart,
          customerId: selectedCustomer?.id ?? null,
          customerName: selectedCustomer?.name || customerSearch.trim(),
          note,
        },
      ];
    }
    setHeld(next);
    writeHeld(storeId, next);

    resetOrder();
    setCart(row.cart);
    setNote(row.note);
    setCustomerSearch(row.customerName);
    const c = customers.find((x) => x.id === row.customerId);
    if (c) setSelectedCustomer(c);
  }

  function dropHeld(id: string) {
    const next = held.filter((h) => h.id !== id);
    setHeld(next);
    writeHeld(storeId, next);
  }

  function resetOrder() {
    setCart([]);
    setPaymentMethod(paymentMethods[0]?.code || "cash");
    setDiscountType("flat");
    setDiscountValue("");
    setVatEnabled(false);
    setAmountReceived("");
    setAdvancePayment("");
    setCreditSale(false);
    setPaidNow("");
    setRoundTo("");
    setSplitting(false);
    setSplitLines([]);
    setNote("");
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPhone("");
    setDiscountApproved(false);
    setDiscountApprovedBy(null);
  }

  // What the shop is being asked to allow, in kyats.
  const discountAsked = () => discountAmount + lineDiscountTotal;

  async function submitDiscountApproval() {
    if (approverPin.length < 4) return;

    setApproving(true);
    setApproverError("");
    try {
      const { data, error } = await supabase.rpc("verify_store_pin", {
        p_store: storeId,
        p_pin: approverPin,
        p_discount: discountAsked(),
      });
      if (error) {
        setApproverError(error.message);
        return;
      }
      setDiscountApproved(true);
      setDiscountApprovedBy(String(data));
      setApprovedPin(approverPin);
      setApprovalRequest(null);
      setShowApprovalModal(false);
      setApproverPin("");
      showToast(String(data));
    } catch (err) {
      setApproverError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  // When the shop may not allow it on its own, the manager is asked - and
  // the till waits for his answer rather than for a phone call.
  async function askTheManager() {
    setApproving(true);
    setApproverError("");
    try {
      const { data, error } = await supabase.rpc("request_discount", {
        p_store: storeId,
        p_subtotal: subtotal,
        p_discount: discountAsked(),
        p_customer_name: selectedCustomer?.name || customerSearch.trim() || null,
        p_note: note.trim() || null,
      });
      if (error) {
        setApproverError(error.message);
        return;
      }
      const id = String(data);
      setApprovalRequest(id);
      setRequestState("waiting");

      // Check back every few seconds until he answers or the till gives up.
      const started = Date.now();
      const timer = setInterval(async () => {
        if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(timer);
          setRequestState("");
          setApproverError("No answer yet. Try the shop PIN or ask again.");
          return;
        }
        const { data: row } = await supabase
          .from("discount_requests")
          .select("status, decider_email, reason")
          .eq("id", id)
          .maybeSingle();
        const r = row as { status?: string; decider_email?: string; reason?: string } | null;
        if (!r) return;
        if (r.status === "approved") {
          clearInterval(timer);
          setRequestState("");
          setDiscountApproved(true);
          setDiscountApprovedBy(r.decider_email || "manager");
          setApprovedPin(null);
          setShowApprovalModal(false);
          showToast(`${t("pos_discountApprovedBy")} ${r.decider_email || ""}`);
        } else if (r.status === "rejected") {
          clearInterval(timer);
          setRequestState("rejected");
          setApprovalRequest(null);
          setApproverError(r.reason || "The manager said no.");
        }
      }, 4000);
    } catch (err) {
      setApproverError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  // Group sellable items by their parent product so the grid shows one card per
  // product; products with variants open a picker instead of adding directly.
  const productGroups = useMemo(() => {
    const groups = new Map<string, { productName: string; categoryId: string | null; items: SellableItem[] }>();
    for (const item of items) {
      const g = groups.get(item.product_id) || {
        productName: item.product_name,
        categoryId: item.category_id,
        items: [],
      };
      g.items.push(item);
      groups.set(item.product_id, g);
    }
    return groups;
  }, [items]);

  function cartQtyForItem(key: string) {
    return cart.find((c) => c.key === key)?.qty || 0;
  }

  function handleProductClick(productId: string) {
    const group = productGroups.get(productId);
    if (!group) return;
    const hasVariants = group.items.some((i) => i.variant_id !== null);
    if (hasVariants) {
      setVariantPickerProductId(productId);
      return;
    }
    // A package row carries the product's own id but counts how many
    // sets could be built, which is usually none. Prefer the real thing.
    const real = group.items.filter((i) => !String(i.key).endsWith(":pkg"));
    addToCart((real.find((i) => i.stock_qty > 0) || real[0] || group.items[0]));
  }

  // A scan may be the supplier's own barcode, one we printed ourselves, a
  // carton barcode, or the article number. The database knows which of
  // those a code is; the till used to know only the last one, so anything
  // the manufacturer printed scanned as nothing.
  //
  // The SKU is still matched first, so a scan that already worked still
  // answers at once without waiting on a round trip.
  async function scanned(value: string) {
    const code = value.trim();
    if (!code) return;

    const bySku = items.find(
      (i) => (i.sku || "").toLowerCase() === code.toLowerCase()
    );
    if (bySku) {
      addToCart(bySku);
      setSearch("");
      return;
    }

    // Short strings are somebody typing a name, not a scanner finishing.
    if (code.length < 6) return;

    const { data } = await supabase.rpc("resolve_barcode", { p_code: code });
    const hit = (data as { product_id: string; variant_id: string | null; qty_each: number }[] | null)?.[0];
    if (!hit) return;

    const found = items.find(
      (i) => !String(i.key).endsWith(":pkg") &&
        i.product_id === hit.product_id &&
        (i.variant_id || null) === (hit.variant_id || null)
    );
    if (!found) return showToast("not on sale here: " + hit.product_id.slice(0, 8));

    // A carton barcode means a carton of them, not one of them.
    const each = Math.max(1, Number(hit.qty_each) || 1);
    for (let n = 0; n < each; n++) addToCart(found);
    setSearch("");
  }

  function addToCart(item: SellableItem) {
    if (item.stock_qty <= 0)
      return showToast(t("pos_outOfStock"));
    if (cartQtyForItem(item.key) >= item.stock_qty) return showToast(t("pos_notEnoughStock"));

    setCart((prev) => {
      const existing = prev.find((c) => c.key === item.key);
      if (existing) {
        return prev.map((c) => (c.key === item.key ? { ...c, qty: c.qty + 1 } : c));
      }
      return [
        ...prev,
        {
          key: item.key,
          product_id: item.product_id,
          variant_id: item.variant_id,
          name: item.display_name,
          price: item.price,
          qty: 1,
          stock_qty: item.stock_qty,
          avg_cost: item.avg_cost,
        },
      ];
    });
    setVariantPickerProductId(null);
  }

  function changeQty(key: string, delta: number) {
    setCart((prev) => {
      const line = prev.find((c) => c.key === key);
      if (!line) return prev;
      if (delta > 0 && line.qty >= line.stock_qty) {
        showToast(t("pos_notEnoughStock"));
        return prev;
      }
      return prev
        .map((c) => (c.key === key ? { ...c, qty: c.qty + delta } : c))
        .filter((c) => c.qty > 0);
    });
  }

  // One entry per parent product, filtered by category + search
  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(productGroups.entries()).filter(([, g]) => {
      if (categoryFilter !== "all" && g.categoryId !== categoryFilter) return false;
      if (!q) return true;
      return (
        matchesSearch(q, g.productName) ||
        g.items.some((i) => matchesSearch(q, i.display_name, i.sku, i.codes))
      );
    });
  }, [productGroups, categoryFilter, search]);

  // Drawing every product is what costs the time, not fetching them. Until the
  // cashier searches or picks a category, show a workable slice.
  const POS_GRID_LIMIT = 60;
  const isNarrowed = search.trim() !== "" || categoryFilter !== "all";
  // Three thousand items will not fit on a till screen, and a cashier who
  // does not know the name cannot search for it. Pages let them look.
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filteredGroups.length / POS_GRID_LIMIT));
  const atPage = Math.min(page, pageCount - 1);
  const visibleGroups = isNarrowed
    ? filteredGroups
    : filteredGroups.slice(atPage * POS_GRID_LIMIT, (atPage + 1) * POS_GRID_LIMIT);
  const hiddenCount = filteredGroups.length - visibleGroups.length;

  const searchCore = phoneCore(customerSearch);
  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
      (searchCore
        ? phoneCore(c.phone || "").includes(searchCore)
        : (c.phone || "").includes(customerSearch))
  );
  const exactCustomerMatch = customers.some(
    (c) => c.name.toLowerCase() === customerSearch.trim().toLowerCase()
  );

  async function quickAddCustomer() {
    const name = customerSearch.trim();
    if (!name) return;
    const { data, error } = await supabase
      .from("customers")
      .insert({ name, phone: customerPhone.trim() || null, store_id: storeId })
      .select()
      .single();
    if (error) {
      showToast("â " + error.message);
      return;
    }
    setCustomers((prev) => [...prev, data]);
    setSelectedCustomer(data);
    setCustomerSearch(data.name);
    setShowCustomerDropdown(false);
  }

  // Some items may never be discounted, and some carry a floor price. Both are
  // set by merchandising on the product itself, so the till just enforces them.
  useEffect(() => {
    // Only the products that carry a rule. Fetching the whole catalogue to
    // find the few with a floor price meant the list was cut off at a
    // thousand rows, and a rule past the cut silently stopped applying.
    supabase.from("products")
      .select("id, name, allow_discount, allow_promotion, min_price, category_id")
      .or("allow_discount.is.false,allow_promotion.is.false,min_price.not.is.null")
      .limit(5000)
      .then(({ data }) => {
        const no: Record<string, string> = {};
        const mn: Record<string, number> = {};
        const np: Record<string, boolean> = {};
        for (const r of (data as { id: string; name: string; allow_discount: boolean | null; allow_promotion: boolean | null; min_price: number | null; category_id: string | null }[]) || []) {
          if (r.allow_discount === false) no[r.id] = r.name;
          if (r.min_price != null) mn[r.id] = Number(r.min_price);
          if (r.allow_promotion === false) np[r.id] = true;
        }
        setNoDiscount(no); setMinPrice(mn); setNoPromo(np);
      });
    supabase.rpc("apply_due_price_changes");
    supabase.from("product_uoms").select("*").eq("is_active", true)
      .order("factor").limit(5000)
      .then(({ data }) => {
        const by: Record<string, Uom[]> = {};
        for (const u of ((data as Uom[]) || [])) (by[u.product_id] ||= []).push(u);
        setUoms(by);
      });
  }, []);

  // Offers are decided by merchandising and only read here, so a promo that
  // starts tomorrow simply is not in this list today.
  // The database prices the cart. The till only shows what it is told, so the
  // screen and the receipt can never disagree.
  const [promoLines, setPromoLines] = useState<Record<string, { amount: number; promotion_id: string; name: string; free?: boolean }>>({});
  const [promoNames, setPromoNames] = useState<string[]>([]);
  const cartKey = cart.map((c) => `${c.key}:${c.qty}:${c.price}`).join("|");

  useEffect(() => {
    if (!storeId || cart.length === 0) { setPromoLines({}); setPromoNames([]); return; }
    let live = true;
    supabase.rpc("price_cart", {
      p_store: storeId,
      p_items: cart.map((c, i) => ({
        line: i, product_id: c.product_id, variant_id: c.variant_id,
        qty: c.qty * (c.factor ?? 1),
        unit_price: c.price / (c.factor ?? 1),
      })),
      p_date: yangonToday(),
    }).then(({ data }) => {
      if (!live) return;
      const res = data as {
        lines: { line: number; promo_discount: number; promotion_id: string | null; is_free_gift: boolean }[];
        names: string[];
        gifts?: { product_id: string; qty: number; promotion_id: string; name: string }[];
      } | null;

      // A gift the basket has earned but does not hold yet. Put it in, so the
      // customer leaves with what the poster promised rather than with what
      // the queue remembered to ask for.
      for (const g of res?.gifts || []) {
        const sellable = items.find(
          (i) => i.product_id === g.product_id && !i.variant_id
        );
        if (!sellable) continue;
        if (cart.some((c) => c.key === sellable.key)) continue;
        if (sellable.stock_qty <= 0) continue;
        addToCart(sellable);
        showToast(`\u{1f381} ${sellable.display_name} \u2014 ${g.name}`);
        return;
      }
      const out: Record<string, { amount: number; promotion_id: string; name: string; free?: boolean }> = {};
      for (const l of res?.lines || []) {
        const c = cart[l.line];
        if (!c || !l.promotion_id || Number(l.promo_discount) <= 0) continue;
        out[c.key] = {
          amount: Number(l.promo_discount), promotion_id: l.promotion_id,
          name: "", free: l.is_free_gift,
        };
      }
      setPromoLines(out);
      setPromoNames(res?.names || []);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, storeId]);

  const promoTotal = Object.values(promoLines).reduce((n, x) => n + x.amount, 0);

  // Stock is kept in base units, so a unit change only alters what one line
  // costs and how many base units it stands for.
  function setLineUom(key: string, code: string) {
    setCart((old) => old.map((c) => {
      if (c.key !== key) return c;
      const base = c.base_price ?? c.price / (c.factor ?? 1);
      const list = uoms[c.product_id] || [];
      const u = list.find((x) => x.code === code);
      if (!u) return { ...c, base_price: base, uom_code: undefined, uom_name: undefined, factor: 1, price: base };
      const f = Number(u.factor) || 1;
      return {
        ...c, base_price: base, uom_code: u.code, uom_name: u.name, factor: f,
        price: u.price != null ? Number(u.price) : base * f,
      };
    }));
  }


  // A discount on one line, for the haggling that happens item by item. The
  // invoice-level discount still applies on top, and the server checks both.
  function setLineDiscount(key: string, raw: string) {
    const pct = /%\s*$/.test(raw);
    const n = Number(String(raw).replace(/%/g, "").trim());
    setCart((old) => old.map((c) => {
      if (c.key !== key) return c;
      const cap = c.price * c.qty - (promoLines[c.key]?.amount ?? 0);
      const asked = pct ? Math.round((Math.max(cap, 0) * n) / 100) : n;
      return { ...c, line_discount: raw === "" || !(n > 0) ? 0 : Math.min(asked, Math.max(cap, 0)) };
    }));
  }

  // ---- Calculations ----
  const grossTotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const lineDiscountTotal = cart.reduce((sum, c) => sum + (c.line_discount ?? 0), 0);
  const subtotal = Math.max(grossTotal - promoTotal - lineDiscountTotal, 0);
  const discountValueNum = Number(discountValue) || 0;
  const discountAmount =
    discountType === "percent" ? (subtotal * discountValueNum) / 100 : discountValueNum;
  const canApproveDiscount =
    profile?.role === "sale_manager" || profile?.role === "admin" || profile?.role === "owner";
  // A loyalty tier sets the discount automatically. For non-manager staff the
  // field is locked to that rate: no approval needed, but no editing either.
  const loyaltyPercent = tierDiscountPercent(loyaltyTiers, selectedCustomer?.loyalty_tier_id);
  const isLoyaltyLocked = loyaltyPercent > 0 && !canApproveDiscount;
  // Manual discounts (no loyalty tier) still need a manager to sign off.
  // A single no-discount item locks the whole invoice's discount field.
  const lockedNames = cart.map((c) => noDiscount[c.product_id]).filter(Boolean);
  const discountLocked = lockedNames.length > 0;
  // Whether a manual discount needs a manager's PIN is the shop's own choice,
  // kept in store_settings so admin can switch it back on without a deploy.
  const requiresDiscountApproval =
    !!storeSettings?.require_discount_approval &&
    !isLoyaltyLocked && discountAmount + lineDiscountTotal > 0 && !canApproveDiscount;

  const effectiveDiscount = discountLocked
    ? 0
    : isLoyaltyLocked
    ? (subtotal * loyaltyPercent) / 100
    : Math.min(discountAmount, subtotal);
  // After the discount, no line may fall under its floor price.
  const ratio = subtotal > 0 ? effectiveDiscount / subtotal : 0;
  const underFloor = cart.filter((c) => {
    const floor = minPrice[c.product_id];
    if (floor == null) return false;
    const net = (c.price * c.qty - (promoLines[c.key]?.amount ?? 0) - (c.line_discount ?? 0)) / c.qty;
    return net * (1 - ratio) < floor;
  });
  const afterDiscount = Math.max(subtotal - effectiveDiscount, 0);
  const vatPercentNum = vatEnabled ? STANDARD_VAT_PERCENT : 0;
  const vatAmount = (afterDiscount * vatPercentNum) / 100;
  const beforeRounding = afterDiscount + vatAmount;
  const roundToNum = Math.min(Math.max(Number(roundTo) || 0, 0), 100000);
  const grandTotal =
    roundToNum > 0 ? Math.round(beforeRounding / roundToNum) * roundToNum : beforeRounding;
  const roundingAdj = grandTotal - beforeRounding;


  const thisStore = stores.find((x) => x.id === storeId);
  const storeAllowsCredit = !!thisStore?.allow_credit_sale;
  // Cash on delivery belongs to the online branches. A showroom hands the
  // goods over at the counter, so there is nothing to collect later.
  const storeAllowsCod = !!thisStore?.allow_cod;
  const visibleMethods = storeAllowsCod
    ? paymentMethods
    : paymentMethods.filter((m) => !m.is_cod);

  // The saved choice may not be on offer at this branch; fall back rather than
  // checking out with a method the shop cannot take.
  const methodCode = visibleMethods.some((m) => m.code === paymentMethod)
    ? paymentMethod
    : visibleMethods[0]?.code || "cash";
  const selectedMethod = visibleMethods.find((m) => m.code === methodCode);
  const isCashMethod = selectedMethod?.is_cash ?? false;
  const isCodMethod = selectedMethod?.is_cod ?? false;

  const amountReceivedNum = Number(amountReceived) || 0;
  const change = isCashMethod ? Math.max(amountReceivedNum - grandTotal, 0) : 0;

  const paidNowNum = Number(paidNow) || 0;
  const creditBalance = creditSale ? Math.max(grandTotal - paidNowNum, 0) : 0;

  const advancePaymentNum = Number(advancePayment) || 0;
  const codOverpaid = isCodMethod && advancePaymentNum > grandTotal;
  const balanceDue = isCodMethod ? Math.max(grandTotal - advancePaymentNum, 0) : 0;
  const codChange = codOverpaid ? advancePaymentNum - grandTotal : 0;

  const splitSum = splitLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const splitLeft = grandTotal - splitSum;

  const canCheckout =
    cart.length > 0 &&
    (!creditSale || (!!selectedCustomer && paidNowNum <= grandTotal)) &&
    (splitting || creditSale || !isCashMethod || amountReceivedNum >= grandTotal) &&
    (!splitting || Math.abs(splitLeft) < 0.01) &&
    (!requiresDiscountApproval || discountApproved);

  // A greyed-out button explains nothing, and a cashier with a queue in front
  // of them should not have to guess which field is holding it up.
  const blockedReason =
    cart.length === 0
      ? ""
      : !splitting && !creditSale && isCashMethod && amountReceivedNum < grandTotal
      ? t("pos_amountInsufficient")
      : splitting && Math.abs(splitLeft) > 0.01
      ? `${t("pos_grandTotal")}: ${fmt(grandTotal)}`
      : creditSale && !selectedCustomer
      ? "A sale with a balance owing needs a customer"
      : creditSale && paidNowNum > grandTotal
      ? "Paid now is more than the bill"
      : requiresDiscountApproval && !discountApproved
      ? t("pos_discountApprovalRequired")
      : "";

  async function checkout() {
    if (cart.length === 0) return;
    if (!splitting && !creditSale && isCashMethod && amountReceivedNum < grandTotal) {
      return showToast(t("pos_amountInsufficient"));
    }
    const short = cart.filter((c) => c.qty * (c.factor ?? 1) > c.stock_qty);
    if (short.length > 0) {
      return showToast("Not enough stock: " + short.map((c) => c.name).join(", "));
    }
    if (underFloor.length > 0 && !canApproveDiscount) {
      return showToast("Below minimum price: " + underFloor.map((c) => c.name).join(", "));
    }
    if (requiresDiscountApproval && !discountApproved) {
      return showToast(t("pos_discountApprovalRequired"));
    }
    setLoading(true);
    try {
      // One key per attempt at THIS cart. A retry after a timeout reuses it,
      // so the server returns the original sale instead of creating a second.
      const idempotencyKey =
        idempotencyKeyRef.current ?? (idempotencyKeyRef.current = crypto.randomUUID());

      const { data: rpcRows, error: rpcErr } = await supabase.rpc("checkout_sale", {
        p_idempotency_key: idempotencyKey,
        p_store_id: storeId,
        p_items: cart.map((c) => ({
          product_id: c.product_id,
          variant_id: c.variant_id,
          product_name: c.name,
          qty: c.qty * (c.factor ?? 1),
          unit_price: c.price / (c.factor ?? 1),
          uom_code: c.uom_code ?? null,
          uom_name: c.uom_name ?? null,
          uom_qty: c.qty,
          uom_factor: c.factor ?? 1,
          line_discount: c.line_discount ?? 0,
          promo_discount: promoLines[c.key]?.amount ?? 0,
          promotion_id: promoLines[c.key]?.promotion_id ?? null,
          is_free_gift: promoLines[c.key]?.free ?? false,
        })),
        p_payment: {
          payment_method: splitting ? (splitLines[0]?.method || methodCode) : methodCode,
          is_cod: isCodMethod,
          credit_sale: creditSale,
          discount_type: discountType,
          discount_value: discountValueNum,
          discount_amount: effectiveDiscount,
          discount_approved_by: discountApprovedBy,
          approval_pin: approvedPin,
          approval_request: approvalRequest,
          vat_percent: vatPercentNum,
          round_to: roundToNum,
          amount_received: splitting ? grandTotal : (isCashMethod ? amountReceivedNum : grandTotal),
          advance_payment: creditSale ? paidNowNum : (isCodMethod ? advancePaymentNum : 0),
          note: note.trim() || null,
          customer_id: selectedCustomer?.id || null,
          customer_name: selectedCustomer?.name || customerSearch.trim() || null,
          sale_rep_id: saleRepId || null,
          sale_rep_name: salesReps.find((r) => r.id === saleRepId)?.name || null,
        },
      });
      if (rpcErr) throw rpcErr;

      const sale = rpcRows?.[0];
      if (!sale) throw new Error("Checkout returned no sale");

      // Committed - this cart is done with its key.
      idempotencyKeyRef.current = null;

      // Tell the server how the money actually came in. It refuses the
      // lines unless they add up to what was due.
      const payLines = splitting
        ? splitLines
            .filter((l) => Number(l.amount) > 0)
            .map((l) => ({ method: l.method, amount: Number(l.amount) }))
        : [{ method: methodCode,
             amount: creditSale ? paidNowNum
                   : isCodMethod ? advancePaymentNum : grandTotal }];
      if (payLines.length > 0 && payLines[0].amount > 0) {
        const { error: payErr } = await supabase.rpc("record_sale_payments", {
          p_sale_id: sale.sale_id,
          p_lines: payLines,
        });
        if (payErr) showToast("\u26a0\ufe0f " + payErr.message);
      }

      setReceiptData({
        storeId,
        businessName: storeSettings?.business_name || null,
        phone: storeSettings?.phone || null,
        address: storeSettings?.address || null,
        footerText: storeSettings?.receipt_footer || null,
        logoText: storeSettings?.logo_text || null,
        saleRef: sale.sale_ref,
        createdAt: sale.created_at,
        items: cart.map((c) => ({
          unit: c.uom_name ?? null,
          name: c.name,
          qty: c.qty,
          price: c.price,
          lineTotal: c.price * c.qty - (c.line_discount ?? 0),
        })),
        subtotal,
        promoDiscount: promoTotal,
        promoLabel: Array.from(
          new Set(
            (promoNames as unknown[])
              .map((x) => (typeof x === "string" ? x : ((x as any)?.name ?? "")))
              .filter(Boolean)
          )
        ).join(", "),
        lineDiscount: lineDiscountTotal,
        discountLabel: isLoyaltyLocked
          ? `${loyaltyPercent}%`
          : discountType === "percent"
          ? `${discountValueNum}%`
          : fmt(effectiveDiscount),
        discountAmount: effectiveDiscount,
        vatPercent: vatPercentNum,
        vatAmount,
        roundingAdjustment: roundingAdj,
        grandTotal,
        paymentMethod: splitting
          ? "Split"
          : selectedMethod?.name || methodCode,
        paymentLines: splitting
          ? payLines.map((l) => ({
              method: visibleMethods.find((m) => m.code === l.method)?.name || l.method,
              amount: l.amount,
            }))
          : undefined,
        amountReceived: amountReceivedNum,
        change: paymentMethod === "cod" ? codChange : change,
        advancePayment: advancePaymentNum,
        balanceDue,
        note: note.trim(),
        customerName: selectedCustomer?.name || customerSearch.trim() || "",
        cashierEmail: profile?.email || "",
      });

      showToast(`${t("pos_saleSuccess")} ${fmt(grandTotal)}`);
      resetOrder();
      // The shelf count is already right in the database. Refreshing it here
      // is for the next customer, so it must not hold up this one's slip.
      void loadProducts();

      // @page can't be scoped by a CSS class, so the thermal-roll page size is
      // injected only for this print and removed afterwards â otherwise every
      // other document (like a purchase order) would print on 80mm paper too.
      setTimeout(() => {
        const style = document.createElement("style");
        style.id = "receipt-page-size";
        style.textContent = "@page { size: 80mm auto; margin: 0; }";
        document.head.appendChild(style);
        window.print();
        setTimeout(() => style.remove(), 500);
      }, 300);
    } catch (err) {
      // A Supabase error is a plain object, not an Error, so String() on it
      // gives "[object Object]" and hides the reason the sale was refused.
      const e = err as { message?: string; hint?: string; details?: string };
      const message =
        err instanceof Error ? err.message
        : e?.message || e?.details || e?.hint || JSON.stringify(err);
      showToast("â " + message);
    } finally {
      setLoading(false);
    }
  }

  if (profile && !hasPermission(profile, "pos")) return null;

  return (
    <div className="pt-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px] gap-4">
      <div>
        <input
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
          placeholder={t("pos_search")}
          value={search}
          onChange={(e) => {
            const value = e.target.value;
            setSearch(value);
            scanned(value);
          }}
        />

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            <button
              onClick={() => setCategoryFilter("all")}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium ${
                categoryFilter === "all" ? "bg-blue-600 text-white" : "bg-white border border-slate-200 text-slate-600"
              }`}
            >
              {t("pos_allCategories")}
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategoryFilter(c.id)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium ${
                  categoryFilter === c.id ? "bg-blue-600 text-white" : "bg-white border border-slate-200 text-slate-600"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {visibleGroups.map(([productId, g]) => {
            const hasVariants = g.items.some((i) => i.variant_id !== null);
            const totalStock = g.items.reduce((s, i) => s + i.stock_qty, 0);
            const prices = g.items.map((i) => i.price);
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);
            return (
              <button
                key={productId}
                onClick={() => handleProductClick(productId)}
                className={`text-left bg-white border border-slate-200 rounded-xl p-3 hover:shadow-md hover:-translate-y-0.5 transition ${
                  totalStock <= 5 ? "border-red-300" : ""
                }`}
              >
                <div className="font-semibold text-sm">
                  {g.productName}
                  {hasVariants && (
                    <span className="ml-1 text-[10px] text-blue-600 font-medium">
                      {g.items.length} {t("pos_variantCount")}
                    </span>
                  )}
                </div>
                <div className="text-blue-600 font-bold text-sm">
                  {minPrice === maxPrice ? fmt(minPrice) : `${fmt(minPrice)} â ${fmt(maxPrice)}`}
                </div>
                <div className={`text-xs mt-1 ${totalStock <= 5 ? "text-red-600" : "text-slate-500"}`}>
                  {t("pos_stock")}: {totalStock}
                </div>
              </button>
            );
          })}
          {filteredGroups.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-8">
              {t("pos_noProduct")}
            </div>
          )}
          {hiddenCount > 0 && (
            <div className="col-span-full text-center text-slate-400 text-xs py-4">
              <span className="inline-flex items-center gap-3">
                <button type="button" onClick={() => setPage((n) => Math.max(0, n - 1))}
                  disabled={atPage === 0}
                  className="px-2 py-1 border border-slate-200 rounded disabled:opacity-30">â¹</button>
                <span>{atPage + 1} / {pageCount}</span>
                <button type="button" onClick={() => setPage((n) => Math.min(pageCount - 1, n + 1))}
                  disabled={atPage >= pageCount - 1}
                  className="px-2 py-1 border border-slate-200 rounded disabled:opacity-30">âº</button>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-24">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">{t("pos_cart")}</h3>
          {cart.length > 0 && (
            <button
              onClick={holdOrder}
              className="text-xs font-semibold border border-slate-200 rounded-lg px-2 py-1"
            >
              Park this
            </button>
          )}
        </div>

        <div className="mb-3">
          <button
            type="button"
            onClick={async () => {
              showToast("Syncing...");
              await loadProducts();
              showToast("Prices and stock are up to date");
            }}
            className="text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-600"
          >
            Sync prices &amp; stock
          </button>
        </div>

        {held.length > 0 && (
          <div className="mb-3 border border-amber-200 bg-amber-50 rounded-lg p-2">
            <div className="text-[11px] text-amber-800 font-medium mb-1">
              Parked ({held.length})
            </div>
            <div className="space-y-1">
              {held.map((h) => (
                <div key={h.id} className="flex items-center gap-2">
                  <button
                    onClick={() => resumeOrder(h)}
                    className="flex-1 text-left text-xs bg-white border border-amber-200 rounded px-2 py-1"
                  >
                    <span className="font-medium">{h.label}</span>
                    <span className="text-slate-500">
                      {" "}
                      &middot; {h.cart.length} item(s) &middot;{" "}
                      {fmt(h.cart.reduce((n, c) => n + c.price * c.qty, 0))}
                    </span>
                  </button>
                  <button
                    onClick={() => dropHeld(h.id)}
                    className="text-[11px] text-red-600 px-1"
                    title="Throw this basket away"
                  >
                    â
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {cart.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-6">{t("pos_emptyCart")}</div>
        ) : (
          <div className="space-y-2 mb-3">
            {cart.map((c) => (
              <div
                key={c.key}
                className="flex justify-between items-center border-b border-slate-100 pb-2 text-sm"
              >
                <div>
                  <div>{c.name}</div>
                  <div className="text-slate-400">{fmt(c.price)}</div>
                  {(uoms[c.product_id]?.length ?? 0) > 1 && (
                    <select
                      className="mt-1 border border-slate-200 rounded px-1 py-0.5 text-xs"
                      value={c.uom_code ?? ""}
                      onChange={(e) => setLineUom(c.key, e.target.value)}
                    >
                      {uoms[c.product_id].map((u) => (
                        <option key={u.id} value={u.code}>
                          {u.name} {Number(u.factor) > 1 ? `(${u.factor})` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {!noDiscount[c.product_id] && (
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-[10px] text-slate-400">-</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="w-16 border border-slate-200 rounded px-1 py-0.5 text-xs text-right"
                        placeholder="0"
                        value={lineRaw[c.key] ?? (c.line_discount ? String(c.line_discount) : "")}
                        onChange={(e) => {
                          const v = e.target.value;
                          setLineRaw((m) => ({ ...m, [c.key]: v }));
                          setLineDiscount(c.key, lineMode[c.key] === "pct" ? v + "%" : v);
                        }}
                      />
                      <select
                        className="border border-slate-200 rounded px-1 py-0.5 text-xs"
                        value={lineMode[c.key] || "mmk"}
                        onChange={(e) => {
                          const mode = e.target.value;
                          setLineMode((m) => ({ ...m, [c.key]: mode }));
                          const v = lineRaw[c.key] ?? "";
                          setLineDiscount(c.key, mode === "pct" ? v + "%" : v);
                        }}
                      >
                        <option value="mmk">MMK</option>
                        <option value="pct">%</option>
                      </select>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="w-6 h-6 border border-slate-200 rounded"
                    onClick={() => changeQty(c.key, -1)}
                  >
                    -
                  </button>
                  <span>{c.qty}</span>
                  <button
                    className="w-6 h-6 border border-slate-200 rounded"
                    onClick={() => changeQty(c.key, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {cart.length > 0 && (
          <>
            {salesReps.length > 0 && (
              <div className="mb-2">
                <label className="text-xs text-slate-500">{t("pos_salesRep")}</label>
                <select
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  value={saleRepId}
                  onChange={(e) => setSaleRepId(e.target.value)}
                >
                  <option value="">{t("pos_salesRepNone")}</option>
                  {salesReps.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Customer */}
            <div className="mb-2">
              <label className="text-xs text-slate-500">{t("pos_customer")}</label>
              <div className="relative mt-1">
                <input
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                  placeholder={t("pos_customerSearchPlaceholder")}
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value);
                    setSelectedCustomer(null);
                    setShowCustomerDropdown(true);
                  }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
                />
                {showCustomerDropdown && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                    {customerSearch.trim() === "" && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(null);
                          setCustomerSearch("");
                          setShowCustomerDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 text-slate-400"
                      >
                        {t("pos_customerWalkIn")}
                      </button>
                    )}
                    {filteredCustomers.map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => {
                          setSelectedCustomer(c);
                          setCustomerSearch(c.name);
                          setShowCustomerDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        {c.name} {c.phone && <span className="text-slate-400">({c.phone})</span>}
                      </button>
                    ))}
                    {customerSearch.trim() !== "" && !exactCustomerMatch && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={quickAddCustomer}
                        className="w-full text-left px-3 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50"
                      >
                        {t("pos_customerAddNew").replace("{name}", customerSearch.trim())}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {customerSearch.trim() !== "" && !exactCustomerMatch && !selectedCustomer && (
                <input
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  placeholder={t("pos_customerPhone")}
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              )}
            </div>

            {/* Discount */}
            <div className="mb-2">
              <label className="text-xs text-slate-500">{t("pos_discount")}</label>
              {discountLocked && (
                <div className="text-xs text-red-600 mb-1">
                  No discount â {Array.from(new Set(lockedNames)).join(", ")}
                </div>
              )}
              {promoTotal > 0 && (
                <div className="text-xs text-green-700 mb-1">
                  Promo â{promoTotal.toLocaleString()} Â·{" "}
                  {promoNames.join(", ")}
                </div>
              )}
              {underFloor.length > 0 && (
                <div className="text-xs text-amber-700 mb-1">
                  Below min price: {underFloor.map((c) => c.name).join(", ")}
                </div>
              )}
              {tierDiscountPercent(loyaltyTiers, selectedCustomer?.loyalty_tier_id) > 0 && (
                <p className="text-xs text-green-600 font-medium mt-0.5">
                  ðï¸ {t("customers_loyaltyApplied")} ({tierDiscountPercent(loyaltyTiers, selectedCustomer?.loyalty_tier_id)}%)
                </p>
              )}
              <div className="flex gap-1 mt-1">
                <input
                  type="number"
                  className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                  value={isLoyaltyLocked ? String(loyaltyPercent) : discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder="0"
                  disabled={isLoyaltyLocked || discountLocked}
                />
                <select
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                  value={isLoyaltyLocked ? "percent" : discountType}
                  onChange={(e) => setDiscountType(e.target.value as DiscountType)}
                  disabled={isLoyaltyLocked}
                >
                  <option value="flat">{t("pos_discountFlat")}</option>
                  <option value="percent">{t("pos_discountPercent")}</option>
                </select>
              </div>

              {isLoyaltyLocked && (
                <p className="text-xs text-green-600 mt-1">ð {t("pos_loyaltyLocked")}</p>
              )}

              {requiresDiscountApproval && (
                discountApproved ? (
                  <p className="text-xs text-green-600 font-medium mt-1">
                    â {t("pos_discountApprovedBy")} {discountApprovedBy}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowApprovalModal(true)}
                    className="mt-2 w-full py-1.5 bg-orange-500 text-white rounded-lg text-xs font-semibold"
                  >
                    ð {t("pos_getApproval")}
                  </button>
                )
              )}
            </div>

            {/* VAT */}
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs text-slate-500">
                {t("pos_vatToggle")} ({STANDARD_VAT_PERCENT}%)
              </label>
              <button
                type="button"
                onClick={() => setVatEnabled((v) => !v)}
                className={`w-10 h-5 rounded-full transition relative ${
                  vatEnabled ? "bg-blue-600" : "bg-slate-200"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition ${
                    vatEnabled ? "left-5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            {/* Rounding */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="text-xs text-slate-500">Round to</label>
              <div className="flex items-center gap-1">
                {[50, 100, 500].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setRoundTo(roundToNum === v ? "" : String(v))}
                    className={`text-[11px] px-2 py-1 rounded border ${
                      roundToNum === v
                        ? "bg-slate-900 text-white border-slate-900"
                        : "border-slate-200"
                    }`}
                  >
                    {v}
                  </button>
                ))}
                <input
                  type="number"
                  className="w-16 border border-slate-200 rounded px-2 py-1 text-xs text-right"
                  placeholder="0"
                  value={roundTo}
                  onChange={(e) => setRoundTo(e.target.value)}
                />
              </div>
            </div>

            {/* Totals */}
            <div className="text-xs space-y-1 border-t border-slate-100 pt-2 mt-2">
              {lineDiscountTotal > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>Item discounts</span>
                  <span>-{fmt(lineDiscountTotal)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-500">
                <span>{t("pos_subtotal")}</span>
                <span>{fmt(subtotal)}</span>
              </div>
              {effectiveDiscount > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>{t("pos_discount")}</span>
                  <span>-{fmt(effectiveDiscount)}</span>
                </div>
              )}
              {vatAmount > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>VAT</span>
                  <span>{fmt(vatAmount)}</span>
                </div>
              )}
              {roundingAdj !== 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>Rounding</span>
                  <span>
                    {roundingAdj > 0 ? "+" : ""}
                    {fmt(roundingAdj)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex justify-between font-bold text-lg border-t-2 border-slate-900 mt-2 pt-2">
              <span>{t("pos_grandTotal")}</span>
              <span>{fmt(grandTotal)}</span>
            </div>

            {/* Payment method */}
            <div className="mt-3">
              <label className="text-xs text-slate-500">{t("pos_paymentMethod")}</label>
              <select
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={methodCode}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                {visibleMethods.map((m) => (
                  <option key={m.id} value={m.code}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2">
              <button
                className="text-xs text-blue-600 font-medium"
                onClick={() => {
                  if (splitting) { setSplitting(false); setSplitLines([]); return; }
                  setSplitting(true);
                  setSplitLines([{ method: paymentMethod, amount: String(grandTotal) }]);
                }}>
                {splitting ? "â One payment" : "+ Split payment"}
              </button>
            </div>

            {splitting && (
              <div className="mt-2 border border-slate-200 rounded-lg p-2">
                {splitLines.map((l, idx) => (
                  <div key={idx} className="flex gap-1 mb-1">
                    <select
                      className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                      value={l.method}
                      onChange={(ev) => setSplitLines((p) =>
                        p.map((x, k) => (k === idx ? { ...x, method: ev.target.value } : x)))}>
                      {visibleMethods.map((m) => (
                        <option key={m.id} value={m.code}>{m.name}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      className="w-28 border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-right"
                      value={l.amount}
                      onChange={(ev) => setSplitLines((p) =>
                        p.map((x, k) => (k === idx ? { ...x, amount: ev.target.value } : x)))} />
                    {splitLines.length > 1 && (
                      <button className="text-slate-400 text-xs px-1"
                        onClick={() => setSplitLines((p) => p.filter((_, k) => k !== idx))}>
                        â
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="text-xs text-blue-600 font-medium"
                  onClick={() => setSplitLines((p) => [
                    ...p,
                    { method: paymentMethods.find((m) => m.code !== p[0]?.method)?.code
                        || methodCode,
                      amount: String(Math.max(grandTotal - p.reduce(
                        (s, x) => s + (Number(x.amount) || 0), 0), 0)) },
                  ])}>
                  + Add
                </button>
                <div className={`flex justify-between text-xs mt-1 font-medium ${
                  Math.abs(splitLeft) < 0.01 ? "text-green-700" : "text-red-600"}`}>
                  <span>{Math.abs(splitLeft) < 0.01 ? "Balanced" : "Left"}</span>
                  <span>{fmt(splitLeft)}</span>
                </div>
              </div>
            )}

            {isCashMethod && !splitting && !creditSale && (
              <div className="mt-2">
                <label className="text-xs text-slate-500">{t("pos_amountReceived")}</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  value={amountReceived}
                  onChange={(e) => setAmountReceived(e.target.value)}
                  placeholder="0"
                />
                {amountReceivedNum > 0 && (
                  <div className="flex justify-between text-xs mt-1 text-green-700 font-medium">
                    <span>{t("pos_change")}</span>
                    <span>{fmt(change)}</span>
                  </div>
                )}
              </div>
            )}

            {storeAllowsCredit && !isCodMethod && (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={creditSale}
                    onChange={(e) => { setCreditSale(e.target.checked); setPaidNow(""); }} />
                  <span className="text-xs font-medium">Partial payment (balance later)</span>
                </label>
                {creditSale && (
                  <>
                    <input
                      type="number"
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-2"
                      value={paidNow}
                      onChange={(e) => setPaidNow(e.target.value)}
                      placeholder="Paid now"
                    />
                    <div className="flex justify-between text-xs mt-1 text-orange-600 font-medium">
                      <span>{t("pos_balanceDue")}</span>
                      <span>{fmt(creditBalance)}</span>
                    </div>
                    {!selectedCustomer && (
                      <div className="text-[11px] text-red-600 mt-1">
                        Pick the customer who owes this.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {isCodMethod && (
              <div className="mt-2">
                <label className="text-xs text-slate-500">{t("pos_advancePayment")}</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                  value={advancePayment}
                  onChange={(e) => setAdvancePayment(e.target.value)}
                  placeholder="0"
                />
                <div className="flex justify-between text-xs mt-1 text-orange-600 font-medium">
                  <span>{t("pos_balanceDue")}</span>
                  <span>{fmt(balanceDue)}</span>
                </div>
                {codOverpaid && (
                  <div className="flex justify-between text-xs mt-1 text-green-700 font-medium">
                    <span>{t("pos_change")}</span>
                    <span>{fmt(codChange)}</span>
                  </div>
                )}
              </div>
            )}

            {/* Note */}
            <div className="mt-2">
              <label className="text-xs text-slate-500">{t("pos_note")}</label>
              <textarea
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("pos_notePlaceholder")}
              />
            </div>
          </>
        )}

        <button
          onClick={checkout}
          disabled={!canCheckout || loading}
          className="w-full mt-3 py-3 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold"
        >
          {loading ? t("pos_processing") : t("pos_checkout")}
        </button>
        {blockedReason && !loading && (
          <p className="mt-2 text-center text-xs text-amber-600">{blockedReason}</p>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}

      {variantPickerProductId && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
          onClick={() => setVariantPickerProductId(null)}
        >
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-lg mb-1">
              {productGroups.get(variantPickerProductId)?.productName}
            </h3>
            <p className="text-sm text-slate-500 mb-4">{t("pos_chooseVariant")}</p>

            <div className="space-y-2 max-h-72 overflow-y-auto">
              {(productGroups.get(variantPickerProductId)?.items || []).map((v) => {
                const soldOut = v.stock_qty <= 0;
                return (
                  <button
                    key={v.key}
                    onClick={() => addToCart(v)}
                    disabled={soldOut}
                    className={`w-full flex justify-between items-center border rounded-lg px-4 py-3 text-sm ${
                      soldOut
                        ? "border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed"
                        : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-left">
                      <span className="font-medium">{v.variant_name}</span>
                      <span className={`block text-xs ${soldOut ? "text-red-300" : "text-slate-400"}`}>
                        {t("pos_stock")}: {v.stock_qty}
                      </span>
                    </span>
                    <span className={soldOut ? "font-bold" : "text-blue-600 font-bold"}>{fmt(v.price)}</span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setVariantPickerProductId(null)}
              className="w-full mt-4 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
            >
              {t("products_cancel")}
            </button>
          </div>
        </div>
      )}

      {showApprovalModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("pos_approvalTitle")}</h3>
            <p className="text-sm text-slate-500 mb-4">{t("pos_approvalSubtitle")}</p>

            <div className="flex border border-slate-200 rounded-lg overflow-hidden text-xs mb-4">
              <button
                type="button"
                onClick={() => {
                  setApprovalMode("pin");
                  setApproverError("");
                }}
                className={`flex-1 py-2 ${approvalMode === "pin" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
              >
                {t("pos_pinMethod")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setApprovalMode("password");
                  setApproverError("");
                }}
                className={`flex-1 py-2 ${approvalMode === "password" ? "bg-blue-600 text-white" : "bg-white text-slate-500"}`}
              >
                Ask the manager
              </button>
            </div>

            {approvalMode === "pin" ? (
              <>
                <label className="text-sm text-slate-600">{t("myPin_title")}</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  maxLength={6}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-lg tracking-widest text-center mt-1 mb-2"
                  value={approverPin}
                  onChange={(e) => setApproverPin(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && submitDiscountApproval()}
                  placeholder="â¢â¢â¢â¢"
                />
              </>
            ) : (
              <>
                <p className="text-sm text-slate-600 mb-3">
                  {fmt(discountAsked())} off this sale. The request goes to
                  whoever approves for this shop, and the sale continues as
                  soon as they answer.
                </p>
                {requestState === "waiting" ? (
                  <p className="text-sm text-blue-700 mb-2">
                    Sent. Waiting for an answer...
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={approving}
                    onClick={askTheManager}
                    className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 mb-2"
                  >
                    Send the request
                  </button>
                )}
              </>
            )}
            {approverError && <p className="text-red-600 text-xs mb-2">{approverError}</p>}

            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  setShowApprovalModal(false);
                  setApproverError("");
                }}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button
                onClick={submitDiscountApproval}
                disabled={
                  approving ||
                  (approvalMode === "pin" ? approverPin.length < 4 : !approverEmail || !approverPassword)
                }
                className="flex-1 py-2.5 bg-orange-500 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {approving ? "..." : t("pos_approve")}
              </button>
            </div>
          </div>
        </div>
      )}

      <Receipt data={receiptData} />
    </div>
  );
}
