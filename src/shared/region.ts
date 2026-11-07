/**
 * The Mac's language and region (region.rs): the locale dates are written
 * in, and whether the clock is 12- or 24-hour. Each window reads it once at
 * start; until then, and in tests, formats fall back to the webview's own.
 */
export type SystemRegion = {
  locale: string;
  hour12: boolean;
  firstWeekday: number;
  region: string | null;
};

let current: Pick<SystemRegion, "locale" | "hour12"> | null = null;

export function setRegion(region: SystemRegion | null): void {
  current = region ? { locale: region.locale, hour12: region.hour12 } : null;
}

/**
 * A date formatter in the Mac's region. A locale passed in wins and keeps
 * its own clock (tests pass one); otherwise the region's locale is used and
 * any time follows the Mac's 12- or 24-hour setting rather than the
 * language's habit.
 */
export function dateFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  if (locale !== undefined || !current) return new Intl.DateTimeFormat(locale, options);
  const clock = options.hour !== undefined ? { hour12: current.hour12 } : {};
  return new Intl.DateTimeFormat(current.locale, { ...options, ...clock });
}
