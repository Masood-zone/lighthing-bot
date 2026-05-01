import { apiClient } from "../api/root";
import type { NotificationRecipient } from "./notifications.types";

export async function getNotificationRecipient(): Promise<NotificationRecipient | null> {
  const response = await apiClient.get("/notifications");
  const data = response.data as { recipient: NotificationRecipient | null };
  return data.recipient ?? null;
}

export async function saveNotificationRecipient(input: {
  email: string;
  name?: string;
  active?: boolean;
}): Promise<NotificationRecipient> {
  const response = await apiClient.put("/notifications", input);
  const data = response.data as { recipient: NotificationRecipient };
  return data.recipient;
}

export async function deleteNotificationRecipient(): Promise<{
  ok: true;
  deleted: boolean;
}> {
  const response = await apiClient.delete("/notifications");
  return response.data as { ok: true; deleted: boolean };
}
