import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Required"),
});

export const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  // §11.1: 12-char minimum; zxcvbn strength + HIBP check run client-side and
  // re-validated in the action.
  password: z.string().min(12, "At least 12 characters"),
});

// Same 12-char floor as registration (§11.1) — a password recovery must not
// let someone land on a weaker bar than sign-up did.
export const resetPasswordSchema = z.object({
  password: z.string().min(12, "At least 12 characters"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
