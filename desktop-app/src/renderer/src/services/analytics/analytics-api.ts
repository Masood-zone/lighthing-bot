import { apiClient } from "../api/root";

export type ISODateString = string;

export type UserRole = "ADMIN";

export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface PaginatedList<T> {
  count: number;
  items: T[];
}

export type VisaUserStatus = "CREATED" | (string & {});

export interface VisaUsersAnalytics {
  count: number;
  byStatus: Partial<Record<VisaUserStatus, number>>;
}

export interface QueueAnalytics {
  maxConcurrent: number;
  queued: unknown[];
  active: unknown[];
  activeCount: number;
  queuedCount: number;
  ts: ISODateString;
  queuedSessions: unknown[];
  activeSessions: unknown[];
}

export interface SuccessAnalytics {
  recentCompleted: unknown[];
}

export interface IssuesAnalytics {
  recentErrors: unknown[];
}

export interface AnalyticsResponse {
  ts: ISODateString;
  admins: PaginatedList<AdminUser>;
  visaUsers: VisaUsersAnalytics;
  queue: QueueAnalytics;
  success: SuccessAnalytics;
  issues: IssuesAnalytics;
}

export const getAnalytics = async () => {
  const response = await apiClient.get("/analytics");
  return response.data as AnalyticsResponse;
};
