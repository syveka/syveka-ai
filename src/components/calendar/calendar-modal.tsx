"use client";

import { useEffect, useId, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The modal frame shared by the calendar's event and booking-page editors.
 * It always fits the visible viewport: dvh follows the mobile browser's
 * toolbar and on-screen keyboard, the width never exceeds the screen minus the
 * gutter, and long content scrolls inside the card instead of the page.
 * Escape closes it, and focus moves into the dialog and back on close.
 */
export function CalendarModal({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/50 p-4 focus:outline-none"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-[min(32rem,calc(100vw-2rem))] overflow-y-auto overflow-x-hidden overscroll-contain">
        <CardHeader>
          <CardTitle id={titleId} className="break-words leading-snug">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
