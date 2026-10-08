// Server-only email plumbing, reached as `@traceroot/core/email`. Kept off the
// main barrel because it imports node:crypto (see the note in ../../index.ts).
export {
  sendEmail,
  resendConfig,
  ensureContact,
  setTopicSubscription,
  type EmailKind,
  type OutboundEmail,
  type SendResult,
  type SendSkipReason,
  type ResendConfig,
  type ResendOptions,
  type TopicSubscription,
} from "./resend.ts";
export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeHeaders,
  UNSUBSCRIBE_PATH,
  type UnsubscribeTokenCheck,
} from "./unsubscribe.ts";
export { type EmailSendClient } from "./send-record.ts";
export { sendOnce, type SendOnceResult } from "./send-once.ts";
