/**
 * The text a hit is judged by: the detector's own output, nothing read from the
 * trace. Formats match the benchmark that validated the pipeline.
 */

/** Detector output fields are free text; bound them so one hit cannot blow up a prompt. */
const MAX_MATERIAL_CHARS = 4_000;

/** Some judges return `data` as a JSON string or plain text instead of an object. */
export function dataFields(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (typeof data === "string" && data.trim()) {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      return { value: data };
    }
  }
  return {};
}

function dataLine(data: unknown): string {
  return Object.entries(dataFields(data))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** What the assignment model reads for a hit, and a new signal's example. */
export function hitMaterial(detectorName: string, summary: string, data: unknown): string {
  const text = `detector: ${detectorName}\nsummary: ${summary}\ndata: ${dataLine(data) || "none"}`;
  return text.slice(0, MAX_MATERIAL_CHARS);
}

/** What is embedded for the shortlist: the summary and the data, without labels. */
export function embeddingText(summary: string, data: unknown): string {
  return `${summary}\n${dataLine(data)}`.slice(0, MAX_MATERIAL_CHARS);
}
