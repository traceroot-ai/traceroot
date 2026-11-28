import nodemailer from "nodemailer";
import { env } from "@/env";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Notifications follow committed writes, so an unavailable mail relay must time out.
const SMTP_TIMEOUT_MS = 10_000;

export function isSmtpConfigured(): boolean {
  return Boolean(env.TRACEROOT_SMTP_URL?.trim() && env.TRACEROOT_SMTP_MAIL_FROM?.trim());
}

export async function sendSmtpEmail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const smtpUrl = env.TRACEROOT_SMTP_URL;
  const mailFrom = env.TRACEROOT_SMTP_MAIL_FROM;
  if (!isSmtpConfigured() || !smtpUrl || !mailFrom) {
    console.warn("[Email] SMTP not configured; transactional email was not sent.");
    return false;
  }

  const url = new URL(smtpUrl);
  const secure = url.protocol === "smtps:" || url.port === "465";
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: parseInt(url.port) || (secure ? 465 : 587),
    secure,
    requireTLS: !secure && !LOOPBACK_HOSTS.has(url.hostname),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    auth: {
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
    },
  });
  await transporter.sendMail({ from: `traceroot <${mailFrom}>`, ...message });
  return true;
}
