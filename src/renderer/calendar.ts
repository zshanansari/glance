import {
  addDays,
  addMonths,
  buildMonth,
  dayName,
  fromIso,
  toIso,
} from "../shared/calendar";
import { menuBarLabel, highlightedColumnRuns, trayLabelKey, type AppSettings } from "../shared/settings";
import {
  eventsOnDay,
  eventStatus,
  eventTimeRange,
  trayEventText,
  trayIconEvent,
  upcomingFetchEnd,
  type UpcomingEvent,
} from "../shared/events";
import { sfSymbol } from "./icons";
import { framedGlyphPng } from "./tray-frame";
import { boxHeight, markPopoverMaterial } from "./popover-size";
import { bandBox } from "./column-bands";
import { installTauriBridge, type DesktopApi } from "./host";

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function applyTheme(theme: AppSettings["theme"]): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function announce(message: string): void {
  requireElement("live").textContent = message;
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
      const outside = selectedEnd <= rangeStart || selectedStart >= rangeEnd;
      const [monthEvents, selectedEvents] = await Promise.all([
        api.getCalendarEvents(rangeStart, rangeEnd),
        outside ? api.getCalendarEvents(selectedStart, selectedEnd) : Promise.resolve([]),
      ]);
      let next: UpcomingEvent | null = null;
      if (current.showUpcomingEvent) {
        const nextEvents = await api.getCalendarEvents(
          now,
          upcomingFetchEnd(now, current.upcomingHorizonDays, current.upcomingIconLeadMinutes),
        );
        const dismissed = await api.getDismissedEvents().catch(() => []);
        next = trayIconEvent(nextEvents, now, {
          upcomingHorizonDays: current.upcomingHorizonDays,
          upcomingIconLeadMinutes: current.upcomingIconLeadMinutes,
          filters: current,
          dismissed,
        });
      }
      if (request !== eventRequest) return;
      upcomingEvent = next;
      const fetched = [...monthEvents, ...selectedEvents];
      const key = JSON.stringify(
        fetched.map((event) => [event.id, event.startAt, event.endAt, event.title, event.joinUrl]),
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
    open.title = "Open in Calendar";
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
    if (isNext) {
      const when = document.createElement("span");
      when.className = "day-event-when";
      when.textContent = eventStatus(event, now).label;
      time.append(when);
      row.classList.add("is-next");
    }
    open.append(dot, title, time);
    open.addEventListener("click", () => {
      void api.openEvent(event.id).then(() => api.hideCalendar());
    });
    row.append(open);
    if (event.joinUrl && event.endAt > now) {
      const url = event.joinUrl;
      const join = document.createElement("button");
      join.type = "button";
      join.className = "day-event-join";
      join.setAttribute("aria-label", `Join ${event.title}`);
      join.title = "Join meeting";
      join.textContent = "Join";
      join.addEventListener("click", () => {
        void api.joinMeeting(url).then(() => api.hideCalendar());
      });
      row.append(join);
    }
    if (event.endAt <= now) row.classList.add("is-past");
    return row;
  };

  const paintDayEvents = (): void => {
    dayEvents.hidden = false;
    const selectedDate = fromIso(focusIso);
    dayEventsTitle.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(selectedDate);
    const selectedEvents = eventsOnDay(calendarEvents, selectedDate);
    dayEventsCount.textContent = selectedEvents.length
      ? `${selectedEvents.length} event${selectedEvents.length === 1 ? "" : "s"}`
      : "";
    if (eventError) {
      const allow = document.createElement("button");
      allow.type = "button";
      allow.className = "menu-row";
      allow.textContent = "Allow Calendar Access…";
      allow.addEventListener("click", () => void requestAccess(allow));
      dayEventsList.replaceChildren(allow);
    } else if (!selectedEvents.length) {
      const empty = document.createElement("p");
      empty.className = "day-events-empty";
      empty.textContent = "No Events";
      dayEventsList.replaceChildren(empty);
    } else {
      const now = Date.now();
      // On today, the meeting that is on or comes next says how soon.
      const next =
        focusIso === toIso(new Date(now))
          ? selectedEvents.find((event) => !event.allDay && event.endAt > now)
          : undefined;
      dayEventsList.replaceChildren(
        ...selectedEvents.map((event) => dayEventRow(event, now, event === next)),
      );
    }
    syncHeight();
  };

  const refreshTray = (): void => {
    if (!settings) return;
    const now = new Date();
    const label = menuBarLabel(settings, now);
    const status = upcomingEvent && now.getTime() < upcomingEvent.endAt
      ? eventStatus(upcomingEvent, now.getTime()).label
      : "";
    // The status item carries the real pressed highlight now, so the title
    // stays as it reads when the popover is closed.
    const dateTitle = label.style === "framed" ? "" : label.text ?? "";
    // A hair space keeps "2h 21m" from reading as one long number without
    // opening the full word space the menu bar font would otherwise give it.
    const countdown = status ? status.replace(/(\d+)([hm])/g, "$1\u200a$2") : null;
    // The countdown follows the date after a bullet, with the event's time
    // and title after it when Settings asks for them.
    const eventText =
      countdown && upcomingEvent
        ? trayEventText(upcomingEvent, now.getTime(), {
            showTitle: settings.showEventTitleInMenuBar,
            showTime: settings.showEventTimeInMenuBar,
          })
        : null;
    const title = [dateTitle, countdown && `\u2022 ${countdown}`, eventText]
      .filter(Boolean)
      .join(" ");
    const trayStyle = label.style;
    const signature = `${trayLabelKey(label)}|${title}`;
    if (signature === lastTrayLabel) return;
    lastTrayLabel = signature;
    // The cutout style draws its date into the glyph instead of the title.
    const framed = label.style === "framed" ? label.text : null;
    void api.setTrayLabel(
      title || null,
      label.day,
      trayStyle,
      framed === null ? null : framedGlyphPng(framed),
    );
  };

  const render = (opts?: { announceMonth?: boolean; focusGrid?: boolean }): void => {
    if (!settings) return;
    const today = new Date();
    const month = buildMonth(viewYear, viewMonth, settings.weekStartsOn, today);
    // As Calendar titles a month: the name in full, the year lighter.
    const monthName = document.createElement("span");
    monthName.className = "month-name";
    monthName.textContent = new Intl.DateTimeFormat(undefined, { month: "long" }).format(
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
        number.textContent = String(week[0]?.weekNumber ?? "");
        row.append(number);
      }
      for (const day of week) {
        const cell = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "day";
        button.dataset.iso = day.iso;
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
        button.setAttribute("aria-selected", focused ? "true" : "false");
        button.addEventListener("click", () => {
          focusIso = day.iso;
          pinnedOutsideIso = day.inMonth ? null : day.iso;
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
    grid.replaceChildren(wrap);
    // Only offered once there is somewhere to go back from.
    const todayIso = toIso(today);
    todayButton.classList.toggle(
      "is-hidden",
      viewYear === today.getFullYear() && viewMonth === today.getMonth() && focusIso === todayIso,
    );
    paintColumnHighlights(table, wrap, settings);
    renderedDay = todayIso;

    if (opts?.announceMonth) announce(month.label);
    if (opts?.focusGrid) {
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

  prev.addEventListener("click", () => shiftMonth(-1));
  todayButton.addEventListener("click", () => showToday());
  next.addEventListener("click", () => shiftMonth(1));
  const joinUpcoming = (): void => {
    const url = upcomingEvent?.joinUrl;
    if (!url) return;
    void api.joinMeeting(url).then(() => api.hideCalendar());
  };
  openSettings.addEventListener("click", () => {
    void api.openSettings();
  });

  // Focus rings follow the keyboard: on after a key, off after the mouse.
  document.addEventListener("mousedown", () => {
    delete document.documentElement.dataset.keyboard;
  });
  api.onCalendarHidden(() => {
    delete document.documentElement.dataset.keyboard;
  });
  document.addEventListener("keydown", (event) => {
    if (!event.metaKey && event.key !== "Escape") {
      document.documentElement.dataset.keyboard = "";
    }
    if (event.key === "Escape") {
      event.preventDefault();
      void api.hideCalendar();
      return;
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

  void api.getSettings().then((next) => {
    applySettings(next);
  });
  void markPopoverMaterial(() => api.getPopoverMaterial());
  api.onSettingsChanged(applySettings);
  api.onClockTick(() => {
    const hour = new Date().getHours();
    if (hour !== lastHour) {
      lastHour = hour;
      if (settings?.beepOnTheHour) void api.beep();
    }
    refreshTray();
    render();
    void refreshUpcoming();
  });
  api.onEventDismissed(() => {
    void refreshUpcoming();
  });
  // The global shortcut fires wherever focus is; the calendar window already
  // knows which event the menu bar item is previewing.
  api.onJoinUpcomingRequested(joinUpcoming);
  // Opening shows what was drawn while hidden; only a new day redraws it.
  // Nothing takes focus: the arrow keys work from the document, and a ring
  // around today on every open is not how a menu looks.
  api.onCalendarShown(() => {
    refreshTray();
    if (toIso(new Date()) !== renderedDay) render();
    void refreshUpcoming();
  });
}

startCalendar(installTauriBridge());
