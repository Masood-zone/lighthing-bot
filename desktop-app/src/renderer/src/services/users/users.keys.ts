export const usersKeys = {
  all: ["users"] as const,
  list: () => [...usersKeys.all, "list"] as const,
  detail: (id: string) => [...usersKeys.all, "detail", id] as const,
  logs: (id: string) => [...usersKeys.all, "logs", id] as const,
};
