import { z } from "zod";
import { Role, SpanKind, SpanStatus } from "./constants.ts";

export const RoleSchema = z.enum(Role);
export const SpanKindSchema = z.enum(SpanKind);
export const SpanStatusSchema = z.enum(SpanStatus);
