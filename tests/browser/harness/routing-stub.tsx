/** Harness stand-in for @/i18n/routing's Link: a plain anchor (no app router here). */
import React from "react";

export function Link({ href, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return <a href={href} {...props} />;
}
