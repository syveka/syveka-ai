"use client";

import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * A billing form's submit button: disabled, and saying so, while its form is
 * being submitted, so a second click can't start a second Checkout or portal
 * request. The server still refuses a concurrent one (startPlanChange).
 */
export function PendingSubmitButton({ children, disabled, ...props }: ButtonProps) {
  const { pending } = useFormStatus();
  const t = useTranslations("billingPage");
  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending} {...props}>
      {pending ? t("redirecting") : children}
    </Button>
  );
}
