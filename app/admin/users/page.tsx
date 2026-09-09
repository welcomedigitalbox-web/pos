"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useStore } from "../../store-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../../language-context";
import { PAGE_OPTIONS, DEFAULT_PERMISSIONS, PageKey, UserRole, ROLE_OPTIONS, DEPARTMENT_ROLES, COMPANY_ROLES } from "../../permissions";



type UserRow = {
  id: string;
  email: string;
  role: UserRole;
  store_id: string;
  permissions: string[];
};

export default function AdminUsersPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();
  const router = useRouter();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("cashier");
  const [store, setStore] = useState("");
  // Approval routing reads these: who you report to, which department you
  // head, and which branches you cover. Without them can_approve_for()
  // has nothing to go on.
  const [department, setDepartment] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [isDeptHead, setIsDeptHead] = useState(false);
  const [scopeStores, setScopeStores] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>(DEFAULT_PERMISSIONS.cashier);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && profile.role !== "admin") router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || profile.role !== "admin") return null;

  async function loadUsers() {
    const { data } = await supabase.from("profiles").select("*").order("email");
    setUsers((data as UserRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setEditingUser(null);
    setEmail("");
    setPassword("");
    setRole("cashier");
    setStore(stores[0]?.id || "");
    setDepartment("sale");
    setReportsTo("");
    setIsDeptHead(false);
    setScopeStores([]);
    setChannels([]);
    setPermissions(DEFAULT_PERMISSIONS.cashier);
    setShowForm(true);
  }

  function openEdit(u: UserRow) {
    setEditingUser(u);
    setEmail(u.email);
    setPassword("");
    setRole(u.role);
    setStore(u.store_id);
    setDepartment((u as any).department || "");
    setReportsTo((u as any).reports_to || "");
    setIsDeptHead(!!(u as any).is_dept_head);
    loadScope(u.id);
    setPermissions(u.permissions || []);
    setShowForm(true);
  }

  function onRoleChange(newRole: UserRole) {
    setRole(newRole);
    if (newRole === "admin") setPermissions(PAGE_OPTIONS.map((p) => p.key));
    else setPermissions(DEFAULT_PERMISSIONS[newRole]);
  }

  function togglePermission(key: PageKey) {
    setPermissions((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  }

  async function handleDeleteUser(u: UserRow) {
    if (!confirm(`${t("admin_deleteUserConfirm")} (${u.email})`)) return;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: { action: "delete", user_id: u.id },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      showToast(t("admin_userDeleted"));
      await loadUsers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    }
  }

  async function loadScope(userId: string) {
    const [{ data: st }, { data: ch }] = await Promise.all([
      supabase.from("user_stores").select("store_id").eq("user_id", userId),
      supabase.from("user_channels").select("channel").eq("user_id", userId),
    ]);
    setScopeStores(((st as any[]) || []).map((r) => r.store_id));
    setChannels(((ch as any[]) || []).map((r) => r.channel));
  }

  // Replace rather than merge: the checkboxes are the whole truth about
  // this person's scope, so a box cleared here must clear the row.
  async function saveScope(userId: string) {
    await supabase.from("user_stores").delete().eq("user_id", userId);
    if (scopeStores.length) {
      await supabase.from("user_stores").insert(
        scopeStores.map((store_id) => ({ user_id: userId, store_id }))
      );
    }
    await supabase.from("user_channels").delete().eq("user_id", userId);
    if (channels.length) {
      await supabase.from("user_channels").insert(
        channels.map((channel) => ({ user_id: userId, channel }))
      );
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingUser) {
        const { error } = await supabase
          .from("profiles")
          .update({
            role, store_id: store, permissions,
            department: department || null,
            reports_to: reportsTo || null,
            is_dept_head: isDeptHead,
          })
          .eq("id", editingUser.id);
        await saveScope(editingUser.id);
        if (error) throw error;
        showToast(t("admin_userUpdated"));
      } else {
        if (!email || !password) throw new Error("Email/Password required");
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        const { data, error } = await supabase.functions.invoke("admin-create-user", {
          body: { email, password, role, store_id: store, permissions },
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        showToast(t("admin_userCreated"));
      }
      setShowForm(false);
      await loadUsers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("admin_users_title")}</h2>
        <button
          onClick={openNew}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("admin_createUser")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("admin_email")}</th>
              <th className="text-left px-4 py-2">{t("admin_role")}</th>
              <th className="text-left px-4 py-2">{t("admin_store")}</th>
              <th className="text-left px-4 py-2">{t("admin_permissions")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2 capitalize">{u.role}</td>
                <td className="px-4 py-2">{u.store_id}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">
                  {u.role === "admin" ? "All" : (u.permissions || []).join(", ") || "-"}
                </td>
                <td className="px-4 py-2 text-right space-x-2">
                  <button onClick={() => openEdit(u)} className="text-blue-600 text-xs font-medium">
                    {t("admin_edit")}
                  </button>
                  {u.id !== profile.id && (
                    <button onClick={() => handleDeleteUser(u)} className="text-red-600 text-xs font-medium">
                      {t("admin_delete")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form
            onSubmit={handleSave}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-lg my-8"
          >
            <h3 className="font-semibold text-lg mb-4">
              {editingUser ? editingUser.email : t("admin_createUser")}
            </h3>

            {!editingUser && (
              <>
                <label className="text-sm text-slate-600">{t("admin_email")}</label>
                <input
                  type="email"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <label className="text-sm text-slate-600">{t("admin_password")}</label>
                <input
                  type="password"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </>
            )}

            <label className="text-sm text-slate-600">{t("admin_department")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={department}
              onChange={(e) => {
                const d = e.target.value;
                setDepartment(d);
                const allowed = d ? DEPARTMENT_ROLES[d] || [] : COMPANY_ROLES;
                if (!allowed.includes(role as any)) onRoleChange(allowed[0]);
              }}
            >
              <option value="">—</option>
              {["sale", "merchandising", "warehouse", "finance", "marketing"].map((d) => (
                <option key={d} value={d}>{t(`admin_dept_${d}` as any)}</option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("admin_role")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={role}
              onChange={(e) => onRoleChange(e.target.value as UserRole)}
            >
              {(department ? DEPARTMENT_ROLES[department] || [] : COMPANY_ROLES).map((r) => (
                <option key={r} value={r}>
                  {t(`admin_role_${r}` as any)}
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("admin_store")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={store}
              onChange={(e) => setStore(e.target.value)}
            >
              <option value="">—</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("admin_reportsTo")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
            >
              <option value="">—</option>
              {users
                .filter((u) => !editingUser || u.id !== editingUser.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email} ({t(`admin_role_${u.role}` as any)})
                  </option>
                ))}
            </select>

            <label className="flex items-center gap-2 text-sm mb-3">
              <input
                type="checkbox"
                checked={isDeptHead}
                onChange={(e) => setIsDeptHead(e.target.checked)}
              />
              {t("admin_isDeptHead")}
            </label>

            {/* A head may cover several branches; a till belongs to one. */}
            <label className="text-sm text-slate-600 block mb-2">{t("admin_storeScope")}</label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {stores.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopeStores.includes(s.id)}
                    onChange={() =>
                      setScopeStores(
                        scopeStores.includes(s.id)
                          ? scopeStores.filter((x) => x !== s.id)
                          : [...scopeStores, s.id]
                      )
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>

            <label className="text-sm text-slate-600 block mb-2">{t("admin_channelScope")}</label>
            <div className="flex gap-4 mb-3">
              {["pos", "online", "wholesale"].map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={channels.includes(c)}
                    onChange={() =>
                      setChannels(
                        channels.includes(c)
                          ? channels.filter((x) => x !== c)
                          : [...channels, c]
                      )
                    }
                  />
                  {t(`admin_channel_${c}` as any)}
                </label>
              ))}
            </div>

            {role !== "admin" && (
              <>
                <label className="text-sm text-slate-600 block mb-2">{t("admin_permissions")}</label>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {PAGE_OPTIONS.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={permissions.includes(p.key)}
                        onChange={() => togglePermission(p.key)}
                      />
                      {t(p.labelKey as any)}
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("admin_cancel")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? t("admin_creating") : t("admin_save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
