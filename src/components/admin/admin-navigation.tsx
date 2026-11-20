"use client";

import { Building2, LayoutDashboard } from "lucide-react";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";

export function AdminNavigation({
  label,
  overview,
  organizations,
}: {
  label: string;
  overview: string;
  organizations: string;
}) {
  const pathname = usePathname();
  const links = [
    { href: "/admin", label: overview, icon: LayoutDashboard },
    { href: "/admin/organizations", label: organizations, icon: Building2 },
  ];

  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 lg:flex-col">
      {links.map(({ href, label: text, icon: Icon }) => {
        const current = pathname === href;
        const active = current || (href !== "/admin" && pathname.startsWith(`${href}/`));

        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : active ? "location" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium",
              active
                ? "bg-teal-300/15 text-teal-200"
                : "text-slate-300 hover:bg-slate-800 hover:text-white",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {text}
          </Link>
        );
      })}
    </nav>
  );
}
