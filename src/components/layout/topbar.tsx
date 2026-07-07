"use client";

import { Bell, Moon, Sun, LogOut, Languages } from "lucide-react";
import { useTheme } from "next-themes";
import { useLocale } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/actions/auth";
import { useUnreadBadge } from "@/hooks/use-notifications";
import { routing } from "@/i18n/routing";

export function Topbar({
  userId,
  orgName,
  initialUnread,
}: {
  userId: string;
  orgName: string;
  initialUnread: number;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const unread = useUnreadBadge(initialUnread, userId);
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const nextLocale = routing.locales[(routing.locales.indexOf(locale as never) + 1) % routing.locales.length]!;

  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <span className="truncate text-sm font-medium text-muted-foreground">{orgName}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="language"
          title={nextLocale.toUpperCase()}
          onClick={() => router.replace(pathname, { locale: nextLocale })}
        >
          <Languages className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="theme"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
        </Button>
        <Button variant="ghost" size="icon" asChild aria-label="notifications">
          <Link href="/notifications" className="relative">
            <Bell className="size-4" />
            {unread > 0 ? (
              <span className="absolute -end-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-destructive-foreground">
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </Link>
        </Button>
        <form action={logoutAction}>
          <Button variant="ghost" size="icon" type="submit" aria-label="logout">
            <LogOut className="size-4" />
          </Button>
        </form>
      </div>
    </header>
  );
}
