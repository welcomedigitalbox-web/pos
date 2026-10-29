"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase, StoreRow } from "@/lib/supabase";
import { useAuth } from "./auth-context";

// A till account sees its own shop and nothing else. Warehouse people move
// goods between branches, so they open on their own warehouse but may look
// anywhere; what they are allowed to release is still checked on the server.
const STORE_KEY = "edu.storeId";

const STORE_LOCKED_ROLES = ["cashier", "online_sale", "wholesale"];

type StoreContextType = {
  storeId: string;
  setStoreId: (id: string) => void;
  stores: StoreRow[];
  refreshStores: () => Promise<void>;
  isStoreLocked: boolean;
  warehouses: StoreRow[];
  defaultWarehouseId: string;
};

const StoreContext = createContext<StoreContextType | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [storeId, setStoreIdState] = useState("");
  const [stores, setStores] = useState<StoreRow[]>([]);

  const isStoreLocked = !!profile && STORE_LOCKED_ROLES.includes(profile.role);

  // Warehouses are just stores flagged as such, so a business can run several
  const warehouses = stores.filter((s) => s.is_warehouse);
  const defaultWarehouseId = warehouses[0]?.id || "";

  async function refreshStores() {
    // The database decides which branches belong to this person; the
    // picker only shows them. If the call is unavailable for any reason
    // the old list is used, so nobody is locked out by a missing function.
    const mine = await supabase.rpc("my_store_list");
    const allowed = ((mine.data as { id: string }[]) || []).map((x) => x.id);
    let query = supabase.from("stores").select("*").eq("is_active", true).order("name");
    if (!mine.error && allowed.length > 0) query = query.in("id", allowed);
    const { data } = await query;

    setStores(data || []);

    // A locked account belongs to exactly one branch, and defaulting to the
    // first retail store here made pages read the wrong one until the profile
    // arrived - long enough for a cashier to see another branch's screen.
    if (isStoreLocked) return;

    // An office account picks a shop and then walks through ten pages.
    // Losing the choice on every one of them is how the wrong shop gets
    // counted, so the last pick is remembered on this browser.
    if (!storeId) {
      let saved: string | null = null;
      try { saved = localStorage.getItem(STORE_KEY); } catch { saved = null; }
      if (saved && (data || []).some((s) => s.id === saved)) {
        setStoreIdState(saved);
        return;
      }
    }

    // An account with a branch on its profile opens on that branch. An office
    // account has none, and guessing one for them is how stock gets counted
    // against the wrong shop - so it stays empty until a person picks.
    if (!storeId && profile?.store_id && (data || []).some((s) => s.id === profile.store_id)) {
      setStoreIdState(profile.store_id);
    }
  }

  useEffect(() => {
    refreshStores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // For cashier/online-sale/wholesale accounts, always pin the store to the one
  // assigned on their profile — they cannot switch stores.
  useEffect(() => {
    if (isStoreLocked && profile?.store_id) {
      setStoreIdState(profile.store_id);
    }
  }, [isStoreLocked, profile?.store_id]);

  function setStoreId(id: string) {
    if (isStoreLocked) return; // ignore attempts to change store for locked accounts
    setStoreIdState(id);
    try { localStorage.setItem(STORE_KEY, id); } catch { /* private window */ }
  }

  return (
    <StoreContext.Provider
      value={{ storeId, setStoreId, stores, refreshStores, isStoreLocked, warehouses, defaultWarehouseId }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
