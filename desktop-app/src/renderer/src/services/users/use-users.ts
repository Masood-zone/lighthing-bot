import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { usersKeys } from "./users.keys";
import * as api from "./users.api";
import type { BotUser, CreateUserInput, UpdateUserInput } from "./users.types";

export function useUsersQuery(): UseQueryResult<BotUser[], unknown> {
  return useQuery({
    queryKey: usersKeys.list(),
    queryFn: api.listUsers,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateUserInput) => api.createUser(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.list() });
    },
  });
}

export function useUpdateUser(userId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: UpdateUserInput) => api.updateUser(userId, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.list() });
      if (userId) {
        await queryClient.invalidateQueries({
          queryKey: usersKeys.detail(userId),
        });
      }
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => api.deleteUser(userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.list() });
    },
  });
}
