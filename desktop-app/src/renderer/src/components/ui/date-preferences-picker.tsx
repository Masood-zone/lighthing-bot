import * as React from "react";
import { format, lastDayOfMonth } from "date-fns";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon, RotateCcwIcon } from "lucide-react";

export type DatePreferencesValue = {
  dateStart?: string | null;
  dateEnd?: string | null;
  daysFromNowMin?: number | null;
  daysFromNowMax?: number | null;
  weeksFromNowMin?: number | null;
  weeksFromNowMax?: number | null;
};

type TimelineMode = "default" | "absolute" | "days" | "weeks";

const MONTHS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Jan" },
  { value: 2, label: "Feb" },
  { value: 3, label: "Mar" },
  { value: 4, label: "Apr" },
  { value: 5, label: "May" },
  { value: 6, label: "Jun" },
  { value: 7, label: "Jul" },
  { value: 8, label: "Aug" },
  { value: 9, label: "Sep" },
  { value: 10, label: "Oct" },
  { value: 11, label: "Nov" },
  { value: 12, label: "Dec" },
];

function toIsoDateOnly(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function parseIsoDateOnly(value?: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampDay(day: number) {
  return Math.max(1, Math.min(31, day));
}

function getWeekDayBounds(week: 1 | 2 | 3 | 4, endOfMonthDay: number) {
  if (week === 1) return { from: 1, to: Math.min(7, endOfMonthDay) };
  if (week === 2) return { from: 8, to: Math.min(14, endOfMonthDay) };
  if (week === 3) return { from: 15, to: Math.min(21, endOfMonthDay) };
  // week 4 == last-ish week
  return { from: 22, to: endOfMonthDay };
}

export function DatePreferencesPicker(props: {
  value: DatePreferencesValue;
  onChange: (patch: Partial<DatePreferencesValue>) => void;
  disabled?: boolean;
}) {
  const { value, onChange, disabled } = props;

  const inferMode = React.useCallback((): TimelineMode => {
    if (value.dateStart || value.dateEnd) return "absolute";
    if (value.daysFromNowMin != null || value.daysFromNowMax != null)
      return "days";
    if (value.weeksFromNowMin != null || value.weeksFromNowMax != null)
      return "weeks";
    return "default";
  }, [
    value.dateStart,
    value.dateEnd,
    value.daysFromNowMin,
    value.daysFromNowMax,
    value.weeksFromNowMin,
    value.weeksFromNowMax,
  ]);

  const [mode, setModeState] = React.useState<TimelineMode>(() => inferMode());
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const initialStart = React.useMemo(
    () => parseIsoDateOnly(value.dateStart),
    [value.dateStart],
  );
  const initialEnd = React.useMemo(
    () => parseIsoDateOnly(value.dateEnd),
    [value.dateEnd],
  );

  const now = new Date();
  const defaultYear = now.getFullYear();

  const [year, setYear] = React.useState<number>(
    initialStart?.getFullYear() ?? defaultYear,
  );
  const [monthFrom, setMonthFrom] = React.useState<number>(
    initialStart ? initialStart.getMonth() + 1 : 1,
  );
  const [monthTo, setMonthTo] = React.useState<number>(
    initialEnd ? initialEnd.getMonth() + 1 : 12,
  );

  const [dayEnabled, setDayEnabled] = React.useState<boolean>(
    Boolean(
      initialStart &&
      initialEnd &&
      (initialStart.getDate() !== 1 ||
        initialEnd.getDate() !== lastDayOfMonth(initialEnd).getDate()),
    ),
  );
  const [dayFrom, setDayFrom] = React.useState<number>(
    initialStart?.getDate() ?? 1,
  );
  const [dayTo, setDayTo] = React.useState<number>(initialEnd?.getDate() ?? 31);

  const [calendarRange, setCalendarRange] = React.useState<
    DateRange | undefined
  >(() => {
    if (initialStart && initialEnd)
      return { from: initialStart, to: initialEnd };
    return undefined;
  });

  React.useEffect(() => {
    setModeState(inferMode());
  }, [inferMode]);

  React.useEffect(() => {
    // Keep picker in sync when external value changes (e.g., switching mode create/edit)
    const start = parseIsoDateOnly(value.dateStart);
    const end = parseIsoDateOnly(value.dateEnd);

    if (start || end) {
      setCalendarRange({ from: start ?? undefined, to: end ?? undefined });

      const anchor = start ?? end;
      if (anchor) {
        setYear(anchor.getFullYear());
      }
      if (start) {
        setMonthFrom(start.getMonth() + 1);
        setDayFrom(start.getDate());
      }
      if (end) {
        setMonthTo(end.getMonth() + 1);
        setDayTo(end.getDate());
      }
      if (start && end) {
        const endLast = lastDayOfMonth(end).getDate();
        setDayEnabled(start.getDate() !== 1 || end.getDate() !== endLast);
      }
      return;
    }

    setCalendarRange(undefined);
    setYear(defaultYear);
    setMonthFrom(1);
    setMonthTo(12);
    setDayEnabled(false);
    setDayFrom(1);
    setDayTo(31);
  }, [value.dateStart, value.dateEnd, defaultYear]);

  const applyFixedMonthRange = (opts: {
    year: number;
    startMonth: number;
    endMonth: number;
  }) => {
    const y = opts.year;
    const startMonth = Math.min(opts.startMonth, opts.endMonth);
    const endMonth = Math.max(opts.startMonth, opts.endMonth);

    const endMonthDate = new Date(y, endMonth - 1, 1);
    const endLastDay = lastDayOfMonth(endMonthDate).getDate();

    const from = new Date(y, startMonth - 1, 1);
    const to = new Date(y, endMonth - 1, endLastDay);

    setYear(y);
    setMonthFrom(startMonth);
    setMonthTo(endMonth);
    setDayEnabled(false);
    setDayFrom(1);
    setDayTo(endLastDay);
    setCalendarRange({ from, to });

    onChange({
      dateStart: toIsoDateOnly(from),
      dateEnd: toIsoDateOnly(to),
      daysFromNowMin: null,
      daysFromNowMax: null,
      weeksFromNowMin: null,
      weeksFromNowMax: null,
    });
  };

  const applyMonthDayWindow = (opts?: { week?: 1 | 2 | 3 | 4 }) => {
    const startMonth = Math.min(monthFrom, monthTo);
    const endMonth = Math.max(monthFrom, monthTo);

    const endMonthDate = new Date(year, endMonth - 1, 1);
    const endLastDay = lastDayOfMonth(endMonthDate).getDate();

    let fromDay = 1;
    let toDay = endLastDay;

    if (opts?.week) {
      const bounds = getWeekDayBounds(opts.week, endLastDay);
      fromDay = bounds.from;
      toDay = bounds.to;
    } else if (dayEnabled) {
      fromDay = clampDay(dayFrom);
      toDay = clampDay(dayTo);
      if (fromDay > toDay) {
        // swap for safety
        [fromDay, toDay] = [toDay, fromDay];
      }
      toDay = Math.min(toDay, endLastDay);
    }

    const from = new Date(year, startMonth - 1, fromDay);
    const to = new Date(year, endMonth - 1, toDay);

    setCalendarRange({ from, to });
    onChange({
      daysFromNowMin: null,
      daysFromNowMax: null,
      weeksFromNowMin: null,
      weeksFromNowMax: null,
      dateStart: toIsoDateOnly(from),
      dateEnd: toIsoDateOnly(to),
    });
  };

  const clearAll = () => {
    onChange({
      dateStart: null,
      dateEnd: null,
      daysFromNowMin: null,
      daysFromNowMax: null,
      weeksFromNowMin: null,
      weeksFromNowMax: null,
    });
  };

  const setMode = (next: TimelineMode) => {
    setModeState(next);
    setShowAdvanced(false);

    if (next === "default") {
      clearAll();
      return;
    }

    if (next === "absolute") {
      onChange({
        daysFromNowMin: null,
        daysFromNowMax: null,
        weeksFromNowMin: null,
        weeksFromNowMax: null,
      });
      return;
    }

    if (next === "days") {
      onChange({
        dateStart: null,
        dateEnd: null,
        weeksFromNowMin: null,
        weeksFromNowMax: null,
      });
      return;
    }

    onChange({
      dateStart: null,
      dateEnd: null,
      daysFromNowMin: null,
      daysFromNowMax: null,
    });
  };

  const setPreset = (preset: string) => {
    if (preset === "DEFAULT") {
      setMode("default");
      clearAll();
      return;
    }

    if (preset === "JAN_DEC") {
      setMode("absolute");
      applyFixedMonthRange({ year: defaultYear, startMonth: 1, endMonth: 12 });
      return;
    }

    if (preset === "FEB_JUN") {
      setMode("absolute");
      applyFixedMonthRange({ year: defaultYear, startMonth: 2, endMonth: 6 });
      return;
    }

    if (preset === "MAR_MAY") {
      setMode("absolute");
      applyFixedMonthRange({ year: defaultYear, startMonth: 3, endMonth: 5 });
      return;
    }

    if (preset === "WEEK1") {
      setMode("absolute");
      return applyMonthDayWindow({ week: 1 });
    }
    if (preset === "WEEK2") {
      setMode("absolute");
      return applyMonthDayWindow({ week: 2 });
    }
    if (preset === "WEEK3") {
      setMode("absolute");
      return applyMonthDayWindow({ week: 3 });
    }
    if (preset === "WEEK4") {
      setMode("absolute");
      return applyMonthDayWindow({ week: 4 });
    }

    if (preset === "NEXT_14_DAYS") {
      setMode("days");
      onChange({
        dateStart: null,
        dateEnd: null,
        weeksFromNowMin: null,
        weeksFromNowMax: null,
        daysFromNowMin: 0,
        daysFromNowMax: 14,
      });
      return;
    }

    if (preset === "NEXT_30_DAYS") {
      setMode("days");
      onChange({
        dateStart: null,
        dateEnd: null,
        weeksFromNowMin: null,
        weeksFromNowMax: null,
        daysFromNowMin: 0,
        daysFromNowMax: 30,
      });
      return;
    }

    if (preset === "NEXT_4_8_WEEKS") {
      setMode("weeks");
      onChange({
        dateStart: null,
        dateEnd: null,
        daysFromNowMin: null,
        daysFromNowMax: null,
        weeksFromNowMin: 4,
        weeksFromNowMax: 8,
      });
      return;
    }

    if (preset === "NEXT_0_4_WEEKS") {
      setMode("weeks");
      onChange({
        dateStart: null,
        dateEnd: null,
        daysFromNowMin: null,
        daysFromNowMax: null,
        weeksFromNowMin: 0,
        weeksFromNowMax: 4,
      });
    }
  };

  const summaryLabel = React.useMemo(() => {
    if (value.dateStart || value.dateEnd) {
      const start = value.dateStart ?? "…";
      const end = value.dateEnd ?? "…";
      return `Fixed: ${start} → ${end}`;
    }
    if (value.daysFromNowMin != null || value.daysFromNowMax != null) {
      return `Days: ${value.daysFromNowMin ?? "…"}–${value.daysFromNowMax ?? "…"}`;
    }
    if (value.weeksFromNowMin != null || value.weeksFromNowMax != null) {
      return `Weeks: ${value.weeksFromNowMin ?? "…"}–${value.weeksFromNowMax ?? "…"}`;
    }
    return "Default (Jan–Dec)";
  }, [
    value.dateStart,
    value.dateEnd,
    value.daysFromNowMin,
    value.daysFromNowMax,
    value.weeksFromNowMin,
    value.weeksFromNowMax,
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          Current:{" "}
          <span className="font-medium text-foreground">{summaryLabel}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={clearAll}
          disabled={disabled}
        >
          <RotateCcwIcon className="h-4 w-4" />
          Reset to default
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-medium">Mode</div>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as TimelineMode)}
            disabled={disabled}
          >
            <SelectTrigger className="w-full cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default" className="cursor-pointer">
                Default (Jan–Dec)
              </SelectItem>
              <SelectItem value="absolute" className="cursor-pointer">
                Fixed date range
              </SelectItem>
              <SelectItem value="days" className="cursor-pointer">
                Days from now
              </SelectItem>
              <SelectItem value="weeks" className="cursor-pointer">
                Weeks from now
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Presets</div>
          <Select onValueChange={setPreset} disabled={disabled}>
            <SelectTrigger className="w-full cursor-pointer">
              <SelectValue placeholder="Choose a preset…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DEFAULT" className="cursor-pointer">
                Default (Jan–Dec)
              </SelectItem>
              <SelectItem value="JAN_DEC" className="cursor-pointer">
                Jan → Dec (this year)
              </SelectItem>
              <SelectItem value="FEB_JUN" className="cursor-pointer">
                February → June
              </SelectItem>
              <SelectItem value="MAR_MAY" className="cursor-pointer">
                March → May
              </SelectItem>
              <SelectItem value="WEEK1" className="cursor-pointer">
                1st week of selected month range
              </SelectItem>
              <SelectItem value="WEEK2" className="cursor-pointer">
                2nd week of selected month range
              </SelectItem>
              <SelectItem value="WEEK3" className="cursor-pointer">
                3rd week of selected month range
              </SelectItem>
              <SelectItem value="WEEK4" className="cursor-pointer">
                4th week of selected month range
              </SelectItem>
              <SelectItem value="NEXT_14_DAYS" className="cursor-pointer">
                Next 14 days
              </SelectItem>
              <SelectItem value="NEXT_30_DAYS" className="cursor-pointer">
                Next 30 days
              </SelectItem>
              <SelectItem value="NEXT_0_4_WEEKS" className="cursor-pointer">
                Next 0–4 weeks
              </SelectItem>
              <SelectItem value="NEXT_4_8_WEEKS" className="cursor-pointer">
                Next 4–8 weeks
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {mode === "default" ? (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          Searches across the full year unless constrained.
        </div>
      ) : null}

      {mode === "absolute" ? (
        <div className="space-y-3">
          <div className="rounded-md border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">Fixed date range</div>
                <div className="text-xs text-muted-foreground">
                  Use the calendar for the simplest setup.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="cursor-pointer"
                      disabled={disabled}
                    >
                      <CalendarIcon className="h-4 w-4" />
                      Pick dates
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="end">
                    <Calendar
                      mode="range"
                      selected={calendarRange}
                      onSelect={(range) => {
                        setCalendarRange(range);
                        setMode("absolute");
                        if (range?.from) {
                          onChange({
                            dateStart: toIsoDateOnly(range.from),
                            daysFromNowMin: null,
                            daysFromNowMax: null,
                            weeksFromNowMin: null,
                            weeksFromNowMax: null,
                          });
                        }
                        if (range?.to) {
                          onChange({
                            dateEnd: toIsoDateOnly(range.to),
                            daysFromNowMin: null,
                            daysFromNowMax: null,
                            weeksFromNowMin: null,
                            weeksFromNowMax: null,
                          });
                        }
                      }}
                      numberOfMonths={2}
                    />
                  </PopoverContent>
                </Popover>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setShowAdvanced((v) => !v)}
                  disabled={disabled}
                >
                  {showAdvanced ? "Hide advanced" : "Advanced"}
                </Button>
              </div>
            </div>
          </div>

          {showAdvanced ? (
            <div className="rounded-md border p-3 space-y-3">
              <div>
                <div className="text-sm font-medium">Month window</div>
                <div className="text-xs text-muted-foreground">
                  Quickly build a range from months (optional).
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium">Year</div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={2000}
                    max={2100}
                    value={year}
                    onChange={(e) =>
                      setYear(Number(e.target.value || defaultYear))
                    }
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">From month</div>
                  <Select
                    value={String(monthFrom)}
                    onValueChange={(v) => setMonthFrom(Number(v))}
                    disabled={disabled}
                  >
                    <SelectTrigger className="w-full cursor-pointer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m) => (
                        <SelectItem
                          key={m.value}
                          value={String(m.value)}
                          className="cursor-pointer"
                        >
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">To month</div>
                  <Select
                    value={String(monthTo)}
                    onValueChange={(v) => setMonthTo(Number(v))}
                    disabled={disabled}
                  >
                    <SelectTrigger className="w-full cursor-pointer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m) => (
                        <SelectItem
                          key={m.value}
                          value={String(m.value)}
                          className="cursor-pointer"
                        >
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-end">
                  <Button
                    type="button"
                    className="w-full cursor-pointer"
                    onClick={() => {
                      setMode("absolute");
                      applyMonthDayWindow();
                    }}
                    disabled={disabled}
                  >
                    Apply
                  </Button>
                </div>
              </div>

              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Day range</div>
                    <div className="text-xs text-muted-foreground">
                      Optional. Use only if you need specific days.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant={dayEnabled ? "default" : "outline"}
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => setDayEnabled((v) => !v)}
                    disabled={disabled}
                  >
                    {dayEnabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>

                {dayEnabled ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div className="space-y-2">
                      <div className="text-sm font-medium">From day</div>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={31}
                        value={dayFrom}
                        onChange={(e) =>
                          setDayFrom(Number(e.target.value || 1))
                        }
                        disabled={disabled}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">To day</div>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={31}
                        value={dayTo}
                        onChange={(e) => setDayTo(Number(e.target.value || 31))}
                        disabled={disabled}
                      />
                    </div>
                    <div className="flex items-end">
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full cursor-pointer"
                        onClick={() => {
                          setMode("absolute");
                          applyMonthDayWindow();
                        }}
                        disabled={disabled}
                      >
                        Apply day range
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "days" ? (
        <div className="rounded-md border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Days from now</div>
            <div className="text-xs text-muted-foreground">
              Inclusive window relative to today (optional).
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <div className="text-sm font-medium">Min days</div>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={value.daysFromNowMin ?? ""}
                onChange={(e) =>
                  onChange({
                    dateStart: null,
                    dateEnd: null,
                    weeksFromNowMin: null,
                    weeksFromNowMax: null,
                    daysFromNowMin:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">Max days</div>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={value.daysFromNowMax ?? ""}
                onChange={(e) =>
                  onChange({
                    dateStart: null,
                    dateEnd: null,
                    weeksFromNowMin: null,
                    weeksFromNowMax: null,
                    daysFromNowMax:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                className="w-full cursor-pointer"
                onClick={() =>
                  onChange({
                    daysFromNowMin: null,
                    daysFromNowMax: null,
                  })
                }
                disabled={disabled}
              >
                Clear
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {mode === "weeks" ? (
        <div className="rounded-md border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Weeks from now</div>
            <div className="text-xs text-muted-foreground">
              Inclusive window relative to today (optional).
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <div className="text-sm font-medium">Min weeks</div>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={value.weeksFromNowMin ?? ""}
                onChange={(e) =>
                  onChange({
                    dateStart: null,
                    dateEnd: null,
                    daysFromNowMin: null,
                    daysFromNowMax: null,
                    weeksFromNowMin:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">Max weeks</div>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={value.weeksFromNowMax ?? ""}
                onChange={(e) =>
                  onChange({
                    dateStart: null,
                    dateEnd: null,
                    daysFromNowMin: null,
                    daysFromNowMax: null,
                    weeksFromNowMax:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                className="w-full cursor-pointer"
                onClick={() =>
                  onChange({
                    weeksFromNowMin: null,
                    weeksFromNowMax: null,
                  })
                }
                disabled={disabled}
              >
                Clear
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
