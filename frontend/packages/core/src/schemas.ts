import { z } from "zod";
import { Role, SpanKind, SpanStatus, TraceStatus } from "./constants.js";

export const RoleSchema = z.enum(Role);
export const SpanKindSchema = z.enum(SpanKind);
export const SpanStatusSchema = z.enum(SpanStatus);
export const TraceStatusSchema = z.enum(TraceStatus);
