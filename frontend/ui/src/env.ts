import { z } from "zod";

const serverSchema = z.object({
  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  INTERNAL_API_SECRET: z.string(),
  AUTH_GOOGLE_CLIENT_ID: z.string().default(""),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().default(""),
  TRACEROOT_SMTP_URL: z.string().optional(),
  TRACEROOT_SMTP_MAIL_FROM: z.string().optional(),
  NEXT_PUBLIC_LOGO_URL: z.string().optional(),
});

export const env = serverSchema.parse(process.env);
