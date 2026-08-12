"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase, StoreRow } from "@/lib/supabase";

type StoreContextType = {
  storeId: string;
  setStoreId: (id: string) => void;
  stores: StoreRow[];
  refreshStores: () => Promise<void>;
};

const StoreContext = createContext<StoreContextType | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [storeId, setStoreId] = useState("");
  const [stores, setStores] = useState<StoreRow[]>([]);

  async function refreshStores() {
    const { data } = await supabase.from("stores").select("*").order("name");
    setStores(data || []);
    if (data && data.length > 0 && !storeId) {
      setStoreId(data[0].id);
    }
  }

  useEffect(() => {
    refreshStores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <StoreContext.Provider value={{ storeId, setStoreId, stores, refreshStores }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
