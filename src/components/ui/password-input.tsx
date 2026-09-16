"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** aria-label for the show/hide toggle button. */
  toggleLabels: { show: string; hide: string };
};

/**
 * Password field with a show/hide toggle -- hidden by default. Renders a
 * plain <input type="password"|"text"> (never a controlled `value` this
 * component owns) so browser password managers and native form
 * submission/validation behave exactly as they would for a bare <Input>;
 * this component only toggles the DOM `type` attribute, it never reads or
 * stores the password value itself.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, toggleLabels, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          {...props}
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pe-10", className)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? toggleLabels.hide : toggleLabels.show}
          aria-pressed={visible}
          className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
