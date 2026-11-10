/**
 * The meeting reminder: a card under the menu bar item about a minute before
 * a meeting with a join link starts, with Join and Dismiss. It appears
 * without taking focus and leaves on Join, Dismiss, or a few minutes into
 * the meeting.
 */
import {
  IN_PERSON_LEAD_MS,
  isInPerson,
  occurrenceIsDismissed,
  occurrenceKey,
  REMINDER_LEAD_MS,
  REMINDER_LINGER_MS,
  reminderEvent,
  spokenDuration,
  reminderStillDue,
  type UpcomingEvent,
} from "../shared/events";
import { dateFormat, setRegion } from "../shared/region";
import { installTauriBridge, type DesktopApi } from "./host";
import { sfSymbol } from "./icons";
import { meetingBrand } from "../shared/meetings";
import { meetingIcon } from "./brand-icons";
import { markPopoverMaterial, popoverHeight } from "./popover-size";
import { applyTheme } from "./dom";

/** Built when used, so it follows the region the window read at start. */
const timeFormat = (): Intl.DateTimeFormat =>
  dateFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * "Starts in 1 minute" before the start, "Happening now" once it is under
 * way. Words in full, as the card has room for them and VoiceOver reads it.
 */
export function reminderHeading(event: UpcomingEvent, now: number): string {
  if (now >= event.startAt) return "Happening now";
  return `Starts in ${spokenDuration(event.startAt - now)}`;
}

/**
 * What a clock tick does with the card: put away one that is off or past its
 * time, reword one still due, look for a meeting when none is showing and
 * reminders are on, or nothing.
 */
export function reminderStep(
  showing: Pick<UpcomingEvent, "startAt" | "endAt"> | null,
  enabled: boolean,
  now: number,
  shownAt?: number,
): "hide" | "refresh" | "look" | "idle" {
  if (showing) {
    // A card that came back from a snooze after the start stays its full
    // few minutes from when it came back, not from the start.
    const due =
      shownAt !== undefined && shownAt > showing.startAt
        ? now < Math.min(shownAt + REMINDER_LINGER_MS, showing.endAt)
        : reminderStillDue(showing, now);
    return enabled && due ? "refresh" : "hide";
  }
  return enabled ? "look" : "idle";
}

/** How long "Remind me later" puts the card away. */
export const SNOOZE_MS = 5 * 60_000;

export type Snooze = { event: UpcomingEvent; until: number };

/**
 * The snoozed meeting due back now, if any, and the snoozes still to keep:
 * one whose meeting has ended is dropped.
 */
export function takeDueSnooze(
  snoozes: readonly Snooze[],
  now: number,
): { due: Snooze | null; keep: Snooze[] } {
  const live = snoozes.filter((snooze) => snooze.event.endAt > now);
  const due = live.find((snooze) => snooze.until <= now) ?? null;
  return { due, keep: due ? live.filter((snooze) => snooze !== due) : live };
}

const SNOOZE_STORE = "glance.snoozed";

/** Most snoozes kept at once; a real day never has more than a few. */
const MAX_SNOOZES = 20;

/**
 * The snoozes in a stored value that are whole enough to use. Storage is
 * written by this window alone, but a stray or truncated entry would make
 * every later check throw, and the check swallows its errors: no card would
 * ever show again until the store was cleared by hand.
 */
export function validSnoozes(parsed: unknown): Snooze[] {
  if (!Array.isArray(parsed)) return [];
  const valid: Snooze[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { event, until } = item as { event?: unknown; until?: unknown };
    if (typeof until !== "number" || !Number.isFinite(until)) continue;
    if (typeof event !== "object" || event === null) continue;
    const { id, startAt, endAt, title } = event as Partial<UpcomingEvent>;
    if (typeof id !== "string" || typeof title !== "string") continue;
    if (typeof startAt !== "number" || typeof endAt !== "number") continue;
    valid.push({ event: event as UpcomingEvent, until });
  }
  return valid.slice(0, MAX_SNOOZES);
}

