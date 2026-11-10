import {
  addDays,
  addMonths,
  buildMonth,
  dayName,
  fromIso,
  chimeDue,
  rowWeekNumber,
  selectionFollowsToday,
  toIso,
} from "../shared/calendar";
import { dateFormat, setRegion } from "../shared/region";
import { menuBarLabel, highlightedColumnRuns, trayLabelKey, type AppSettings } from "../shared/settings";
import {
  endOfToday,
  eventsOnDay,
  coveringRanges,
  dayCountdownEvents,
  nextAfterToday,
  searchEvents,
  isInPerson,
  searchDayTitle,
  SEARCH_DAYS_AHEAD,
  SEARCH_DAYS_BACK,
  comingDayGroups,
  comingDayTitle,
  nextEventWhen,
  eventOverlaps,
  pastToFold,
  trayDescription,
  trayTitle,
  type DismissedOccurrence,
  eventStatus,
  meetingToJoin,
  needsCalendarAccess,
  eventTimeRange,
  trayIconEvent,
  upcomingFetchEnd,
  occurrenceKey,
  type UpcomingEvent,
} from "../shared/events";
import { sfSymbol } from "./icons";
import { meetingBrand } from "../shared/meetings";
import { isTimeZone, zoneCity, zoneShort, zoneTime } from "../shared/zones";
import {
  googleDates,
  parseQuickEvent,
  quickAddAction,
  quickWhen,
  type QuickDraft,
} from "../shared/quick-add";
import { meetingIcon } from "./brand-icons";
import { framedGlyphPng } from "./tray-frame";
import { boxHeight, markPopoverMaterial } from "./popover-size";
import { bandBox } from "./column-bands";
import { installTauriBridge, type DesktopApi } from "./host";
import { applyTheme, requireElement } from "./dom";

function announce(message: string): void {
  requireElement("live").textContent = message;
}

/**
 * Rebuilds part of the window without losing the keyboard or VoiceOver
 * where they were. Focusable things carry a `data-focus-key`; after the
 * rebuild, the element with the same key takes focus back, or `fallback`'s
 * key when that one is gone (a dismiss button that went with its click).
 */
function keepingFocus(
  container: HTMLElement,
  rebuild: () => void,
  fallback: (key: string) => string | null = () => null,
): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && container.contains(active)
      ? active.dataset.focusKey
      : undefined;
  rebuild();
  if (!key) return;
  const find = (wanted: string) =>
    container.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(wanted)}"]`);
  const backup = fallback(key);
  (find(key) ?? (backup ? find(backup) : null))?.focus();
}

function paintColumnHighlights(
  table: HTMLTableElement,
  wrap: HTMLElement,
  settings: AppSettings,
): void {
  const layer = wrap.querySelector(".column-highlights");
  const headers = Array.from(
    table.querySelectorAll<HTMLElement>("thead th.weekday"),
  );
  const firstBody = table.querySelector<HTMLElement>("tbody tr");
  const lastRow = table.querySelector<HTMLElement>("tbody tr:last-child");
  if (!layer || headers.length < 7 || !firstBody || !lastRow) return;
  const wrapRect = wrap.getBoundingClientRect();
  const rows = {
    top: firstBody.getBoundingClientRect().top,
    bottom: lastRow.getBoundingClientRect().bottom,
  };
  layer.replaceChildren(
    ...highlightedColumnRuns(settings.weekStartsOn, settings.highlightWeekdays).flatMap(
      (run) => {
        const start = headers[run.start];
        const end = headers[run.start + run.count - 1];
        if (!start || !end) return [];
        const box = bandBox(
          {
            left: start.getBoundingClientRect().left,
            right: end.getBoundingClientRect().right,
          },
          rows,
          { left: wrapRect.left, top: wrapRect.top },
        );
        const band = document.createElement("div");
        band.className = "column-highlight";
        band.style.left = `${box.left}px`;
        band.style.width = `${box.width}px`;
        band.style.top = `${box.top}px`;
        band.style.height = `${box.height}px`;
        return [band];
      },
    ),
  );
}

