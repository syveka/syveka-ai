import { describe, expect, it, vi } from "vitest";
import { withModelFallback } from "@/server/ai/fallback";

describe("withModelFallback", () => {
  it("returns the primary result without calling onFallback when primary succeeds", async () => {
    const onFallback = vi.fn();
    await expect(withModelFallback(async () => "primary-ok", onFallback)).resolves.toBe(
      "primary-ok",
    );
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("calls onFallback with the fallback model when the primary fails transiently", async () => {
    const primary = async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    };
    const onFallback = vi.fn(async () => "fallback-ok");

    await expect(withModelFallback(primary, onFallback)).resolves.toBe("fallback-ok");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4o",
      maxTokens: 4096,
    });
  });

  it("propagates a non-transient failure without ever calling onFallback", async () => {
    const primary = async () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    };
    const onFallback = vi.fn();

    await expect(withModelFallback(primary, onFallback)).rejects.toThrow("bad request");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("propagates an aborted request without falling back", async () => {
    const primary = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    const onFallback = vi.fn();

    await expect(withModelFallback(primary, onFallback)).rejects.toThrow();
    expect(onFallback).not.toHaveBeenCalled();
  });
});
