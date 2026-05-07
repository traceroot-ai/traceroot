import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface Detector {
  id: string;
  projectId: string;
  name: string;
  template: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  sampleRate: number;
  detectionModel: string | null;
  detectionProvider: string | null;
  detectionSource: "system" | "byok" | null;
  createTime: string;
  updateTime: string;
  trigger?: { conditions: Array<{ field: string; op: string; value: unknown }> } | null;
}

export interface CreateDetectorInput {
  name: string;
  template: string;
  prompt: string;
  outputSchema: Array<{ name: string; type: string }>;
  sampleRate?: number;
  triggerConditions?: Array<{ field: string; op: string; value: unknown }>;
  detectionModel?: string;
  detectionProvider?: string;
  detectionSource?: "system" | "byok";
}

async function fetchDetectors(projectId: string): Promise<Detector[]> {
  const res = await fetch(`/api/projects/${projectId}/detectors`);
  if (!res.ok) throw new Error(`Failed to fetch detectors: ${res.status}`);
  const data = (await res.json()) as { detectors: Detector[] };
  return data.detectors;
}

async function createDetector(projectId: string, input: CreateDetectorInput): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create detector: ${res.status}`);
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

export interface UpdateDetectorInput {
  name?: string;
  prompt?: string;
  sampleRate?: number;
  triggerConditions?: Array<{ field: string; op: string; value: unknown }>;
  detectionModel?: string;
  detectionProvider?: string;
  detectionSource?: "system" | "byok";
}

async function updateDetector(
  projectId: string,
  detectorId: string,
  input: UpdateDetectorInput,
): Promise<Detector> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to update detector: ${res.status}`);
  const data = (await res.json()) as { detector: Detector };
  return data.detector;
}

async function deleteDetector(projectId: string, detectorId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/detectors/${detectorId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete detector: ${res.status}`);
}

export function useDetectors(projectId: string) {
  return useQuery({
    queryKey: ["detectors", projectId],
    queryFn: () => fetchDetectors(projectId),
    enabled: !!projectId,
  });
}

export function useCreateDetector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDetectorInput) => createDetector(projectId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors", projectId] });
    },
  });
}

export function useUpdateDetector(projectId: string, detectorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDetectorInput) => updateDetector(projectId, detectorId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors", projectId] });
    },
  });
}

export function useDeleteDetector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (detectorId: string) => deleteDetector(projectId, detectorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["detectors", projectId] });
    },
  });
}
