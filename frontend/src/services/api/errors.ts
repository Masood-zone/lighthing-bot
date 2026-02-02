import axios from "axios";

export type ApiErrorBody = {
  error?: string;
  message?: string;
};

export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as ApiErrorBody | undefined;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
    if (error.message) return error.message;
  }

  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
