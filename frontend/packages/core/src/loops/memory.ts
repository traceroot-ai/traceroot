/**
 * What a Loop remembers between runs: short notes keyed by topic. Memory is
 * shared across the project's Loops (`loopId` records the writer), and a note
 * may expire.
 */
import type { Prisma } from "@prisma/client";
import { LOOP_MEMORY, type LoopMemoryDto } from "./contracts.ts";

export function isExpired(memory: { expiresAt: Date | null }, now: Date): boolean {
  return memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime();
}

export type MemoryWrite = { ok: true; id: string } | { ok: false; error: string };

export async function upsertMemory(
  db: Prisma.TransactionClient,
  input: {
    projectId: string;
    loopId: string | null;
    key: string;
    content: string;
    expiresAt?: Date | null;
    runId?: string | null;
  },
): Promise<MemoryWrite> {
  const key = input.key.trim();
  if (key.length === 0 || key.length > LOOP_MEMORY.keyMaxLength) {
    return { ok: false, error: `key must be 1 to ${LOOP_MEMORY.keyMaxLength} characters` };
  }
  if (new TextEncoder().encode(input.content).length > LOOP_MEMORY.contentMaxBytes) {
    return { ok: false, error: `content must be at most ${LOOP_MEMORY.contentMaxBytes} bytes` };
  }
  const data = {
    loopId: input.loopId,
    content: input.content,
    expiresAt: input.expiresAt ?? null,
    updatedByRunId: input.runId ?? null,
  };
  const row = await db.loopMemory.upsert({
    where: { projectId_key: { projectId: input.projectId, key } },
    create: { projectId: input.projectId, key, ...data },
    update: data,
    select: { id: true },
  });
  return { ok: true, id: row.id };
}

/** The project's notes, newest first. Expired ones are hidden unless asked for. */
export async function listMemory(
  db: Prisma.TransactionClient,
  input: { projectId: string; now: Date; includeExpired?: boolean },
): Promise<LoopMemoryDto[]> {
  const rows = await db.loopMemory.findMany({
    where: { projectId: input.projectId },
    orderBy: { updateTime: "desc" },
  });
  return rows
    .map((row) => ({
      id: row.id,
      loopId: row.loopId,
      key: row.key,
      content: row.content,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, input.now),
      updatedByRunId: row.updatedByRunId,
      updateTime: row.updateTime.toISOString(),
    }))
    .filter((memory) => input.includeExpired || !memory.expired);
}
