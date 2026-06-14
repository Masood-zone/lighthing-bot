function parseIsoDateOnly(value) {
  if (!value || typeof value !== "string") return null;
  const dateOnly = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return dateOnly;
}

function toDateUtc(dateOnly) {
  const parsed = parseIsoDateOnly(dateOnly);
  if (!parsed) return null;
  return new Date(`${parsed}T00:00:00.000Z`);
}

function formatIsoDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
}

function computeDateWindow({
  dateStart,
  dateEnd,
  daysFromNowMin,
  daysFromNowMax,
  weeksFromNowMin,
  weeksFromNowMax,
  now = new Date(),
} = {}) {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const absoluteMin = parseIsoDateOnly(dateStart);
  const absoluteMax = parseIsoDateOnly(dateEnd);
  if (absoluteMin || absoluteMax) {
    return { minDate: absoluteMin, maxDate: absoluteMax, source: "absolute" };
  }

  const hasDays = daysFromNowMin != null || daysFromNowMax != null;
  if (hasDays) {
    return {
      minDate:
        daysFromNowMin == null
          ? null
          : formatIsoDateOnly(addDays(today, daysFromNowMin)),
      maxDate:
        daysFromNowMax == null
          ? null
          : formatIsoDateOnly(addDays(today, daysFromNowMax)),
      source: "days",
    };
  }

  const hasWeeks = weeksFromNowMin != null || weeksFromNowMax != null;
  if (hasWeeks) {
    return {
      minDate:
        weeksFromNowMin == null
          ? null
          : formatIsoDateOnly(addDays(today, weeksFromNowMin * 7)),
      maxDate:
        weeksFromNowMax == null
          ? null
          : formatIsoDateOnly(addDays(today, weeksFromNowMax * 7)),
      source: "weeks",
    };
  }

  return { minDate: null, maxDate: null, source: "none" };
}

function isInsideWindow(dateOnly, { minDate, maxDate } = {}) {
  const parsed = parseIsoDateOnly(dateOnly);
  if (!parsed) return false;
  if (minDate && parsed < minDate) return false;
  if (maxDate && parsed > maxDate) return false;
  return true;
}

function normalizeAvailableDates(dates) {
  if (!Array.isArray(dates)) return [];
  return Array.from(
    new Set(dates.map(parseIsoDateOnly).filter(Boolean)),
  ).sort();
}

function selectAvailableDate({
  availableDates,
  minDate = null,
  maxDate = null,
  exactDate = null,
  fallbackStrategy = "EARLIEST_ACCEPTABLE",
  mode = "pending",
  currentAppointmentDate = null,
  allowSameDateReschedule = false,
} = {}) {
  const normalized = normalizeAvailableDates(availableDates);
  const preferred = parseIsoDateOnly(exactDate);
  const current = parseIsoDateOnly(currentAppointmentDate);

  let candidates = normalized.filter((date) =>
    isInsideWindow(date, { minDate, maxDate }),
  );

  if (
    mode === "reschedule" &&
    current &&
    allowSameDateReschedule !== true
  ) {
    candidates = candidates.filter((date) => date !== current);
  }

  if (preferred) {
    if (candidates.includes(preferred)) {
      return { selectedDate: preferred, reason: "exact_date_available" };
    }

    if (fallbackStrategy === "EXACT_ONLY") {
      return { selectedDate: null, reason: "exact_date_unavailable" };
    }

    if (fallbackStrategy === "NEXT_AVAILABLE") {
      const next = candidates.find((date) => date > preferred);
      return {
        selectedDate: next || null,
        reason: next ? "next_available_after_exact" : "no_next_available",
      };
    }

    if (fallbackStrategy === "NOTIFY_ONLY") {
      return { selectedDate: null, reason: "notify_exact_unavailable" };
    }
  }

  if (!candidates.length) {
    return { selectedDate: null, reason: "no_dates_inside_window" };
  }

  return { selectedDate: candidates[0], reason: "earliest_acceptable" };
}

function monthRangeFor(dateOnly) {
  const parsed = toDateUtc(dateOnly);
  if (!parsed) return null;
  const first = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1),
  );
  const last = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  );
  return {
    fromDate: formatIsoDateOnly(first),
    toDate: formatIsoDateOnly(last),
  };
}

function laterDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

function earlierDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}

function platformDateTime(dateOnly) {
  const parsed = parseIsoDateOnly(dateOnly);
  if (!parsed) return null;
  return `${parsed}T00:00:00.000+00:00`;
}

module.exports = {
  parseIsoDateOnly,
  formatIsoDateOnly,
  computeDateWindow,
  normalizeAvailableDates,
  selectAvailableDate,
  monthRangeFor,
  laterDate,
  earlierDate,
  platformDateTime,
};
