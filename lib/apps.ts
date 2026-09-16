// Where each app lives, and who is allowed in.
//
// Signing in is shared across the subdomains, but being signed in is not the
// same as being allowed. Each app checks this list for itself; the database's
// row-level security is what actually protects the data.

export type AppKey = "pos" | "report" | "finance" | "onlineorder";

export const APP_URL: Record<AppKey, string> = {
  pos: "https://erp.edubabyhouse.store",
  report: "https://report.edubabyhouse.store",
  finance: "https://finance.edubabyhouse.store",
  onlineorder: "https://onlineorder.edubabyhouse.store",
};

// Roles that reach every app regardless of department.
const OVERRIDE_ROLES = ["admin", "owner", "operation_director"];

// "*" means any department. Departments come from profiles.department.
const ALLOWED_DEPARTMENTS: Record<AppKey, string[]> = {
  pos: ["sale", "warehouse", "office"],
  report: ["*"],
  finance: ["finance"],
  onlineorder: ["sale", "office"],
};

export function canAccess(
  app: AppKey,
  profile: { role?: string | null; department?: string | null } | null
): boolean {
  if (!profile) return false;
  if (profile.role && OVERRIDE_ROLES.includes(profile.role)) return true;
  if (!profile.department) return false;

  const allowed = ALLOWED_DEPARTMENTS[app];
  return allowed.includes("*") || allowed.includes(profile.department);
}

// Apps this person should see in the switcher, current app excluded.
export function appsFor(
  profile: { role?: string | null; department?: string | null } | null,
  current: AppKey
): { key: AppKey; label: string; url: string }[] {
  const labels: Record<AppKey, string> = {
    pos: "POS",
    report: "Daily Reports",
    finance: "Finance",
    onlineorder: "Online Order",
  };
  return (Object.keys(APP_URL) as AppKey[])
    .filter((k) => k !== current && canAccess(k, profile))
    .map((k) => ({ key: k, label: labels[k], url: APP_URL[k] }));
}

// Only ever bounce back to our own domains — an unchecked ?next= is an open
// redirect a phishing link can abuse.
export function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const ok =
      url.protocol === "https:" &&
      (url.hostname === "edubabyhouse.store" || url.hostname.endsWith(".edubabyhouse.store"));
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}
