import type { BotUser } from "@/services/users/users.types";

function getUserEmail(user: BotUser) {
  return user.config?.email || "";
}

function getUserDisplayName(user: BotUser) {
  return user.config?.displayName || "";
}

function getUserTimelineSummary(user: BotUser) {
  const cfg = user.config || ({} as BotUser["config"]);

  const hasAbs = Boolean(cfg.dateStart || cfg.dateEnd);
  const hasDays = cfg.daysFromNowMin != null || cfg.daysFromNowMax != null;
  const hasWeeks = cfg.weeksFromNowMin != null || cfg.weeksFromNowMax != null;

  if (!hasAbs && !hasDays && !hasWeeks) {
    return "Default (Jan–Dec)";
  }

  const parts: string[] = [];

  if (hasAbs) {
    parts.push(`Fixed: ${cfg.dateStart ?? "…"} → ${cfg.dateEnd ?? "…"}`);
  }
  if (hasDays) {
    parts.push(
      `Days: ${cfg.daysFromNowMin ?? "…"}–${cfg.daysFromNowMax ?? "…"}`,
    );
  }
  if (hasWeeks) {
    parts.push(
      `Weeks: ${cfg.weeksFromNowMin ?? "…"}–${cfg.weeksFromNowMax ?? "…"}`,
    );
  }

  return parts.join(" · ");
}

export { getUserEmail, getUserDisplayName, getUserTimelineSummary };
