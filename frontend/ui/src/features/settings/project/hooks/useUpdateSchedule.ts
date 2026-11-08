import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface UpdateScheduleResponse {
  configured: boolean;
  enabled: boolean;
  frequency: "daily" | "weekly";
  weekday: number;
  hour: number;
  timezone: string;
  next_slot_at: string | null;
  run_token_cap: number;
  monthly_spend_cap_usd: number;
  last_run: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed" | "stopped";
    trigger: string;
    slot_at: string;
    finished_at: string | null;
    error: string | null;
    stop_reason: string | null;
    delivery_note: string | null;
    skills_ran: string[];
    tokens: number;
    cost_usd: number;
    slack_delivered: boolean;
    email_delivered: boolean;
  } | null;
}

export interface UpdateScheduleInput {
  enabled: boolean;
  frequency: "daily" | "weekly";
  weekday: number;
  hour: number;
  timezone: string;
  runTokenCap: number;
  monthlySpendCapUsd: number;
}

const key = (projectId: string) => ["update-schedule", projectId];

export function useUpdateSchedule(projectId: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: async (): Promise<UpdateScheduleResponse> => {
      const res = await fetch(`/api/projects/${projectId}/update-schedule`);
      if (!res.ok) throw new Error("Could not load the update schedule.");
      return res.json();
    },
  });
}

export function useSaveUpdateSchedule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateScheduleInput) => {
      const res = await fetch(`/api/projects/${projectId}/update-schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save the update schedule.");
      return body;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(projectId) }),
  });
}
