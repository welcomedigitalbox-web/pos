"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../auth-context";
import { hasPermission } from "../../permissions";
import SupplierForm from "../supplier-form";

export default function NewSupplierPage() {
  const { profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasPermission(profile, "suppliers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || !hasPermission(profile, "suppliers")) return null;
  return <SupplierForm />;
}
