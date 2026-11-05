/**
 * The meeting reminder: a card under the menu bar item about a minute before
 * a meeting with a join link starts, with Join and Dismiss. It appears
 * without taking focus and leaves on Join, Dismiss, or a few minutes into
 * the meeting.
 */
import {
  REMINDER_LEAD_MS,
  eventStatus,
  reminderEvent,
  reminderStillDue,
  type UpcomingEvent,
} from "../shared/events";
import { installTauriBridge, type DesktopApi } from "./host";
import { sfSymbol } from "./icons";
import { meetingBrand } from "../shared/meetings";
import { meetingIcon } from "./brand-icons";
import { markPopoverMaterial, popoverHeight } from "./popover-size";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "Starts in 1 min" before the start, "Happening now" once it is under way. */
export function reminderHeading(event: UpcomingEvent, now: number): string {
  const status = eventStatus(event, now);
  if (status.timing === "ongoing") return "Happening now";
  return `Starts ${status.label.replace(/(\d+)m$/, "$1 min")}`;
}

function occurrenceKey(event: Pick<UpcomingEvent, "id" | "startAt">): string {
  return `${event.id}@${event.startAt}`;
}

export function startReminder(api: DesktopApi, list: HTMLElement): void {
  let enabled = false;
  let showing: UpcomingEvent | null = null;
  // Each occurrence is offered once: a dismissed or ignored card stays gone.
  const offered = new Set<string>();
  let checking = 0;

  const hide = (): void => {
    showing = null;
    void api.hideReminder();
  };

  const row = (event: UpcomingEvent): HTMLElement => {
    const element = document.createElement("div");
    element.className = "event interactive";
    element.setAttribute("role", "button");
    element.addEventListener("click", () => {
      void api.openEvent(event.id);
      hide();
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
    element.append(dot, title);
    return element;
  };

  const action = (icon: Element | null, text: string, onClick: () => void): HTMLElement => {
    const button = document.createElement("button");
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

  const paint = (event: UpcomingEvent, now: number): void => {
    const heading = document.createElement("p");
    heading.className = "section-label";
    heading.textContent = reminderHeading(event, now);
    const nodes: HTMLElement[] = [heading, row(event)];
    const url = event.joinUrl;
    if (url) {
      const { brand, label } = meetingBrand(url);
      nodes.push(
        action(meetingIcon(brand, 13), label, () => {
          void api.joinMeeting(url);
          hide();
        }),
      );
    }
    nodes.push(
      action(sfSymbol("eye.slash", 14), "Dismiss", () => {
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
      else paint(showing, now);
      return;
    }
    if (!enabled) return;
    try {
      const [events, dismissed] = await Promise.all([
        api.getCalendarEvents(now, now + REMINDER_LEAD_MS),
        api.getDismissedEvents().catch(() => []),
      ]);
      if (run !== checking || showing) return;
      const event = reminderEvent(events, now, dismissed);
      if (!event || offered.has(occurrenceKey(event))) return;
      paint(event, now);
      // The host holds it back while the month is open, which lists the
      // same meeting; the next tick can still offer it.
      if (await api.showReminder()) {
        offered.add(occurrenceKey(event));
        showing = event;
      }
    } catch {
      // No calendar access yet, or a failed read: try again next minute.
    }
  };

  void markPopoverMaterial(() => api.getPopoverMaterial());
  void api.getSettings().then((settings) => {
    enabled = settings.remindBeforeMeetings;
    void check();
  });
  api.onSettingsChanged((settings) => {
    enabled = settings.remindBeforeMeetings;
    void check();
  });
  api.onClockTick(() => void check());
}

if (typeof document !== "undefined" && document.getElementById("list")) {
  startReminder(installTauriBridge(), document.getElementById("list")!);
}
