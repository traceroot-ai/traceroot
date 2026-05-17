import { z } from "zod";

export const SlackOAuthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().startsWith("xoxb-"),
  token_type: z.literal("bot"),
  bot_user_id: z.string(),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
  // Optional fields read by the callback for storeInstallation:
  app_id: z.string().optional(),
  scope: z.string().optional(),
  authed_user: z.object({ id: z.string() }).optional(),
});

export type SlackOAuthResponse = z.infer<typeof SlackOAuthResponseSchema>;
