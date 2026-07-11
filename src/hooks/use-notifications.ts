"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Live unread badge: seeds from the server count, increments on Realtime inserts (§19). */
export function useUnreadBadge(initialCount: number, userId: string) {
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    setCount(initialCount);
  }, [initialCount]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`user:${userId}:notifications`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => setCount((c) => c + 1),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
}
