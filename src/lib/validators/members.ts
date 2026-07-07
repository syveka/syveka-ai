import { z } from "zod";

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]), // OWNER only via transfer
});

export const changeRoleSchema = z.object({
  memberId: z.string().uuid(),
  role: z.enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
