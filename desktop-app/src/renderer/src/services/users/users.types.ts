export type BotStatus =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "STOPPED"
  | "COMPLETED"
  | "ERROR"
  | "BLOCKED";

export type BotLogEntry = {
  ts: string;
  level: string;
  message: string;
};

export type BotUser = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BotStatus;
  lastMessage: string;
  queue: {
    enqueuedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  config: {
    loginUrl: string;
    email: string;
    displayName: string;
    pickupPoint: string;
    headless: boolean;
    reschedule?: boolean;
    passwordSet: boolean;

    // Optional appointment date preferences
    // - dateStart/dateEnd: YYYY-MM-DD (inclusive)
    // - daysFromNowMin/daysFromNowMax: inclusive window relative to today
    // - weeksFromNowMin/weeksFromNowMax: inclusive window relative to today
    dateStart?: string | null;
    dateEnd?: string | null;
    daysFromNowMin?: number | null;
    daysFromNowMax?: number | null;
    weeksFromNowMin?: number | null;
    weeksFromNowMax?: number | null;
  };
  runtime: {
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
  };
  logs: BotLogEntry[];
};

export type CreateUserInput = {
  loginUrl: string;
  email: string;
  password: string;
  displayName: string;
  pickupPoint?: string;
  headless?: boolean;
  reschedule?: boolean;

  // Optional appointment date preferences
  dateStart?: string | null;
  dateEnd?: string | null;
  daysFromNowMin?: number | null;
  daysFromNowMax?: number | null;
  weeksFromNowMin?: number | null;
  weeksFromNowMax?: number | null;
};

export type UpdateUserInput = Partial<CreateUserInput>;
