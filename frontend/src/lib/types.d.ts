interface AuthStore {
  user: AuthenticatedUser | null;
}
interface User {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface BasicUser {
  id: string;
  loginUrl: string;
  email: string;
  password: string;
  displayName: string;
  pickupPoint: string;
  headless: boolean;
}

interface AuthenticatedUser {
  token: string;
  expiresAt: number;
  user: User;
}

// Users
type BotStatus =
  | "CREATED"
  | "ENQUEUED"
  | "RUNNING"
  | "FINISHED"
  | "FAILED"
  | "STOPPED"
  | "CANCELLED";

interface BotQueue {
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface BotConfig {
  loginUrl: string;
  email: string;
  displayName: string;
  pickupPoint: string;
  headless: boolean;
  passwordSet: boolean;
}

interface BotRuntime {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
}

type BotLogEntry = string;

interface BotUser {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BotStatus;
  lastMessage: string;
  queue: BotQueue;
  config: BotConfig;
  runtime: BotRuntime;
  logs: BotLogEntry[];
}

type UsersResponse = BotUser[];
// Simple types for the Users Table page (Name, Email, Password)
type UserTableColumnKey = "displayName" | "email" | "password";

interface UserTableRow {
  id: string;
  displayName: string;
  email: string;
  password: string;
}

interface UserTableColumn {
  key: UserTableColumnKey;
  header: string;
}

type UsersTableResponse = UserTableRow[];
