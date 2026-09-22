"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/app/auth-context";
import { useLanguage } from "@/app/language-context";
import { PAGE_OPTIONS } from "@/app/permissions";

type Role = { key: string; label_en: string; department: string | null; tier: string };
type Form = { id: string; name: string; allowed_roles: string[] | null };

// Finance keeps its own page list in its own app; these are its keys.
const FIN_PAGES = [
  ["fin-dashboard","Finance Overview"],["fin-sales","Sales"],["fin-vouchers","Vouchers"],
  ["fin-expenses","Expenses"],["fin-payments","Payments & Receipts"],["fin-closing","Daily Closing"],
  ["fin-transfers","Transfers"],["fin-receivables","Receivables"],["fin-payables","Payables"],
  ["fin-cashbook","Cashbook"],["fin-bank","Bank Book"],["fin-journal","Journal"],
  ["fin-ledger","General Ledger"],["fin-trial-balance","Trial Balance"],["fin-pl","Profit & Loss"],
  ["fin-accounts","Chart of Accounts"],["fin-methods","Payment Methods"],["fin-import","Import"],
];

export default function RolePagesPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [roles, setRoles] = useState<Role[]>([]);
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [forms, setForms] = useState<Form[]>([]);
  const [pick, setPick] = useState("");
  const [dept, setDept] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    const [r, g, f] = await Promise.all([
      supabase.from("org_roles").select("key,label_en,department,tier").eq("active", true).order("department").order("sort_order"),
      supabase.from("org_role_pages").select("role_key,app,page_key"),
      supabase.from("report_forms").select("id,name,allowed_roles").eq("active", true).order("sort_order"),
    ]);
    setRoles((r.data as Role[]) || []);
    setGrants(new Set(((g.data as { role_key: string; app: string; page_key: string }[]) || [])
      .map((x) => x.role_key + "|" + x.app + "|" + x.page_key)));
    setForms((f.data as Form[]) || []);
  }
  useEffect(() => { load(); }, []);

  const depts = useMemo(() => Array.from(new Set(roles.map((r) => r.department || "-"))), [roles]);
  const shownRoles = dept ? roles.filter((r) => (r.department || "-") === dept) : roles;

  if (!profile || profile.role !== "admin") return null;

  async function toggle(app: string, key: string) {
    const id = pick + "|" + app + "|" + key;
    const on = grants.has(id);
    const next = new Set(grants);
    if (on) next.delete(id); else next.add(id);
    setGrants(next);
    const { error } = on
      ? await supabase.from("org_role_pages").delete().match({ role_key: pick, app, page_key: key })
      : await supabase.from("org_role_pages").insert({ role_key: pick, app, page_key: key });
    if (error) { setMsg("❌ " + error.message); load(); }
  }

  // Report forms already carry who may fill them; ticking here edits that list.
  async function toggleForm(f: Form) {
    const cur = f.allowed_roles || [];
    const nextRoles = cur.includes(pick) ? cur.filter((x) => x !== pick) : [...cur, pick];
    setForms(forms.map((x) => (x.id === f.id ? { ...x, allowed_roles: nextRoles } : x)));
    const { error } = await supabase.from("report_forms").update({ allowed_roles: nextRoles }).eq("id", f.id);
    if (error) { setMsg("❌ " + error.message); load(); }
  }

  const Col = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="text-xs font-semibold text-slate-500 uppercase mb-2">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
  const Tick = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={on} onChange={onClick} /> {label}
    </label>
  );

  return (
    <div className="p-4 max-w-6xl">
      <h1 className="text-lg font-semibold mb-1">Role Pages</h1>
      <p className="text-sm text-slate-500 mb-4">Pick a role, tick what it should open. Everyone with that role gets it at their next sign-in.</p>
      {msg && <p className="text-sm mb-3">{msg}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3 lg:col-span-1">
          <select value={dept} onChange={(e) => setDept(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mb-2">
            <option value="">All departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="max-h-[70vh] overflow-y-auto space-y-0.5">
            {shownRoles.map((r) => (
              <button key={r.key} onClick={() => setPick(r.key)}
                className={"w-full text-left px-2 py-1.5 rounded text-sm " +
                  (pick === r.key ? "bg-slate-900 text-white" : "hover:bg-slate-50")}>
                {r.label_en}
                <span className={"block text-xs " + (pick === r.key ? "text-slate-300" : "text-slate-400")}>
                  {r.department} · {r.tier}
                </span>
              </button>
            ))}
          </div>
        </div>

        {!pick && <div className="lg:col-span-3 text-sm text-slate-400 p-6">Pick a role on the left.</div>}
        {pick && (
          <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Col title="POS">
              {PAGE_OPTIONS.map((p) => (
                <Tick key={p.key} on={grants.has(pick + "|pos|" + p.key)}
                  label={t(p.labelKey as never) || p.key} onClick={() => toggle("pos", p.key)} />
              ))}
            </Col>
            <Col title="Finance">
              {FIN_PAGES.map(([k, label]) => (
                <Tick key={k} on={grants.has(pick + "|finance|" + k)} label={label}
                  onClick={() => toggle("finance", k)} />
              ))}
            </Col>
            <Col title="Daily Report forms">
              {forms.map((f) => (
                <Tick key={f.id} on={(f.allowed_roles || []).includes(pick)} label={f.name}
                  onClick={() => toggleForm(f)} />
              ))}
            </Col>
          </div>
        )}
      </div>
    </div>
  );
}
