"use client";

// Registering a customer is a counter job with real paperwork behind it —
// the card, the children, who brought them in — so it gets a page of its own
// rather than a dialog the cashier has to scroll inside.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, LoyaltyTier } from "@/lib/supabase";
import { useStore } from "../../store-context";
import { useAuth } from "../../auth-context";
import { useLanguage } from "../../language-context";
import { hasPermission } from "../../permissions";

type Child = { name: string; date_of_birth: string };
type Found = { id: string; name: string; phone: string | null };

// Myanmar numbers are written a dozen ways; the file keeps one.
function normalisePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (!d) return null;
  let n = d;
  if (n.startsWith("0095")) n = n.slice(4);
  if (n.startsWith("95") && n.length >= 11) n = n.slice(2);
  n = n.replace(/^0+/, "");
  if (!n.startsWith("9") || n.length < 7 || n.length > 10) return null;
  return "+95" + n;
}

export default function NewCustomerPage() {
  const { profile } = useAuth();
  const { storeId } = useStore();
  const { t } = useLanguage();
  const router = useRouter();

  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [address, setAddress] = useState("");
  const [facebook, setFacebook] = useState("");
  const [tiktok, setTiktok] = useState("");
  const [tierId, setTierId] = useState("");
  const [children, setChildren] = useState<Child[]>([{ name: "", date_of_birth: "" }]);

  const [refSearch, setRefSearch] = useState("");
  const [refHits, setRefHits] = useState<Found[]>([]);
  const [referrer, setReferrer] = useState<Found | null>(null);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "customers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    supabase.from("loyalty_tiers").select("*").order("sort_order")
      .then(({ data }) => setTiers((data as LoyaltyTier[]) || []));
  }, []);

  function say(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function findReferrer() {
    const q = refSearch.trim();
    if (!q) return;
    const { data } = await supabase
      .from("customers").select("id, name, phone")
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(10);
    setRefHits((data as Found[]) || []);
  }

  function setChild(i: number, patch: Partial<Child>) {
    setChildren((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  async function save() {
    if (!name.trim()) return say("Name is required");
    const ph = phone.trim() ? normalisePhone(phone) : null;
    if (phone.trim() && !ph) return say("That phone number does not look like a Myanmar number");

    setSaving(true);
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: name.trim(),
        phone: ph,
        email: email.trim() || null,
        date_of_birth: dob || null,
        delivery_address: address.trim() || null,
        facebook: facebook.trim() || null,
        tiktok: tiktok.trim() || null,
        loyalty_tier_id: tierId || null,
        store_id: storeId,
      })
      .select("id")
      .single();

    if (error || !data) {
      setSaving(false);
      return say("❌ " + (error?.message || "could not save"));
    }
    const newId = (data as { id: string }).id;

    const kids = children
      .filter((c) => c.name.trim() || c.date_of_birth)
      .map((c) => ({ customer_id: newId, name: c.name.trim() || null, date_of_birth: c.date_of_birth || null }));
    if (kids.length) await supabase.from("customer_children").insert(kids);

    if (referrer) {
      await supabase.from("customer_referrals").insert({ referrer_id: referrer.id, referee_id: newId });
    }

    setSaving(false);
    router.push(`/customers/${newId}`);
  }

  if (!profile || !hasPermission(profile, "customers")) return null;

  const field = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";
  const label = "text-xs text-slate-500";

  return (
    <div className="pt-4 max-w-3xl">
      <Link href="/customers" className="text-sm text-blue-600 mb-2 inline-block">
        ← {t("nav_customers")}
      </Link>
      <h1 className="text-xl font-bold mb-4">New customer</h1>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-3">
        <div className="font-medium mb-3">Contact</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className={label}>Name *</div>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className={label}>Phone</div>
            <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)}
                   placeholder="09… or +959…" />
            <div className="text-[11px] text-slate-400 mt-1">Saved as +959…, and no two customers may share one.</div>
          </div>
          <div>
            <div className={label}>Email</div>
            <input className={field} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div className={label}>Date of birth</div>
            <input type="date" className={field} value={dob} onChange={(e) => setDob(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <div className={label}>Address</div>
            <textarea className={field} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div>
            <div className={label}>Facebook</div>
            <input className={field} value={facebook} onChange={(e) => setFacebook(e.target.value)} />
          </div>
          <div>
            <div className={label}>TikTok</div>
            <input className={field} value={tiktok} onChange={(e) => setTiktok(e.target.value)} />
          </div>
        </div>
      </div>

      {/* The children are why this shop exists: their ages decide what to offer. */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-3">
        <div className="font-medium mb-1">Children</div>
        <p className="text-[11px] text-slate-400 mb-3">
          Name and birthday, so staff know what suits and when a birthday is coming.
        </p>
        {children.map((c, i) => (
          <div key={i} className="flex flex-wrap gap-2 mb-2">
            <input
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]"
              placeholder="Child's name"
              value={c.name}
              onChange={(e) => setChild(i, { name: e.target.value })}
            />
            <input
              type="date"
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-44"
              value={c.date_of_birth}
              onChange={(e) => setChild(i, { date_of_birth: e.target.value })}
            />
            {children.length > 1 && (
              <button
                onClick={() => setChildren((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-slate-400 px-2"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => setChildren((prev) => [...prev, { name: "", date_of_birth: "" }])}
          className="text-sm text-blue-600"
        >
          + another child
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-3">
        <div className="font-medium mb-3">Programmes</div>

        <div className="mb-4">
          <div className={label}>Member card</div>
          <select className={field + " sm:w-64"} value={tierId} onChange={(e) => setTierId(e.target.value)}>
            <option value="">None</option>
            {tiers.map((t2) => (
              <option key={t2.id} value={t2.id}>
                {t2.name} ({t2.discount_percent}%)
              </option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <div className={label}>Sticker card</div>
          <div className="text-sm mt-1">
            Everyone is on it — one sticker per 300,000 Ks bill, ten stickers for 10% off.
          </div>
        </div>

        <div>
          <div className={label}>Mom Love — who referred this customer</div>
          {referrer ? (
            <div className="text-sm mt-1">
              {referrer.name}
              <span className="text-slate-400"> · {referrer.phone || "no phone"}</span>
              <button onClick={() => setReferrer(null)} className="ml-3 text-xs text-slate-400">
                change
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mt-1">
                <input
                  className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-56"
                  placeholder="Referrer's name or phone"
                  value={refSearch}
                  onChange={(e) => setRefSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && findReferrer()}
                />
                <button onClick={findReferrer} className="border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  Find
                </button>
              </div>
              {refHits.length > 0 && (
                <div className="border border-slate-200 rounded-lg divide-y mt-2">
                  {refHits.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => { setReferrer(r); setRefHits([]); setRefSearch(""); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                    >
                      {r.name} <span className="text-slate-400">· {r.phone || "no phone"}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-2">
                The point reaches them once this customer has bought 50,000 Ks worth.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          disabled={saving}
          onClick={save}
          className="bg-green-600 text-white rounded-lg px-5 py-2.5 text-sm font-medium disabled:bg-slate-300"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <Link href="/customers" className="border border-slate-200 rounded-lg px-5 py-2.5 text-sm">
          Cancel
        </Link>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
