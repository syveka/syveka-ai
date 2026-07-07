import { z } from "zod";

export const promptSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(300).optional().or(z.literal("")),
  content: z.string().min(1).max(8000),
  category: z.enum(["general", "sales", "support", "marketing", "finance", "hr", "productivity"]),
});

export type PromptInput = z.infer<typeof promptSchema>;