function startCalendar(api: DesktopApi): void {
  const monthLabel = requireElement<HTMLHeadingElement>("month-label");
  const grid = requireElement<HTMLDivElement>("grid");
  const prev = requireElement<HTMLButtonElement>("prev-month");
  const todayButton = requireElement<HTMLButtonElement>("today-month");
  const next = requireElement<HTMLButtonElement>("next-month");
  const dayEvents = requireElement<HTMLElement>("day-events");
  const dayEventsTitle = requireElement<HTMLElement>("day-events-title");
  const dayEventsCount = requireElement<HTMLElement>("day-events-count");
  const dayEventsList = requireElement<HTMLElement>("day-events-list");
  const openSettings = requireElement<HTMLButtonElement>("open-settings");
  const openSearch = requireElement<HTMLButtonElement>("open-search");
  const search = requireElement<HTMLElement>("search");
  const searchInput = requireElement<HTMLInputElement>("search-input");
  const searchResults = requireElement<HTMLElement>("search-results");
  openSearch.append(sfSymbol("magnifyingglass", 13));
  const openQuickAdd = requireElement<HTMLButtonElement>("open-quick-add");
  const quickAdd = requireElement<HTMLElement>("quick-add");
  const quickAddInput = requireElement<HTMLInputElement>("quick-add-input");
  const quickAddPreview = requireElement<HTMLElement>("quick-add-preview");
  openQuickAdd.append(sfSymbol("plus", 13));
  openSettings.append(sfSymbol("gearshape", 14));
  const toolHint = requireElement<HTMLElement>("tool-hint");
  const tools = [openQuickAdd, openSearch, openSettings];
  // The middle of the footer names the tool pointed at, with its shortcut;
  // otherwise, while a panel is open, how to close it.
  const paintToolHint = (tool?: HTMLButtonElement): void => {
    if (tool?.dataset.hint) {
      const key = document.createElement("kbd");
      key.textContent = tool.dataset.key ?? "";
      toolHint.replaceChildren(tool.dataset.hint, key);
    } else {
      toolHint.textContent = search.hidden && quickAdd.hidden ? "" : "esc to close";
    }
  };
  for (const tool of tools) {
    tool.addEventListener("pointerenter", () => paintToolHint(tool));
    tool.addEventListener("pointerleave", () => paintToolHint());
    tool.addEventListener("focus", () => {
      if (document.documentElement.hasAttribute("data-keyboard")) paintToolHint(tool);
    });
    tool.addEventListener("blur", () => paintToolHint());
  }
  prev.append(sfSymbol("chevron.left", 12));
  next.append(sfSymbol("chevron.right", 12));

  let settings: AppSettings | null = null;
  let viewYear = new Date().getFullYear();
  let viewMonth = new Date().getMonth();
  let focusIso = toIso(new Date());
  // Outside-day clicks keep a selection ring without changing month. Month
  // chevrons must not reuse that ring on a spillover cell like "today, 10".
  let pinnedOutsideIso: string | null = null;
  let lastTrayLabel = "";
  let lastHour = new Date().getHours();
  let upcomingEvent: UpcomingEvent | null = null;
  let calendarEvents: UpcomingEvent[] = [];
  let eventError: string | null = null;
  let eventRequest = 0;
  // Which way the month just moved, so the grid can slide in from that side.
  let slide = 0;
  // The day the grid was last drawn for, and what the events looked like, so
  // opening the popover redraws nothing that is already right on screen.
  let renderedDay = "";
  let eventsKey = "";
  // What the day list last drew, so a minute that changes nothing leaves it,
  // and whatever has focus in it, alone.
  let dayEventsKey = "";
  let dismissedEvents: DismissedOccurrence[] = [];
  // Today's finished meetings fold into one line until it is opened; the
  // fold closes again with the popover.
  let pastOpen = false;
  // Quick add reads the line as you type; Return acts on the latest read.
  let quickDraft: QuickDraft | null = null;
  let quickRequest = 0;
  let quickBusy = false;
  // The event quick add just made, offered for Undo for a few seconds.
  let added: { id: string; day: string; title: string } | null = null;
  let addedTimer = 0;
  /** How long "Added · Undo" stays beside the day an event went to. */
  const UNDO_MS = 30_000;
  // Search reads its window once when it opens, then filters as you type.
  let searchPool: UpcomingEvent[] | null = null;
  let searchRequest = 0;
  // A failed open or join says so in the heading for a few seconds.
  let failure: string | null = null;
  let failureTimer = 0;

  // The month's events always load, for the dots and the day list. The
  // menu bar preview is the part the Upcoming setting turns on.
  const refreshUpcoming = async (): Promise<void> => {
    const request = ++eventRequest;
    const current = settings;
    if (!current) return;
    try {
      const now = Date.now();
      // Spill a week either side, so outside days get their dots too. The
      // selected day stays selected when the month changes, so its list
      // must not empty out: fetch it as well when it lies outside.
      const rangeStart = new Date(viewYear, viewMonth, -6).getTime();
      const rangeEnd = new Date(viewYear, viewMonth + 1, 14).getTime();
      const selected = fromIso(focusIso);
      const selectedStart = new Date(
        selected.getFullYear(),
        selected.getMonth(),
        selected.getDate(),
      ).getTime();
      const selectedEnd = new Date(
        selected.getFullYear(),
        selected.getMonth(),
        selected.getDate() + 1,
      ).getTime();
      const month = { start: rangeStart, end: rangeEnd };
      const day = { start: selectedStart, end: selectedEnd };
      const upcoming = current.showUpcomingEvent
        ? {
            start: now,
            end: upcomingFetchEnd(now, current.upcomingHorizonDays, current.upcomingIconLeadMinutes),
          }
        : null;
      // One read covers the month, the selected day and the countdown's
      // window whenever they overlap, as they do on the current month.
      const reads = coveringRanges(upcoming ? [month, day, upcoming] : [month, day]);
      const [batches, dismissed] = await Promise.all([
        Promise.all(reads.map((range) => api.getCalendarEvents(range.start, range.end))),
        // The day list leaves dismissed meetings unmarked, countdown on or off.
        api.getDismissedEvents().catch(() => []),
      ]);
      const seen = new Set<string>();
      const all = batches.flat().filter((event) => {
        const key = occurrenceKey(event);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const next = upcoming
        ? trayIconEvent(
            all.filter((event) => eventOverlaps(event, upcoming)),
            now,
            {
              upcomingHorizonDays: current.upcomingHorizonDays,
              upcomingIconLeadMinutes: current.upcomingIconLeadMinutes,
              filters: current,
              dismissed,
            },
          )
        : null;
      if (request !== eventRequest) return;
      upcomingEvent = next;
      dismissedEvents = dismissed;
      const fetched = all.filter(
        (event) => eventOverlaps(event, month) || eventOverlaps(event, day),
      );
      const key = JSON.stringify(
        fetched.map((event) => [
          event.id,
          event.startAt,
          event.endAt,
          event.title,
          event.joinUrl,
          event.response,
        ]),
      );
      const unchanged = key === eventsKey && eventError === null;
      eventsKey = key;
      calendarEvents = fetched;
      eventError = null;
      if (unchanged) {
        refreshTray();
        paintDayEvents();
        return;
      }
    } catch (error) {
      if (request !== eventRequest) return;
      upcomingEvent = null;
      calendarEvents = [];
      eventsKey = "";
      eventError = error instanceof Error ? error.message : String(error);
    }
    refreshTray();
    render();
    paintDayEvents();
  };

  // The window is sized from its content, so it grows with the day's list
  // and shrinks back for an empty day.
  const syncHeight = (): void => {
    const popover = document.querySelector<HTMLElement>(".popover");
    if (!popover) return;
    const frame = getComputedStyle(popover);
    let height = parseFloat(frame.paddingTop) + parseFloat(frame.paddingBottom);
    for (const child of Array.from(popover.children) as HTMLElement[]) {
      if (child.hidden || getComputedStyle(child).position === "absolute") continue;
      // The footer's top margin is auto: it soaks up whatever room is left,
      // so counting it would feed the last height into the next one.
      height += child.classList.contains("calendar-footer")
        ? child.offsetHeight
        : boxHeight(child);
    }
    if (height) void api.setCalendarHeight(Math.ceil(height));
  };

  const requestAccess = async (button: HTMLButtonElement): Promise<void> => {
    button.disabled = true;
    try {
      await api.requestCalendarAccess();
      await refreshUpcoming();
    } finally {
      button.disabled = false;
    }
  };

  const dayEventRow = (event: UpcomingEvent, now: number, isNext: boolean): HTMLElement => {
    const row = document.createElement("div");
    row.className = "day-event";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "day-event-open";
    // A long name is cut short in the row; the tooltip carries it whole.
    open.title = event.title;
    const occurrence = occurrenceKey(event);
    open.dataset.focusKey = `open:${occurrence}`;
    const dot = document.createElement("span");
    dot.className = "day-event-dot";
    dot.setAttribute("aria-hidden", "true");
    if (event.color) dot.style.setProperty("--event-color", event.color);
    const title = document.createElement("span");
    title.className = "day-event-title";
    title.textContent = event.title;
    const time = document.createElement("span");
    time.className = "day-event-time";
    time.textContent = eventTimeRange(event);
    // The start in the second zone too: "4:00 – 4:30 PM · 6:30 AM New York".
    const zone = settings?.secondTimeZone ?? "";
    if (zone && !event.allDay && isTimeZone(zone)) {
      time.append(` \u00b7 ${zoneTime(event.startAt, zone)} ${zoneCity(zone)}`);
    }
    if (isNext) {
      const when = document.createElement("span");
      when.className = "day-event-when";
      when.textContent = eventStatus(event, now).label;
      time.append(when);
      row.classList.add("is-next");
    }
    // Declined and tentative read as Calendar draws them. Unanswered looks
    // like any other meeting: plenty of teams never reply to their own.
    if (event.response === "declined" || event.response === "tentative") {
      row.classList.add(`is-${event.response}`);
      const said = document.createElement("span");
      said.className = "visually-hidden";
      said.textContent = `, ${event.response}`;
      title.append(said);
    }
    open.append(dot, title, time);
    open.addEventListener("click", () => {
      api.openEvent(event.id).then(
        () => api.hideCalendar(),
        () => showFailure("Couldn’t open this event in Calendar"),
      );
    });
    row.append(open);
    if (event.joinUrl && event.endAt > now) {
      const url = event.joinUrl;
      const join = document.createElement("button");
      join.type = "button";
      join.className = "day-event-join";
      join.dataset.focusKey = `join:${occurrence}`;
      // Join is the service's own icon, so the row says which call it opens:
      // Meet, Zoom, Teams. Its name is in the tooltip and for VoiceOver.
      const { brand, label } = meetingBrand(url);
      join.append(meetingIcon(brand, 16));
      join.title = label;
      join.setAttribute("aria-label", `${label}: ${event.title}`);
      join.addEventListener("click", () => {
        api.joinMeeting(url).then(
          () => api.hideCalendar(),
          () => showFailure("Couldn’t open the meeting link"),
        );
      });
      row.append(join);
    }
    // The meeting the menu bar is counting down to can be let go of here,
    // so a skipped meeting stops sitting beside the date.
    if (
      upcomingEvent &&
      upcomingEvent.id === event.id &&
      upcomingEvent.endAt === event.endAt &&
      event.endAt > now
    ) {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "day-event-dismiss";
      dismiss.dataset.focusKey = `dismiss:${occurrence}`;
      dismiss.setAttribute("aria-label", `Stop counting down to ${event.title}`);
      dismiss.title = "Stop counting down";
      dismiss.append(sfSymbol("eye.slash", 13));
      dismiss.addEventListener("click", () => {
        void api.dismissUpcomingEvent(event.id, event.endAt);
      });
      // Join stays at the edge, where it sits on every other row.
      row.insertBefore(dismiss, row.querySelector(".day-event-join"));
    }
    if (event.endAt <= now) row.classList.add("is-past");
    return row;
  };

  const paintDayEvents = (): void => {
    dayEvents.hidden = !search.hidden || !quickAdd.hidden;
    const selectedDate = fromIso(focusIso);
    const now = Date.now();
    const listed = eventsOnDay(calendarEvents, selectedDate);
    const isToday = focusIso === toIso(new Date(now));
    const counting = new Set(
      isToday ? dayCountdownEvents(listed, now, upcomingEvent, dismissedEvents) : [],
    );
    const folded = isToday && !pastOpen ? pastToFold(listed, now) : [];
    const comingDays = settings?.comingDays ?? 0;
    const coming = isToday && comingDays ? comingDayGroups(calendarEvents, now, comingDays) : [];
    // With the coming days listed, the single "Next:" line would repeat them.
    const upNext =
      isToday && !comingDays && !listed.some((event) => !event.allDay && event.endAt > now)
        ? nextAfterToday(calendarEvents, now)
        : null;
    const key = JSON.stringify([
      focusIso,
      eventError,
      upNext && [upNext.id, upNext.startAt, upNext.title],
      coming.map((group) => [
        group.day.getTime(),
        group.events.map((event) => [event.id, event.startAt, event.endAt, event.title, event.joinUrl]),
      ]),
      failure,
      added && added.day === focusIso && added.id,
      folded.length,
      upcomingEvent && [upcomingEvent.id, upcomingEvent.endAt],
      listed.map((event) => [
        event.id,
        event.startAt,
        event.endAt,
        event.title,
        event.joinUrl,
        event.color,
        event.response,
        event.endAt <= now,
        counting.has(event) ? eventStatus(event, now).label : "",
      ]),
    ]);
    if (key === dayEventsKey) return;
    dayEventsKey = key;
    keepingFocus(
      dayEventsList,
      () => paintDayEventRows(selectedDate, listed, counting, new Set(folded), now, upNext, coming),
      (lost) => {
        if (lost.startsWith("dismiss:")) return `open:${lost.slice("dismiss:".length)}`;
        // Opening the fold hands focus to the first meeting it showed.
        if (lost === "fold" && listed[0]) return `open:${listed[0].id}@${listed[0].startAt}`;
        return null;
      },
    );
    syncHeight();
  };

  const paintDayEventRows = (
    selectedDate: Date,
    selectedEvents: UpcomingEvent[],
    next: Set<UpcomingEvent>,
    folded: Set<UpcomingEvent>,
    now: number,
    upNext: UpcomingEvent | null,
    coming: { day: Date; events: UpcomingEvent[] }[],
  ): void => {
    dayEventsTitle.textContent = dateFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(selectedDate);
    dayEventsCount.classList.toggle("is-failure", failure !== null);
    // The message takes the whole line for its few seconds, rather than
    // squeezing the date to "Frid…".
    dayEventsCount.parentElement?.classList.toggle("is-failing", failure !== null);
    dayEventsCount.textContent =
      failure ??
      (selectedEvents.length
        ? `${selectedEvents.length} event${selectedEvents.length === 1 ? "" : "s"}`
        : "");
    if (!failure && added && added.day === toIso(selectedDate)) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "day-events-undo";
      undo.textContent = "Undo";
      undo.dataset.focusKey = "undo";
      undo.setAttribute("aria-label", `Undo adding ${added.title}`);
      undo.addEventListener("click", () => void undoAdded());
      dayEventsCount.replaceChildren("Added ·", undo);
    }
    if (eventError) {
      // Only a missing permission is fixed by asking for one; any other
      // failure is offered again instead of a prompt that would not help.
      const needsAccess = needsCalendarAccess(eventError);
      const action = document.createElement("button");
      action.type = "button";
      action.className = "menu-row";
      action.textContent = needsAccess ? "Allow Calendar Access…" : "Couldn’t Load Events. Try Again";
      action.addEventListener("click", () =>
        void (needsAccess ? requestAccess(action) : refreshUpcoming()),
      );
      dayEventsList.replaceChildren(action);
    } else if (!selectedEvents.length) {
      const empty = document.createElement("p");
      empty.className = "day-events-empty";
      empty.textContent = "No Events";
      dayEventsList.replaceChildren(
        empty,
        ...(upNext ? [upNextRow(upNext, now)] : []),
        ...comingRows(coming, now),
      );
    } else {
      // On today, the meeting that is on or comes next says how soon, and so
      // does every other one at that same moment.
      const rows = selectedEvents
        .filter((event) => !folded.has(event))
        .map((event) => dayEventRow(event, now, next.has(event)));
      if (folded.size) rows.unshift(foldRow(folded.size));
      // A day with nothing left on it says what comes after it.
      if (upNext) rows.push(upNextRow(upNext, now));
      rows.push(...comingRows(coming, now));
      dayEventsList.replaceChildren(...rows);
    }
  };

  /** The coming days under today: a small heading per day, then its rows. */
  const comingRows = (
    coming: { day: Date; events: UpcomingEvent[] }[],
    now: number,
  ): HTMLElement[] =>
    coming.flatMap((group) => {
      const title = document.createElement("p");
      title.className = "day-events-coming";
      title.textContent = comingDayTitle(group.day, now);
      return [title, ...group.events.map((event) => dayEventRow(event, now, false))];
    });

  /** "Next: Tomorrow, 11:45 AM · Stand-up": opens that day when clicked. */
  const upNextRow = (event: UpcomingEvent, now: number): HTMLElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "day-events-next";
    row.dataset.focusKey = "up-next";
    const when = document.createElement("span");
    when.className = "day-events-next-when";
    when.textContent = `Next: ${nextEventWhen(event, now)}`;
    const title = document.createElement("span");
    title.className = "day-events-next-title";
    title.textContent = event.title;
    row.append(when, title);
    row.title = `Show ${event.title}`;
    row.addEventListener("click", () => showDay(new Date(event.startAt)));
    return row;
  };

  /** Selects a day, turning the month to it when it lies in another. */
  const showDay = (day: Date): void => {
    focusIso = toIso(day);
    pinnedOutsideIso = null;
    if (day.getMonth() !== viewMonth || day.getFullYear() !== viewYear) {
      slide = Math.sign(
        day.getFullYear() * 12 + day.getMonth() - (viewYear * 12 + viewMonth),
      );
      viewYear = day.getFullYear();
      viewMonth = day.getMonth();
    }
    render({ focusGrid: true });
    paintDayEvents();
    void refreshUpcoming();
  };

  const searchMessage = (text: string): HTMLElement => {
    const message = document.createElement("p");
    message.className = "day-events-empty";
    message.textContent = text;
    return message;
  };

  /** One result: its time and title; a click closes search on its day. */
  const searchRow = (event: UpcomingEvent): HTMLElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "day-events-next";
    const when = document.createElement("span");
    when.className = "day-events-next-when";
    const time = event.allDay
      ? "All day"
      : dateFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(event.startAt));
    // A call's "location" is often just the service's name; only a place shows.
    when.textContent = isInPerson(event) ? `${time} · ${event.location!.trim()}` : time;
    const title = document.createElement("span");
    title.className = "day-events-next-title";
    title.textContent = event.title;
    row.append(when, title);
    row.title = `Show ${event.title}`;
    row.addEventListener("click", () => {
      closeSearch(false);
      showDay(new Date(event.startAt));
    });
    return row;
  };

  const paintSearch = (): void => {
    const query = searchInput.value.trim();
    if (!searchPool) {
      searchResults.replaceChildren(searchMessage("Searching…"));
    } else if (!query) {
      searchResults.replaceChildren();
    } else {
      const now = Date.now();
      const groups = searchEvents(searchPool, query, now);
      searchResults.replaceChildren(
        ...(groups.length
          ? groups.flatMap((group) => {
              const title = document.createElement("p");
              title.className = "day-events-coming";
              title.textContent = searchDayTitle(group.day, now);
              return [title, ...group.events.map(searchRow)];
            })
          : [searchMessage("No Matching Events")]),
      );
    }
    syncHeight();
  };

  const searchIsOpen = (): boolean => !search.hidden;

  const openSearchPanel = (): void => {
    if (searchIsOpen()) {
      searchInput.focus();
      searchInput.select();
      return;
    }
    closeQuickAdd(false);
    search.hidden = false;
    dayEvents.hidden = true;
    openSearch.setAttribute("aria-expanded", "true");
    paintToolHint();
    searchInput.value = "";
    searchPool = null;
    paintSearch();
    searchInput.focus();
    const request = ++searchRequest;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - SEARCH_DAYS_BACK);
    const end = new Date(today);
    end.setDate(end.getDate() + SEARCH_DAYS_AHEAD + 1);
    api.getCalendarEvents(start.getTime(), end.getTime()).then(
      (events) => {
        if (request !== searchRequest || !searchIsOpen()) return;
        searchPool = events;
        paintSearch();
      },
      () => {
        if (request !== searchRequest || !searchIsOpen()) return;
        searchPool = [];
        searchResults.replaceChildren(searchMessage("Couldn’t Load Events"));
        syncHeight();
      },
    );
  };

  const quickAddIsOpen = (): boolean => !quickAdd.hidden;

  const quickLine = (className: string, text: string): HTMLElement => {
    const line = document.createElement("span");
    line.className = className;
    line.textContent = text;
    return line;
  };

  /** What Return will do: the event as read, and where it will go. */
  const paintQuickAdd = (message?: { text: string; failure?: boolean }): void => {
    const lines: HTMLElement[] = [];
    if (message) {
      lines.push(quickLine(`quick-add-hint${message.failure ? " is-failure" : ""}`, message.text));
    } else if (!quickAddInput.value.trim()) {
      lines.push(quickLine("quick-add-hint", "Type what and when; Return adds it."));
    } else if (!quickDraft) {
      lines.push(quickLine("quick-add-hint", "Add a day or time, like “tomorrow 3pm”."));
    } else {
      const draft = quickDraft;
      const action = quickAddAction(draft, settings?.meetingLink ?? "");
      lines.push(quickLine("quick-add-title", draft.title));
      const where = [quickWhen(draft), draft.location].filter(Boolean).join(" · ");
      lines.push(quickLine("quick-add-detail", where));
      if (action.kind === "google") {
        const who = draft.guests.length
          ? `${draft.guests.length} guest${draft.guests.length === 1 ? "" : "s"}`
          : "Google Meet";
        lines.push(quickLine("quick-add-hint", `${who} · Return opens it in Google Calendar to send`));
      } else if (action.url) {
        lines.push(quickLine("quick-add-hint", `With your ${meetingBrand(action.url).label.replace(/^Join /, "")} link · Return adds it`));
      } else if (draft.call) {
        lines.push(quickLine("quick-add-hint", "Add your meeting link in Settings to attach it · Return adds it"));
      } else {
        lines.push(quickLine("quick-add-hint", "Return adds it to your calendar"));
      }
    }
    quickAddPreview.replaceChildren(...lines);
    syncHeight();
  };

  /** Reads the line: macOS finds the date, the rest is read here. */
  const readQuickAdd = async (): Promise<void> => {
    const request = ++quickRequest;
    const text = quickAddInput.value;
    if (!text.trim()) {
      quickDraft = null;
      paintQuickAdd();
      return;
    }
    const dates = await api.detectDates(text).catch(() => []);
    if (request !== quickRequest) return;
    quickDraft = parseQuickEvent(text, dates, Date.now());
    paintQuickAdd();
  };

  const openQuickAddPanel = (): void => {
    closeSearch(false);
    if (quickAddIsOpen()) {
      quickAddInput.focus();
      quickAddInput.select();
      return;
    }
    quickAdd.hidden = false;
    dayEvents.hidden = true;
    openQuickAdd.setAttribute("aria-expanded", "true");
    paintToolHint();
    quickAddInput.value = "";
    quickDraft = null;
    paintQuickAdd();
    quickAddInput.focus();
  };

  const closeQuickAdd = (refocus: boolean): void => {
    if (!quickAddIsOpen()) return;
    quickRequest++;
    quickAdd.hidden = true;
    dayEvents.hidden = !search.hidden;
    openQuickAdd.setAttribute("aria-expanded", "false");
    paintToolHint();
    quickDraft = null;
    paintDayEvents();
    syncHeight();
    if (refocus) openQuickAdd.focus();
  };

  /** Return: add the event here, or hand a meeting to Google Calendar. */
  const submitQuickAdd = async (): Promise<void> => {
    if (quickBusy) return;
    // The latest keystroke may still be being read.
    await readQuickAdd();
    const draft = quickDraft;
    if (!draft) return;
    const action = quickAddAction(draft, settings?.meetingLink ?? "");
    quickBusy = true;
    try {
      if (action.kind === "google") {
        await api.openGoogleEvent({
          title: draft.title,
          dates: googleDates(draft),
          location: draft.location,
          guests: draft.guests,
        });
        closeQuickAdd(false);
        void api.hideCalendar();
        return;
      }
      const id = await api.createEvent({
        title: draft.title,
        startAt: draft.startAt,
        endAt: draft.endAt,
        allDay: draft.allDay,
        location: draft.location,
        url: action.url,
      });
      closeQuickAdd(false);
      const day = new Date(draft.startAt);
      added = { id, day: toIso(day), title: draft.title };
      window.clearTimeout(addedTimer);
      addedTimer = window.setTimeout(() => {
        added = null;
        paintDayEvents();
      }, UNDO_MS);
      announce(`Added ${draft.title}, ${quickWhen(draft)}`);
      showDay(day);
    } catch (error) {
      paintQuickAdd({
        text: error instanceof Error ? error.message : String(error),
        failure: true,
      });
    } finally {
      quickBusy = false;
    }
  };

  /** Removes the event just added, while its Undo is still showing. */
  const undoAdded = async (): Promise<void> => {
    const last = added;
    if (!last) return;
    added = null;
    window.clearTimeout(addedTimer);
    try {
      await api.undoCreatedEvent(last.id);
      announce(`Removed ${last.title}`);
    } catch {
      failure = "Couldn’t undo";
      window.clearTimeout(failureTimer);
      failureTimer = window.setTimeout(() => {
        failure = null;
        paintDayEvents();
      }, 4_000);
    }
    void refreshUpcoming();
    paintDayEvents();
  };

  /** Back to the day list; the search button takes focus when asked. */
  const closeSearch = (refocus: boolean): void => {
    if (!searchIsOpen()) return;
    searchRequest++;
    search.hidden = true;
    dayEvents.hidden = !quickAdd.hidden;
    openSearch.setAttribute("aria-expanded", "false");
    paintToolHint();
    searchPool = null;
    searchResults.replaceChildren();
    paintDayEvents();
    syncHeight();
    if (refocus) openSearch.focus();
  };

  /** "2 earlier": today's finished meetings, folded until asked for. */
  const foldRow = (count: number): HTMLElement => {
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "day-events-fold";
    fold.dataset.focusKey = "fold";
    fold.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = `${count} earlier`;
    fold.append(label, sfSymbol("chevron.right", 10));
    fold.title = `Show ${count} meetings that have ended`;
    fold.addEventListener("click", () => {
      pastOpen = true;
      paintDayEvents();
    });
    return fold;
  };

  const showFailure = (message: string): void => {
    failure = message;
    announce(message);
    paintDayEvents();
    window.clearTimeout(failureTimer);
    failureTimer = window.setTimeout(() => {
      failure = null;
      paintDayEvents();
    }, 4000);
  };

  const refreshTray = (): void => {
    if (!settings) return;
    const now = new Date();
    const label = menuBarLabel(settings, now);
    // The status item carries the real pressed highlight now, so the title
    // stays as it reads when the popover is closed. The cutout style draws
    // its date into the glyph instead of the title.
    const counting = upcomingEvent && now.getTime() < upcomingEvent.endAt ? upcomingEvent : null;
    const title = trayTitle(
      label.style === "framed" ? null : label.text,
      counting,
      now.getTime(),
      {
        showTitle: settings.showEventTitleInMenuBar,
        showTime: settings.showEventTimeInMenuBar,
      },
      undefined,
      label.style === "filled" || label.style === "calendar",
    );
    // The second zone's time follows, when Settings puts it in the menu bar.
    const zone = settings.secondTimeZone;
    const zonePiece =
      settings.secondTimeZoneInMenuBar && zone && isTimeZone(zone)
        ? `\u2022 ${zoneShort(zone)} ${zoneTime(now.getTime(), zone)}`
        : "";
    const fullTitle = [title, zonePiece].filter(Boolean).join(" ");
    const trayStyle = label.style;
    const description = trayDescription(now.getTime(), counting);
    const signature = `${trayLabelKey(label)}|${fullTitle}|${description}`;
    if (signature === lastTrayLabel) return;
    lastTrayLabel = signature;
    // The cutout style draws its date into the glyph instead of the title.
    const framed = label.style === "framed" ? label.text : null;
    void api.setTrayLabel(
      fullTitle || null,
      label.day,
      trayStyle,
      framed === null ? null : framedGlyphPng(framed),
      description,
    );
  };

  const render = (opts?: { announceMonth?: boolean; focusGrid?: boolean }): void => {
    if (!settings) return;
    const today = new Date();
    const month = buildMonth(viewYear, viewMonth, settings.weekStartsOn, today);
    // As Calendar titles a month: the name in full, the year lighter.
    const monthName = document.createElement("span");
    monthName.className = "month-name";
    monthName.textContent = dateFormat(undefined, { month: "long" }).format(
      new Date(viewYear, viewMonth, 1),
    );
    const year = document.createElement("span");
    year.className = "month-year";
    year.textContent = String(viewYear);
    monthLabel.replaceChildren(monthName, " ", year);

    const table = document.createElement("table");
    table.className = settings.showWeekNumbers ? "grid with-weeks" : "grid";
    table.setAttribute("role", "grid");
    table.setAttribute("aria-labelledby", "month-label");

    const caption = document.createElement("caption");
    caption.className = "visually-hidden";
    caption.textContent = month.label;
    table.append(caption);

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    if (settings.showWeekNumbers) {
      const corner = document.createElement("th");
      corner.scope = "col";
      corner.className = "weeknum";
      const weekLabel = document.createElement("span");
      weekLabel.className = "visually-hidden";
      weekLabel.textContent = "Week";
      corner.append(weekLabel);
      headRow.append(corner);
    }
    for (const label of month.weekdayLabels) {
      const header = document.createElement("th");
      header.scope = "col";
      header.className = "weekday";
      header.title = label.long;
      const hidden = document.createElement("span");
      hidden.className = "visually-hidden";
      hidden.textContent = label.long;
      const visible = document.createElement("span");
      visible.setAttribute("aria-hidden", "true");
      visible.textContent = label.narrow;
      header.append(hidden, visible);
      headRow.append(header);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    for (const week of month.weeks) {
      const row = document.createElement("tr");
      if (settings.showWeekNumbers) {
        const number = document.createElement("th");
        number.scope = "row";
        number.className = "weeknum";
        number.textContent = String(rowWeekNumber(week, settings.weekNumbering) ?? "");
        row.append(number);
      }
      for (const day of week) {
        const cell = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "day";
        button.dataset.iso = day.iso;
        button.dataset.focusKey = `day:${day.iso}`;
        const number = document.createElement("span");
        number.className = "day-number";
        number.textContent = String(day.day);
        button.append(number);
        // One quiet mark says "something here"; the list says what.
        const dayEventList = eventsOnDay(calendarEvents, fromIso(day.iso));
        if (dayEventList.length) {
          const mark = document.createElement("span");
          mark.className = "day-mark";
          mark.setAttribute("aria-hidden", "true");
          button.append(mark);
        }
        const count = dayEventList.length;
        button.setAttribute(
          "aria-label",
          count
            ? `${dayName(fromIso(day.iso))}, ${count} event${count === 1 ? "" : "s"}`
            : dayName(fromIso(day.iso)),
        );
        if (day.inMonth) button.classList.add("is-in-month");
        else button.classList.add("is-outside");
        if (day.isToday && day.inMonth) {
          button.classList.add("is-today");
          button.setAttribute("aria-current", "date");
        }
        const focused =
          day.iso === focusIso && (day.inMonth || day.iso === pinnedOutsideIso);
        if (focused) button.classList.add("is-selected");
        button.tabIndex = focused ? 0 : -1;
        // Selection belongs to the grid cell, not the button inside it.
        cell.setAttribute("aria-selected", focused ? "true" : "false");
        button.addEventListener("click", () => {
          focusIso = day.iso;
          pinnedOutsideIso = day.inMonth ? null : day.iso;
          // Picking a day means its list, so search makes way for it.
          closeSearch(false);
          closeQuickAdd(false);
          render({ focusGrid: true });
          paintDayEvents();
        });
        cell.append(button);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);

    const wrap = document.createElement("div");
    wrap.className = "month";
    const bands = document.createElement("div");
    bands.className = "column-highlights";
    bands.setAttribute("aria-hidden", "true");
    wrap.append(bands, table);
    if (slide) wrap.classList.add(slide > 0 ? "slide-next" : "slide-prev");
    slide = 0;
    // A redraw while a day has focus (new events, a new day) hands focus to
    // the selected day rather than dropping it on the window.
    const hadFocus = grid.contains(document.activeElement);
    grid.replaceChildren(wrap);
    // Only offered once there is somewhere to go back from.
    const todayIso = toIso(today);
    todayButton.classList.toggle(
      "is-hidden",
      viewYear === today.getFullYear() && viewMonth === today.getMonth() && focusIso === todayIso,
    );
    paintColumnHighlights(table, wrap, settings);
    renderedDay = todayIso;
    // The month can gain or lose a week row (a new first weekday), and the
    // day list may not repaint to size the window for it.
    syncHeight();

    if (opts?.announceMonth) announce(month.label);
    if (opts?.focusGrid || hadFocus) {
      const selector = pinnedOutsideIso
        ? `[data-iso="${focusIso}"]`
        : `[data-iso="${focusIso}"].is-in-month`;
      grid.querySelector<HTMLButtonElement>(selector)?.focus();
    }
  };

  const showToday = (): void => {
    const today = new Date();
    slide = Math.sign(
      today.getFullYear() * 12 + today.getMonth() - (viewYear * 12 + viewMonth),
    );
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    focusIso = toIso(today);
    pinnedOutsideIso = null;
    render({ announceMonth: true, focusGrid: true });
    paintDayEvents();
    void refreshUpcoming();
  };

  const shiftMonth = (delta: number): void => {
    slide = delta;
    const next = addMonths(viewYear, viewMonth, delta);
    viewYear = next.year;
    viewMonth = next.month;
    pinnedOutsideIso = null;
    render({ announceMonth: true, focusGrid: true });
    paintDayEvents();
    void refreshUpcoming();
  };

  const moveFocus = (days: number): void => {
    const next = addDays(fromIso(focusIso), days);
    focusIso = toIso(next);
    pinnedOutsideIso = null;
    if (next.getMonth() !== viewMonth || next.getFullYear() !== viewYear) {
      slide = days;
      viewYear = next.getFullYear();
      viewMonth = next.getMonth();
      render({ announceMonth: true, focusGrid: true });
      paintDayEvents();
      void refreshUpcoming();
      return;
    }
    render({ focusGrid: true });
    paintDayEvents();
  };

  // The bands are placed in pixels, so they follow the grid whenever its
  // width changes: the window resizes after the month was drawn hidden, as
  // when week numbers are switched on or off from Settings.
  new ResizeObserver(() => {
    const table = grid.querySelector<HTMLTableElement>("table");
    const wrap = grid.querySelector<HTMLElement>(".month");
    if (settings && table && wrap) paintColumnHighlights(table, wrap, settings);
  }).observe(grid);

  prev.addEventListener("click", () => shiftMonth(-1));
  todayButton.addEventListener("click", () => showToday());
  next.addEventListener("click", () => shiftMonth(1));
  // The shortcut looks the meeting up itself, so it works whether or not
  // the menu bar is counting down.
  const joinUpcoming = async (): Promise<void> => {
    const now = Date.now();
    const events = await api.getCalendarEvents(now, endOfToday(new Date(now))).catch(() => []);
    const url = meetingToJoin(events, now)?.joinUrl;
    if (!url) return;
    await api.joinMeeting(url);
    await api.hideCalendar();
  };
  openSettings.addEventListener("click", () => {
    void api.openSettings();
  });
  openSearch.addEventListener("click", () => {
    if (searchIsOpen()) closeSearch(true);
    else openSearchPanel();
  });
  searchInput.addEventListener("input", () => paintSearch());
  openQuickAdd.addEventListener("click", () => {
    if (quickAddIsOpen()) closeQuickAdd(true);
    else openQuickAddPanel();
  });
  quickAddInput.addEventListener("input", () => void readQuickAdd());

  // Focus rings follow the keyboard: on after a key, off after the mouse.
  document.addEventListener("mousedown", () => {
    delete document.documentElement.dataset.keyboard;
  });
  api.onCalendarHidden(() => {
    // Search and quick add close with the popover; a reopen shows the day.
    closeSearch(false);
    closeQuickAdd(false);
    // The fold closes with the popover; a reopen shows today's meetings tidy.
    if (pastOpen) {
      pastOpen = false;
      paintDayEvents();
    }
    delete document.documentElement.dataset.keyboard;
    document.documentElement.dataset.pointerAway = "";
  });
  document.addEventListener("mousemove", () => {
    delete document.documentElement.dataset.pointerAway;
  });
  document.addEventListener("keydown", (event) => {
    if (!event.metaKey && event.key !== "Escape") {
      document.documentElement.dataset.keyboard = "";
    }
    // Escape leaves search first, and the popover only after.
    if (event.key === "Escape") {
      event.preventDefault();
      if (quickAddIsOpen()) closeQuickAdd(true);
      else if (searchIsOpen()) closeSearch(true);
      else void api.hideCalendar();
      return;
    }
    if ((event.key === "n" || event.key === "N") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openQuickAddPanel();
      return;
    }
    // ⌘N and ⌘F work from either field, so one panel swaps for the other.
    if ((event.key === "f" || event.key === "F") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openSearchPanel();
      return;
    }
    if (event.target === quickAddInput) {
      if (event.key === "Enter") {
        event.preventDefault();
        void submitQuickAdd();
      }
      if (!(event.key === "," && (event.metaKey || event.ctrlKey))) return;
    }
    // Typing in the field is typing, not the month's keys. Down moves to the
    // first result, Return opens it.
    if (event.target === searchInput) {
      const first = searchResults.querySelector<HTMLButtonElement>("button");
      if (event.key === "ArrowDown" && first) {
        event.preventDefault();
        first.focus();
      } else if (event.key === "Enter" && first) {
        event.preventDefault();
        first.click();
      }
      if (!(event.key === "," && (event.metaKey || event.ctrlKey))) return;
    }
    // In the results, Up and Down walk the list instead of the month.
    if (event.target instanceof HTMLElement && searchResults.contains(event.target)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const rows = Array.from(searchResults.querySelectorAll<HTMLButtonElement>("button"));
        const at = rows.indexOf(event.target as HTMLButtonElement);
        const to = at + (event.key === "ArrowDown" ? 1 : -1);
        (to < 0 ? searchInput : rows[Math.min(to, rows.length - 1)])?.focus();
        return;
      }
      if (event.key !== "," && event.key !== "Tab") return;
    }
    if (event.key === "," && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void api.openSettings();
      return;
    }
    if (event.key === "t" || event.key === "T") {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      showToday();
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      shiftMonth(-1);
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      shiftMonth(1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusIso = toIso(new Date(viewYear, viewMonth, 1));
      pinnedOutsideIso = null;
      render({ focusGrid: true });
      paintDayEvents();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusIso = toIso(new Date(viewYear, viewMonth + 1, 0));
      pinnedOutsideIso = null;
      render({ focusGrid: true });
      paintDayEvents();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-7);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(7);
    }
  });

  const applySettings = (next: AppSettings): void => {
    settings = next;
    applyTheme(next.theme);
    document.documentElement.dataset.dayHighlight = next.dayHighlight;
    paintDayEvents();
    refreshTray();
    render();
    void refreshUpcoming();
  };

  // Dates and times follow the Mac's Language & Region, read before the
  // first paint so the month never draws in the wrong format first.
  void api
    .getSystemRegion()
    .then(setRegion, () => setRegion(null))
    .then(() => api.getSettings())
    .then((next) => {
      applySettings(next);
    });
  void markPopoverMaterial(() => api.getPopoverMaterial());
  api.onSettingsChanged(applySettings);
  // A new day carries the selection with it when it was on the old today,
  // so the month opens on today rather than yesterday. A day picked on
  // purpose stays picked.
  const followToday = (): void => {
    const todayIso = toIso(new Date());
    if (!selectionFollowsToday(renderedDay, focusIso, todayIso)) return;
    const today = new Date();
    focusIso = todayIso;
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    pinnedOutsideIso = null;
    paintDayEvents();
  };

  api.onClockTick(() => {
    const now = new Date();
    if (settings?.beepOnTheHour && chimeDue(lastHour, now)) void api.beep();
    lastHour = now.getHours();
    // The month only changes with the day; redrawing it every minute would
    // take keyboard and VoiceOver focus away each time.
    const newDay = toIso(now) !== renderedDay;
    followToday();
    refreshTray();
    if (newDay) render();
    void refreshUpcoming();
  });
  api.onEventDismissed(() => {
    void refreshUpcoming();
  });
  // The global shortcut fires wherever focus is; the calendar window already
  // knows which event the menu bar item is previewing.
  api.onJoinUpcomingRequested(() => void joinUpcoming());
  // Opening shows what was drawn while hidden; only a new day redraws it.
  // Nothing takes focus: the arrow keys work from the document, and a ring
  // around today on every open is not how a menu looks.
  api.onCalendarShown(() => {
    refreshTray();
    followToday();
    if (toIso(new Date()) !== renderedDay) render();
    void refreshUpcoming();
  });
}

startCalendar(installTauriBridge());
