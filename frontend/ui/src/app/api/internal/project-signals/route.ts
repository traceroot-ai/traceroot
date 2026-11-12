import { handleInternalSignalRead } from "@/ee/features/signals/internal-read";

// POST /api/internal/project-signals — list a project's signals or fetch one,
// for the Python backend's public signal reads. See the handler for the rules.
export const POST = handleInternalSignalRead;
