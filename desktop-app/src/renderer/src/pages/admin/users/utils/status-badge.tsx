export function statusBadge(status: string) {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  switch (status) {
    case "RUNNING":
      return (
        <span
          className={`${base} bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`}
        >
          {status}
        </span>
      );
    case "QUEUED":
      return (
        <span
          className={`${base} bg-blue-500/15 text-blue-700 dark:text-blue-300`}
        >
          {status}
        </span>
      );
    case "ERROR":
      return (
        <span
          className={`${base} bg-red-500/15 text-red-700 dark:text-red-300`}
        >
          {status}
        </span>
      );
    case "BLOCKED":
      return (
        <span
          className={`${base} bg-yellow-500/15 text-yellow-800 dark:text-yellow-300`}
        >
          {status}
        </span>
      );
    default:
      return (
        <span className={`${base} bg-muted text-foreground`}>{status}</span>
      );
  }
}