/** Snoozes survive a restart in the card's own storage. */
function loadSnoozes(): Snooze[] {
  try {
    const raw = localStorage.getItem(SNOOZE_STORE);
    return validSnoozes(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function saveSnoozes(snoozes: readonly Snooze[]): void {
  try {
    localStorage.setItem(SNOOZE_STORE, JSON.stringify(snoozes));
  } catch {
    // Storage is a convenience: without it a snooze lasts until a restart.
  }
}

export function startReminder(
  api: DesktopApi,
  list: HTMLElement,
  announcer: HTMLElement | null = null,
): void {
  let enabled = false;
  let inPerson = false;
  let showing: UpcomingEvent | null = null;
  let shownAt = 0;
  let snoozes = loadSnoozes();
  // Each occurrence is offered once: a dismissed or ignored card stays gone.
  const offered = new Set<string>();
  let checking = 0;

  // A card that appears under a still pointer, or one hidden while hovered,
  // shows no hover until the pointer moves.
  const holdHover = (): void => {
    document.documentElement.dataset.pointerAway = "";
  };
  document.addEventListener("mousemove", () => {
    delete document.documentElement.dataset.pointerAway;
  });

  const hide = (): void => {
    holdHover();
    showing = null;
    if (announcer) announcer.textContent = "";
    void api.hideReminder();
  };

  // Escape puts the card away; Return joins, as the card's main action,
  // unless a button has focus and Return is already pressing it.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && showing) hide();
    const onButton = document.activeElement instanceof HTMLButtonElement;
    if (event.key === "Enter" && !onButton && showing?.joinUrl) {
      event.preventDefault();
      const url = showing.joinUrl;
      api.joinMeeting(url).then(hide, () => undefined);
    }
  });

  const row = (event: UpcomingEvent): HTMLElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "event interactive";
    element.addEventListener("click", () => {
      api.openEvent(event.id).then(hide, () => {
        const message = "Couldn’t open this event in Calendar";
        if (heading) heading.textContent = message;
        if (announcer) announcer.textContent = message;
      });
    });
    const dot = document.createElement("span");
    dot.className = `dot ${event.response}`;
    if (event.color) dot.style.setProperty("--event-color", event.color);
    const title = document.createElement("span");
    title.className = "title";
    const when = document.createElement("span");
    when.className = "time";
    when.textContent = timeFormat().format(new Date(event.startAt));
    title.append(when, ` ${event.title}`);
    element.title = `${when.textContent} · ${event.title}`;
    element.setAttribute("aria-label", `Open ${event.title} in Calendar`);
    element.append(dot, title);
    return element;
  };

  const action = (icon: Element | null, text: string, onClick: () => void): HTMLElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "detail-row interactive";
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    if (icon) glyph.append(icon);
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = text;
    button.append(glyph, label);
    button.addEventListener("click", onClick);
    return button;
  };

  let heading: HTMLElement | null = null;

  /** A later minute only rewords the heading: the card is not rebuilt. */
  const refreshHeading = (event: UpcomingEvent, now: number): void => {
    const text = reminderHeading(event, now);
    if (heading && heading.textContent !== text) heading.textContent = text;
  };

  const paint = (event: UpcomingEvent, now: number): void => {
    heading = document.createElement("p");
    heading.className = "section-label";
    heading.textContent = reminderHeading(event, now);
    const nodes: HTMLElement[] = [heading, row(event)];
    const url = event.joinUrl;
    if (url) {
      const { brand, label } = meetingBrand(url);
      const join = action(meetingIcon(brand, 13), label, () => {
        api.joinMeeting(url).then(hide, () => {
          // The card stays, and says why nothing opened.
          const text = join.querySelector(".label");
          if (text) text.textContent = "Couldn’t open the meeting link";
          if (announcer) announcer.textContent = "Couldn’t open the meeting link";
        });
      });
      nodes.push(join);
    } else if (isInPerson(event) && event.location) {
      // Somewhere to go: the place, and a way to find it.
      const place = event.location.trim();
      const maps = action(sfSymbol("map", 14), place, () => {
        api.openInMaps(place).then(hide, () => {
          const text = maps.querySelector(".label");
          if (text) text.textContent = "Couldn’t open Maps";
          if (announcer) announcer.textContent = "Couldn’t open Maps";
        });
      });
      maps.title = `Open ${place} in Maps`;
      maps.setAttribute("aria-label", `Open ${place} in Maps`);
      nodes.push(maps);
    }
    nodes.push(
      // Puts the card away and brings it back in five minutes, Join and all.
      action(sfSymbol("clock", 14), "Remind me in 5 minutes", () => {
        snoozes = [
          ...snoozes.filter((snooze) => occurrenceKey(snooze.event) !== occurrenceKey(event)),
          { event, until: Date.now() + SNOOZE_MS },
        ];
        saveSnoozes(snoozes);
        hide();
      }),
      // Skipping stops the countdown too; Escape only puts the card away.
      action(sfSymbol("eye.slash", 14), "Skip this meeting", () => {
        void api.dismissUpcomingEvent(event.id, event.endAt);
        hide();
      }),
    );
    list.replaceChildren(...nodes);
    const height = popoverHeight(list);
    if (height) void api.setReminderHeight(height);
  };

  const check = async (): Promise<void> => {
    const run = ++checking;
    const now = Date.now();
    const step = reminderStep(showing, enabled, now, shownAt);
    if (step === "hide") hide();
    if (showing && step === "refresh") refreshHeading(showing, now);
    if (step !== "look") return;
    try {
      const [events, dismissed] = await Promise.all([
        api.getCalendarEvents(
          now - REMINDER_LINGER_MS,
          now + (inPerson ? IN_PERSON_LEAD_MS : REMINDER_LEAD_MS),
        ),
        api.getDismissedEvents().catch(() => []),
      ]);
      if (run !== checking || showing) return;
      // A snoozed meeting coming back takes precedence over a new one.
      // Ended meetings drop out now; the due one stays until its card has
      // actually appeared, since the host holds cards back while the month
      // is open.
      const { due, keep } = takeDueSnooze(snoozes, now);
      // A snooze holds the meeting as it was. Skipped from the month since,
      // it stays away; still on, it comes back as Calendar has it now.
      const returning = due && !occurrenceIsDismissed(due.event, dismissed, now)
        ? (events.find((item) => occurrenceKey(item) === occurrenceKey(due.event)) ?? due.event)
        : null;
      const pruned = due && returning ? [...keep, due] : keep;
      if (pruned.length !== snoozes.length) {
        snoozes = pruned;
        saveSnoozes(snoozes);
      }
      const event =
        returning ??
        reminderEvent(
          events,
          now,
          dismissed,
          (candidate) => offered.has(occurrenceKey(candidate)),
          inPerson,
        );
      if (!event) return;
      paint(event, now);
      // The host holds it back while the month is open, which lists the
      // same meeting; a later tick offers it, until a few minutes in.
      holdHover();
      if (await api.showReminder()) {
        offered.add(occurrenceKey(event));
        showing = event;
        shownAt = now;
        if (returning) {
          snoozes = snoozes.filter((snooze) => snooze !== due);
          saveSnoozes(snoozes);
        }
        // Said once, when the card arrives, not again on every minute.
        if (announcer) announcer.textContent = `${reminderHeading(event, now)}: ${event.title}`;
      }
    } catch {
      // No calendar access yet, or a failed read: try again next minute.
    }
  };

  // The host hides the card when the month opens; it is done with then.
  api.onReminderHidden(() => {
    holdHover();
    showing = null;
  });

  void markPopoverMaterial(() => api.getPopoverMaterial());
  void api
    .getSystemRegion()
    .then(setRegion, () => setRegion(null))
    .then(() => api.getSettings())
    .then((settings) => {
      enabled = settings.remindBeforeMeetings;
      inPerson = settings.remindInPerson;
      applyTheme(settings.theme);
      void check();
    });
  api.onSettingsChanged((settings) => {
    enabled = settings.remindBeforeMeetings;
    inPerson = settings.remindInPerson;
    applyTheme(settings.theme);
    void check();
  });
  api.onClockTick(() => void check());
}

if (typeof document !== "undefined" && document.getElementById("list")) {
  startReminder(
    installTauriBridge(),
    document.getElementById("list")!,
    document.getElementById("announce"),
  );
}
