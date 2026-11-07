import { dateFormat } from "./region";
/** What the last update check said (`updates.rs`). */
export type UpdateStatus = {
  checkedAt: number | null;
  error: string | null;
  version: string | null;
  notes: string | null;
};

/**
 * A failure in words a person can act on. The updater's own message names
 * hosts and sockets; a dropped connection is by far the usual cause.
 */
export function updateFailureReason(error: string): string {
  if (/sending request|dns|connect|timed? ?out|network|offline|resolve/i.test(error)) {
    return "Couldn’t reach GitHub. Check your connection and try again.";
  }
  const trimmed = error.trim().replace(/\s+/g, " ");
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
}

/** "today at 2:51 AM", "yesterday at 9:05 PM", or "4 Nov at 10:00 AM". */
export function checkedWhen(checkedAt: number, now: number, locale?: string): string {
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(checkedAt),
  );
  const startOf = (value: number) => {
    const day = new Date(value);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  const days = Math.round((startOf(now) - startOf(checkedAt)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const date = dateFormat(locale, { day: "numeric", month: "short" }).format(
    new Date(checkedAt),
  );
  return `${date} at ${time}`;
}

/**
 * The line under Check for Updates. Empty before any check: there is
 * nothing true to say yet.
 */
export function updateStatusLine(status: UpdateStatus, now: number, locale?: string): string {
  if (status.checkedAt === null) return "";
  if (status.error) return updateFailureReason(status.error);
  if (status.version) return `Version ${status.version} is ready to install.`;
  return `Up to date. Checked ${checkedWhen(status.checkedAt, now, locale)}.`;
}
