import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { notificationsKeys } from "./notifications.keys";
import * as api from "./notifications.api";
import type { NotificationRecipient } from "./notifications.types";

export function useNotificationsQuery() {
  return useQuery<NotificationRecipient | null>({
    queryKey: notificationsKeys.recipient(),
    queryFn: api.getNotificationRecipient,
  });
}

export function useSaveNotificationRecipient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { email: string; name?: string; active?: boolean }) =>
      api.saveNotificationRecipient(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: notificationsKeys.recipient(),
      });
    },
  });
}

export function useDeleteNotificationRecipient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.deleteNotificationRecipient(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: notificationsKeys.recipient(),
      });
    },
  });
}
