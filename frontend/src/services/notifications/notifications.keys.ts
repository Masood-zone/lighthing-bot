export const notificationsKeys = {
  all: ["notifications"] as const,
  recipient: () => [...notificationsKeys.all, "recipient"] as const,
  desktop: () => [...notificationsKeys.all, "desktop"] as const,
};
