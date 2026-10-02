"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../auth-context";
import { hasPermission } from "../../permissions";
import ProductForm from "../product-form";

export default function NewProductPage() {
  const { profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || !hasPermission(profile, "products")) return null;
  return <ProductForm />;
}
