import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSlackConnection,
  fetchSlackChannels,
  saveSlackChannel,
  disconnectSlack,
  sendSlackTestMessage,
  SlackStatus,
} from "@/lib/slack";

const STATUS_KEY = (workspaceId: string) => ["slack", workspaceId, "status"];
const CHANNELS_KEY = (workspaceId: string) => ["slack", workspaceId, "channels"];

export function useSlackStatus(workspaceId: string | undefined) {
  return useQuery<SlackStatus>({
    queryKey: STATUS_KEY(workspaceId ?? ""),
    queryFn: () => fetchSlackConnection(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useSlackChannels(workspaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: CHANNELS_KEY(workspaceId ?? ""),
    queryFn: () => fetchSlackChannels(workspaceId!),
    enabled: !!workspaceId && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveSlackChannel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: string; channelName: string }) =>
      saveSlackChannel(workspaceId, input.channelId, input.channelName),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY(workspaceId) }),
  });
}

export function useDisconnectSlack(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectSlack(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY(workspaceId) }),
  });
}

export function useSendSlackTest(workspaceId: string) {
  return useMutation({
    mutationFn: () => sendSlackTestMessage(workspaceId),
  });
}
