"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Typing pause after which the list follows the search box. */
export const SEARCH_DEBOUNCE_MS = 400;

/**
 * Search box for CRM lists. The query reaches the URL (and so the server) on
 * a form submit — which is what a phone keyboard's Search/Go key reliably
 * produces, unlike an Enter keydown — on the search button, and after a short
 * typing pause. Only the latest text is ever committed, and an unchanged
 * query is not re-sent.
 */
export function ListSearch({
  value,
  placeholder,
  searchLabel,
  clearLabel,
  onSearch,
}: {
  /** The search currently applied (from the URL). */
  value: string;
  placeholder: string;
  searchLabel: string;
  clearLabel: string;
  onSearch: (q: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applied = useRef(value);

  // Follow the URL when it changes elsewhere (back button, the empty state's
  // clear button) — but not when it is our own search landing, which would
  // overwrite anything typed since.
  useEffect(() => {
    if (value.trim() === applied.current.trim()) return;
    applied.current = value;
    setText(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (raw: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const q = raw.trim();
    if (q === applied.current.trim()) return;
    applied.current = q;
    onSearch(q || undefined);
  };

  return (
    <form
      role="search"
      className="flex w-full max-w-xs items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        commit(text);
      }}
    >
      <div className="relative min-w-0 flex-1">
        <Input
          type="search"
          enterKeyHint="search"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={text}
          maxLength={200}
          className="pe-8 [&::-webkit-search-cancel-button]:appearance-none"
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
          }}
        />
        {text ? (
          <button
            type="button"
            aria-label={clearLabel}
            className="absolute inset-y-0 end-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => {
              setText("");
              commit("");
            }}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      <Button type="submit" variant="outline" size="icon" aria-label={searchLabel}>
        <Search className="size-4" />
      </Button>
    </form>
  );
}
