"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Dept = { code: string; name: string; active: boolean };
type Role = { key: string; label_en: string; label_my: string | null; tier: string; department: string | null; sort_order: number; active: boolean };
type Person = { id: string; email: string; role: string | null; department: string | null; reports_to: string | null; is_dept_head: boolean | null };

const TIERS = ["staff", "head", "director"];
const TABS = [["dept", "Departments"], ["role", "Roles"], ["people", "People"], ["apps", "Apps"]];
const APPS = ["pos", "report", "finance", "onlineorder"];

export default function OrgPage() {
  const [tab, setTab] = useState("dept");
  const [depts, setDepts] = useState<Dept[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [access, setAccess] = useState<{ app: string; department: string }[]>([]);
  const [openDept, setOpenDept] = useState<string | null>(null);
  const [pDept, setPDept] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  const [dCode, setDCode] = useState("");
  const [dName, setDName] = useState("");
  const [rKey, setRKey] = useState("");
  const [rLabel, setRLabel] = useState("");
  const [rTier, setRTier] = useState("staff");
  const [rDept, setRDept] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [d, r, p, ac] = await Promise.all([
      supabase.from("departments").select("*").order("code"),
      supabase.from("org_roles").select("*").order("sort_order"),
      supabase.from("profiles").select("id, email, role, department, reports_to, is_dept_head").order("email"),
      supabase.from("org_app_access").select("app, department"),
    ]);
    setAccess((ac.data as { app: string; department: string }[]) || []);
    setDepts((d.data as Dept[]) || []);
    setRoles((r.data as Role[]) || []);
    setPeople((p.data as Person[]) || []);
    setLoading(false);
  }

  const liveDepts = depts.filter((d) => d.active);

  const shown = people.filter((x) =>
    (!pDept || (x.department || "") === pDept) &&
    (!q || x.email.toLowerCase().includes(q.toLowerCase())));


  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [meId, setMeId] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nEmail, setNEmail] = useState("");
  const [nPass, setNPass] = useState("");
  const [nRole, setNRole] = useState("cashier");
  const [nDept, setNDept] = useState("");
  const [nStore, setNStore] = useState("");

  useEffect(() => {
    supabase.from("stores").select("id, name").order("name")
      .then(({ data }) => setStores((data as { id: string; name: string }[]) || []));
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id || ""));
  }, []);

  async function callAdmin(body: Record<string, unknown>) {
    const { data: sess } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke("admin-create-user", {
      body,
      headers: { Authorization: "Bearer " + (sess.session?.access_token || "") },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  }

  async function createUser() {
    try {
      await callAdmin({ email: nEmail, password: nPass, role: nRole, store_id: nStore || null, permissions: [] });
      if (nDept) {
        const { data: fresh } = await supabase.from("profiles").select("id").eq("email", nEmail).maybeSingle();
        if (fresh) await supabase.from("profiles").update({ department: nDept }).eq("id", (fresh as { id: string }).id);
      }
      setShowNew(false);
      setNEmail(""); setNPass("");
      say("user created");
      await load();
    } catch (e) {
      say("error: " + ((e as { message?: string }).message || String(e)));
    }
  }

  async function resetPassword(u: Person) {
    const next = window.prompt("New password for " + u.email);
    if (next === null) return;
    if (next.length < 8) return say("at least 8 characters");
    try {
      await callAdmin({ action: "reset_password", user_id: u.id, password: next });
      say("password changed");
    } catch (e) {
      say("error: " + ((e as { message?: string }).message || String(e)));
    }
  }

  async function deleteUser(u: Person) {
    if (!window.confirm("Delete " + u.email + "?")) return;
    try {
      await callAdmin({ action: "delete", user_id: u.id });
      say("deleted");
      await load();
    } catch (e) {
      say("error: " + ((e as { message?: string }).message || String(e)));
    }
  }

  const groups = liveDepts
    .map((d) => [d.code, d.name, shown.filter((x) => (x.department || "") === d.code)] as const)
    .concat([["_none", "(no department)", shown.filter((x) => !x.department)] as const])
    .filter((g) => g[2].length > 0);

  function say(t: string) { setMsg(t); setTimeout(() => setMsg(""), 3000); }

  async function run(q: PromiseLike<{ error: unknown }>, ok: string) {
    const { error } = await q;
    if (error) { say("error: " + ((error as { message?: string }).message || String(error))); return; }
    say(ok);
    await load();
  }

  if (loading) return <div className="pt-16 text-center text-sm text-slate-400">...</div>;

  return (
    <div className="max-w-5xl mx-auto pb-16">
      <h1 className="text-xl font-semibold mb-1">Organization</h1>
      <p className="text-sm text-slate-500 mb-6">Departments, roles and who reports to whom</p>

      <div className="flex gap-1 mb-6">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === k ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "dept" && (
        <div className="bg-white border border-slate-200 rounded-xl">
          <div className="flex flex-wrap gap-2 p-4 border-b border-slate-100">
            <input placeholder="code (e.g. logistics)" value={dCode}
              onChange={(e) => setDCode(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            <input placeholder="Name" value={dName} onChange={(e) => setDName(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            <button disabled={!dCode || !dName}
              onClick={() => run(supabase.from("departments").insert({ code: dCode, name: dName, active: true }), "added").then(() => { setDCode(""); setDName(""); })}
              className="px-4 py-1.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">Add</button>
          </div>
          {depts.map((d) => (
            <div key={d.code} className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 last:border-0">
              <span className="text-xs text-slate-400 w-32 shrink-0">{d.code}</span>
              <input defaultValue={d.name}
                onBlur={(e) => e.target.value !== d.name && run(supabase.from("departments").update({ name: e.target.value }).eq("code", d.code), "renamed")}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm flex-1" />
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input type="checkbox" checked={d.active}
                  onChange={(e) => run(supabase.from("departments").update({ active: e.target.checked }).eq("code", d.code), "saved")} />
                active
              </label>
            </div>
          ))}
        </div>
      )}

      {tab === "role" && (
        <div className="bg-white border border-slate-200 rounded-xl">
          <div className="flex flex-wrap gap-2 p-4 border-b border-slate-100">
            <input placeholder="key (e.g. assistant_manager)" value={rKey}
              onChange={(e) => setRKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            <input placeholder="Label" value={rLabel} onChange={(e) => setRLabel(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            <select value={rTier} onChange={(e) => setRTier(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={rDept} onChange={(e) => setRDept(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
              <option value="">(no department)</option>
              {depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
            <button disabled={!rKey || !rLabel}
              onClick={() => run(supabase.from("org_roles").insert({ key: rKey, label_en: rLabel, tier: rTier, department: rDept || null }), "added").then(() => { setRKey(""); setRLabel(""); })}
              className="px-4 py-1.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">Add</button>
          </div>
          {roles.filter((r) => !rDept || (r.department || "") === rDept).map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 last:border-0">
              <span className="text-xs text-slate-400 w-48 shrink-0">{r.key}</span>
              <input defaultValue={r.label_en}
                onBlur={(e) => e.target.value !== r.label_en && run(supabase.from("org_roles").update({ label_en: e.target.value }).eq("key", r.key), "saved")}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[160px]" />
              <select value={r.tier}
                onChange={(e) => run(supabase.from("org_roles").update({ tier: e.target.value }).eq("key", r.key), "saved")}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={r.department || ""}
                onChange={(e) => run(supabase.from("org_roles").update({ department: e.target.value || null }).eq("key", r.key), "saved")}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="">-</option>
                {depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {tab === "people" && (
        <div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={pDept} onChange={(e) => setPDept(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white">
            <option value="">All departments</option>
            {liveDepts.map((dd) => (
              <option key={dd.code} value={dd.code}>{dd.name}</option>
            ))}
          </select>
          <input placeholder="search email" value={q} onChange={(e) => setQ(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          <span className="text-xs text-slate-400 ml-auto">{shown.length}</span>
          <button onClick={() => setShowNew(!showNew)}
            className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium">
            {showNew ? "Close" : "+ New user"}</button>
        </div>
        {showNew && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-3 flex flex-wrap gap-2">
          <input placeholder="email" value={nEmail} onChange={(e) => setNEmail(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          <input placeholder="password" type="text" value={nPass} onChange={(e) => setNPass(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          <select value={nRole} onChange={(e) => setNRole(e.target.value)}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            {roles.map((r) => (<option key={r.key} value={r.key}>{r.label_en}</option>))}
          </select>
          <select value={nDept} onChange={(e) => setNDept(e.target.value)}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="">(no department)</option>
            {liveDepts.map((dd) => (<option key={dd.code} value={dd.code}>{dd.name}</option>))}
          </select>
          <select value={nStore} onChange={(e) => setNStore(e.target.value)}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="">(no store)</option>
            {stores.map((st) => (<option key={st.id} value={st.id}>{st.name}</option>))}
          </select>
          <button disabled={!nEmail || nPass.length < 8} onClick={createUser}
            className="px-4 py-1.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium">Create</button>
        </div>
        )}
        <div className="bg-white border border-slate-200 rounded-xl">
          {groups.map(([code, name, list]) => (
            <div key={code}>
              <button onClick={() => setOpenDept(openDept === code ? null : code)}
                className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-100 text-sm font-medium text-left">
                <span className="text-slate-400 w-3">{openDept === code ? "-" : "+"}</span>
                {name}
                <span className="text-xs text-slate-400 font-normal">({list.length})</span>
              </button>
              {openDept === code && list.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 last:border-0">
              <span className="text-sm w-56 shrink-0 truncate">{p.email}</span>
              <select value={p.role || ""}
                onChange={(e) => run(supabase.from("profiles").update({ role: e.target.value }).eq("id", p.id), "saved")}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="">-</option>
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label_en}</option>)}
              </select>
              <select value={p.department || ""}
                onChange={(e) => run(supabase.from("profiles").update({ department: e.target.value || null }).eq("id", p.id), "saved")}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="">-</option>
                {depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
              <select value={p.reports_to || ""}
                onChange={(e) => run(supabase.from("profiles").update({ reports_to: e.target.value || null }).eq("id", p.id), "saved")}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm max-w-[200px]">
                <option value="">(reports to nobody)</option>
                {people.filter((m) => m.id !== p.id).map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input type="checkbox" checked={!!p.is_dept_head}
                  onChange={(e) => run(supabase.from("profiles").update({ is_dept_head: e.target.checked }).eq("id", p.id), "saved")} />
                dept head
              </label>
              <button onClick={() => resetPassword(p)} className="text-xs text-slate-600 ml-auto">password</button>
              {p.id !== meId && (
                <button onClick={() => deleteUser(p)} className="text-xs text-red-600">delete</button>
              )}
            </div>
              ))}
            </div>
          ))}
        </div>
        </div>
      )}

      {tab === "apps" && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className="text-left font-medium pb-2 pr-6">Department</th>
                {APPS.map((ap) => (
                  <th key={ap} className="font-medium pb-2 px-3 capitalize">{ap}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {depts.map((dp) => (
                <tr key={dp.code} className="border-t border-slate-100">
                  <td className="py-2 pr-6">{dp.name}</td>
                  {APPS.map((ap) => {
                    const on = access.some((x) => x.app === ap && x.department === dp.code);
                    return (
                      <td key={ap} className="text-center px-3">
                        <input type="checkbox" checked={on}
                          onChange={() => run(
                            on
                              ? supabase.from("org_app_access").delete().eq("app", ap).eq("department", dp.code)
                              : supabase.from("org_app_access").insert({ app: ap, department: dp.code }),
                            "saved")} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm z-50">{msg}</div>
      )}
    </div>
  );
}
