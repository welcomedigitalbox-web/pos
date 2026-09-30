"use client";

// One form, used by both the new-supplier page and the edit page. Bank
// accounts and documents are edited alongside the supplier rather than behind
// a second dialog, because a supplier without its payment details is not
// usable and staff should not have to remember a second step.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "../language-context";

export type BankRow = {
  id?: string;
  bank_name: string;
  account_name: string;
  account_no: string;
  branch: string;
  currency: string;
  is_primary: boolean;
};

export type DocRow = {
  id?: string;
  title: string;
  doc_type: string;
  file_path: string | null;
  issued_on: string;
  expires_on: string;
  note: string;
  file?: File | null;
};

const emptyBank: BankRow = {
  bank_name: "", account_name: "", account_no: "", branch: "",
  currency: "MMK", is_primary: false,
};

const emptyDoc: DocRow = {
  title: "", doc_type: "dica", file_path: null,
  issued_on: "", expires_on: "", note: "", file: null,
};

const DOC_TYPES = ["dica", "licence", "contract", "price_list", "other"];

export default function SupplierForm({ supplierId }: { supplierId?: string }) {
  const router = useRouter();
  const { t } = useLanguage();

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!supplierId);
  const [toast, setToast] = useState("");

  const [form, setForm] = useState({
    name: "", company_name: "", dica_no: "", tax_no: "",
    contact_person: "", contact_phone: "", phone: "", email: "",
    website: "", address: "", payment_terms: "", note: "",
  });
  const [banks, setBanks] = useState<BankRow[]>([{ ...emptyBank, is_primary: true }]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [removedBanks, setRemovedBanks] = useState<string[]>([]);
  const [removedDocs, setRemovedDocs] = useState<string[]>([]);

  useEffect(() => {
    if (supplierId) loadExisting(supplierId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  async function loadExisting(id: string) {
    const [s, b, d] = await Promise.all([
      supabase.from("suppliers").select("*").eq("id", id).maybeSingle(),
      supabase.from("supplier_bank_accounts").select("*").eq("supplier_id", id)
        .order("is_primary", { ascending: false }).order("created_at"),
      supabase.from("supplier_documents").select("*").eq("supplier_id", id)
        .order("created_at"),
    ]);
    if (s.data) {
      const x = s.data as Record<string, string | null>;
      setForm({
        name: x.name || "", company_name: x.company_name || "",
        dica_no: x.dica_no || "", tax_no: x.tax_no || "",
        contact_person: x.contact_person || "", contact_phone: x.contact_phone || "",
        phone: x.phone || "", email: x.email || "", website: x.website || "",
        address: x.address || "", payment_terms: x.payment_terms || "",
        note: x.note || "",
      });
    }
    if (b.data?.length) {
      setBanks((b.data as BankRow[]).map((r) => ({
        id: r.id, bank_name: r.bank_name || "", account_name: r.account_name || "",
        account_no: r.account_no || "", branch: r.branch || "",
        currency: r.currency || "MMK", is_primary: !!r.is_primary,
      })));
    }
    if (d.data?.length) {
      setDocs((d.data as DocRow[]).map((r) => ({
        id: r.id, title: r.title || "", doc_type: r.doc_type || "other",
        file_path: r.file_path, issued_on: r.issued_on || "",
        expires_on: r.expires_on || "", note: r.note || "",
      })));
    }
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function setBank(i: number, patch: Partial<BankRow>) {
    setBanks((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  }

  // Exactly one account can be primary, so choosing one clears the rest.
  function makePrimary(i: number) {
    setBanks((rows) => rows.map((r, n) => ({ ...r, is_primary: n === i })));
  }

  function removeBank(i: number) {
    setBanks((rows) => {
      const row = rows[i];
      if (row.id) setRemovedBanks((x) => [...x, row.id as string]);
      const left = rows.filter((_, n) => n !== i);
      // Never leave the set without a primary.
      if (left.length && !left.some((r) => r.is_primary)) left[0].is_primary = true;
      return left;
    });
  }

  function setDoc(i: number, patch: Partial<DocRow>) {
    setDocs((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  }

  function removeDoc(i: number) {
    setDocs((rows) => {
      const row = rows[i];
      if (row.id) setRemovedDocs((x) => [...x, row.id as string]);
      return rows.filter((_, n) => n !== i);
    });
  }

  async function openDoc(path: string) {
    const { data } = await supabase.storage
      .from("supplier-docs").createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    else showToast("❌ file not found");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return showToast(t("customers_nameRequired"));

    const filled = banks.filter((b) => b.bank_name.trim() || b.account_no.trim());
    if (filled.length && !filled.some((b) => b.is_primary)) filled[0].is_primary = true;

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        company_name: form.company_name.trim() || null,
        dica_no: form.dica_no.trim() || null,
        tax_no: form.tax_no.trim() || null,
        contact_person: form.contact_person.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        website: form.website.trim() || null,
        address: form.address.trim() || null,
        payment_terms: form.payment_terms.trim() || null,
        note: form.note.trim() || null,
      };

      let id = supplierId;
      if (id) {
        const { error } = await supabase.from("suppliers").update(payload).eq("id", id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("suppliers")
          .insert(payload).select("id").single();
        if (error) throw error;
        id = data.id as string;
      }

      if (removedBanks.length)
        await supabase.from("supplier_bank_accounts").delete().in("id", removedBanks);
      if (removedDocs.length)
        await supabase.from("supplier_documents").delete().in("id", removedDocs);

      // The primary flag is unique per supplier, so the old rows are cleared
      // before the new set goes in — otherwise the index rejects the write.
      await supabase.from("supplier_bank_accounts")
        .update({ is_primary: false }).eq("supplier_id", id);

      for (const b of filled) {
        const row = {
          supplier_id: id,
          bank_name: b.bank_name.trim(),
          account_name: b.account_name.trim() || null,
          account_no: b.account_no.trim() || null,
          branch: b.branch.trim() || null,
          currency: b.currency || "MMK",
          is_primary: b.is_primary,
        };
        if (b.id) await supabase.from("supplier_bank_accounts").update(row).eq("id", b.id);
        else await supabase.from("supplier_bank_accounts").insert(row);
      }

      for (const d of docs) {
        if (!d.title.trim() && !d.file) continue;
        let path = d.file_path;
        if (d.file) {
          const ext = d.file.name.split(".").pop() || "bin";
          path = `${id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const { error } = await supabase.storage
            .from("supplier-docs").upload(path, d.file);
          if (error) throw error;
        }
        const row = {
          supplier_id: id,
          title: d.title.trim() || d.file?.name || "document",
          doc_type: d.doc_type || null,
          file_path: path,
          issued_on: d.issued_on || null,
          expires_on: d.expires_on || null,
          note: d.note.trim() || null,
        };
        if (d.id) await supabase.from("supplier_documents").update(row).eq("id", d.id);
        else await supabase.from("supplier_documents").insert(row);
      }

      router.push("/suppliers");
      router.refresh();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="pt-6 text-sm text-slate-400">…</div>;

  const input = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";
  const label = "text-sm text-slate-600";

  return (
    <form onSubmit={handleSave} className="pt-4 pb-16 max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">
          {supplierId ? t("products_edit") : t("suppliers_addNew")}
        </h2>
        <Link href="/suppliers" className="text-sm text-slate-500">
          {t("products_cancel")}
        </Link>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="font-medium">Company</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>{t("suppliers_name")} *</label>
            <input className={input} value={form.name} required
                   onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className={label}>Registered name</label>
            <input className={input} value={form.company_name}
                   onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
          </div>
          <div>
            <label className={label}>DICA registration no.</label>
            <input className={input} value={form.dica_no}
                   onChange={(e) => setForm({ ...form, dica_no: e.target.value })} />
          </div>
          <div>
            <label className={label}>Tax / TIN</label>
            <input className={input} value={form.tax_no}
                   onChange={(e) => setForm({ ...form, tax_no: e.target.value })} />
          </div>
          <div>
            <label className={label}>Contact person</label>
            <input className={input} value={form.contact_person}
                   onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
          </div>
          <div>
            <label className={label}>Contact phone</label>
            <input className={input} value={form.contact_phone}
                   onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
          </div>
          <div>
            <label className={label}>{t("suppliers_phone")}</label>
            <input className={input} value={form.phone}
                   onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className={label}>{t("suppliers_email")}</label>
            <input className={input} type="email" value={form.email}
                   onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className={label}>Website / page</label>
            <input className={input} value={form.website}
                   onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </div>
          <div>
            <label className={label}>Payment terms</label>
            <input className={input} value={form.payment_terms} placeholder="credit 30 days"
                   onChange={(e) => setForm({ ...form, payment_terms: e.target.value })} />
          </div>
        </div>
        <div>
          <label className={label}>{t("suppliers_address")}</label>
          <textarea className={input} rows={2} value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("suppliers_note")}</label>
          <textarea className={input} rows={2} value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Bank accounts</h3>
          <button type="button" onClick={() => setBanks([...banks, { ...emptyBank }])}
                  className="text-sm text-blue-600 font-medium">+ add account</button>
        </div>
        {banks.map((b, i) => (
          <div key={i} className="border border-slate-100 rounded-lg p-4 space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={label}>Bank</label>
                <input className={input} value={b.bank_name} placeholder="KBZ"
                       onChange={(e) => setBank(i, { bank_name: e.target.value })} />
              </div>
              <div>
                <label className={label}>Account name</label>
                <input className={input} value={b.account_name}
                       onChange={(e) => setBank(i, { account_name: e.target.value })} />
              </div>
              <div>
                <label className={label}>Account number</label>
                <input className={input} value={b.account_no}
                       onChange={(e) => setBank(i, { account_no: e.target.value })} />
              </div>
              <div>
                <label className={label}>Branch</label>
                <input className={input} value={b.branch}
                       onChange={(e) => setBank(i, { branch: e.target.value })} />
              </div>
              <div>
                <label className={label}>Currency</label>
                <select className={input} value={b.currency}
                        onChange={(e) => setBank(i, { currency: e.target.value })}>
                  <option value="MMK">MMK</option>
                  <option value="USD">USD</option>
                  <option value="THB">THB</option>
                  <option value="CNY">CNY</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="radio" name="primaryBank" checked={b.is_primary}
                       onChange={() => makePrimary(i)} />
                pay to this one by default
              </label>
              {banks.length > 1 && (
                <button type="button" onClick={() => removeBank(i)}
                        className="text-red-600 text-xs font-medium">remove</button>
              )}
            </div>
          </div>
        ))}
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Documents</h3>
          <button type="button" onClick={() => setDocs([...docs, { ...emptyDoc }])}
                  className="text-sm text-blue-600 font-medium">+ add document</button>
        </div>
        {docs.length === 0 && (
          <p className="text-sm text-slate-400">
            DICA certificate, licence, signed price list — anything worth keeping.
          </p>
        )}
        {docs.map((d, i) => (
          <div key={i} className="border border-slate-100 rounded-lg p-4 space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={label}>Title</label>
                <input className={input} value={d.title}
                       onChange={(e) => setDoc(i, { title: e.target.value })} />
              </div>
              <div>
                <label className={label}>Type</label>
                <select className={input} value={d.doc_type}
                        onChange={(e) => setDoc(i, { doc_type: e.target.value })}>
                  {DOC_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <label className={label}>Issued on</label>
                <input className={input} type="date" value={d.issued_on}
                       onChange={(e) => setDoc(i, { issued_on: e.target.value })} />
              </div>
              <div>
                <label className={label}>Expires on</label>
                <input className={input} type="date" value={d.expires_on}
                       onChange={(e) => setDoc(i, { expires_on: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" className="text-sm"
                     onChange={(e) => setDoc(i, { file: e.target.files?.[0] || null })} />
              {d.file_path && !d.file && (
                <button type="button" onClick={() => openDoc(d.file_path as string)}
                        className="text-blue-600 text-xs font-medium">open current file</button>
              )}
              <button type="button" onClick={() => removeDoc(i)}
                      className="text-red-600 text-xs font-medium ml-auto">remove</button>
            </div>
          </div>
        ))}
      </section>

      <div className="flex gap-2 max-w-sm">
        <Link href="/suppliers"
              className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium text-center">
          {t("products_cancel")}
        </Link>
        <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
          {saving ? t("products_saving") : t("products_save")}
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </form>
  );
}
