/**
 * The meeting reminder: a card under the menu bar item about a minute before
 * a meeting with a join link starts, with Join and Dismiss. It appears
 * without taking focus and leaves on Join, Dismiss, or a few minutes into
 * the meeting.
 */
import {
  REMINDER_LEAD_MS,
  REMINDER_LINGER_MS,
  reminderEvent,
  spokenDuration,
  reminderStillDue,
  type UpcomingEvent,
} from "../shared/events";
import { installTauriBridge, type DesktopApi } from "./host";
import { sfSymbol } from "./icons";
import { meetingBrand } from "../shared/meetings";
import { meetingIcon } from "./brand-icons";
import { markPopoverMaterial, popoverHeight } from "./popover-size";
import type { AppSettings } from "../shared/settings";

/** Follows Settings' Theme, as the month does, instead of only the system. */
function applyTheme(theme: AppSettings["theme"]): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * "Starts in 1 minute" before the start, "Happening now" once it is under
 * way. Words in full, as the card has room for them and VoiceOver reads it.
 */
export function reminderHeading(event: UpcomingEvent, now: number): string {
  if (now >= event.startAt) return "Happening now";
  return `Starts in ${spokenDuration(event.startAt - now)}`;
}

function occurrenceKey(event: Pick<UpcomingEvent, "id" | "startAt">): string {
  return `${event.id}@${event.startAt}`;
}

export function startReminder(
  api: DesktopApi,
  list: HTMLElement,
  announcer: HTMLElement | null = null,
): void {
  let enabled = false;
  let showing: UpcomingEvent | null = null;
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

  // Escape puts the card away without dismissing the meeting.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && showing) hide();
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
    when.textContent = timeFormat.format(new Date(event.startAt));
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
    }
    nodes.push(
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
    if (showing) {
      if (!enabled || !reminderStillDue(showing, now)) hide();
      else refreshHeading(showing, now);
      return;
    }
    if (!enabled) return;
    try {
      const [events, dismissed] = await Promise.all([
        api.getCalendarEvents(now - REMINDER_LINGER_MS, now + REMINDER_LEAD_MS),
        api.getDismissedEvents().catch(() => []),
      ]);
      if (run !== checking || showing) return;
      const event = reminderEvent(events, now, dismissed, (candidate) =>
        offered.has(occurrenceKey(candidate)),
      );
      if (!event) return;
      paint(event, now);
      // The host holds it back while the month is open, which lists the
      // same meeting; a later tick offers it, until a few minutes in.
      holdHover();
      if (await api.showReminder()) {
        offered.add(occurrenceKey(event));
        showing = event;
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
  void api.getSettings().then((settings) => {
    enabled = settings.remindBeforeMeetings;
    applyTheme(settings.theme);
    void check();
  });
  api.onSettingsChanged((settings) => {
    enabled = settings.remindBeforeMeetings;
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
