import {
  calendarsOfKind,
  groupCalendarsBySource,
  highlightDaysFrom,
  DAY_HIGHLIGHTS,
  DEFAULT_SETTINGS,
  MENU_BAR_ICONS,
  UPCOMING_HORIZON_DAYS,
  UPCOMING_ICON_LEAD_MINUTES,
  upcomingHorizonLabel,
  upcomingIconLeadLabel,
  WEEK_STARTS,
  weekdayLetter,
  type AppSettings,
  type CalendarInfo,
  type MenuBarIconStyle,
  type Theme,
  type UpcomingHorizonDays,
  type UpcomingIconLeadMinutes,
  type Weekday,
  type WeekStartsOn,
  type WeekNumbering,
  type ComingDays,
  type DayHighlight,
  ICON_LEAD_ALWAYS,
} from "../shared/settings";
import { installTauriBridge, type DesktopApi } from "./host";
import { sfSymbol, type SymbolName } from "./icons";
import { enhanceSwitches } from "./switches";
import { framedGlyphMask } from "./tray-frame";

/** Each pane's sidebar tile, as System Settings marks its panes. */
const TAB_ICONS: Record<string, { symbol: SymbolName; color: string }> = {
  general: { symbol: "gearshape.fill", color: "#8e8e93" },
  // Dark gray rather than near-black, so the tile still reads on the dark
  // sidebar; the hairline in settings.css does the rest.
  appearance: { symbol: "circle.lefthalf.filled", color: "#48484a" },
  calendar: { symbol: "calendar", color: "#ff3b30" },
  events: { symbol: "calendar.badge.clock", color: "#ff9500" },
  about: { symbol: "info.circle.fill", color: "#8e8e93" },
};

import { bindCalendarAccess } from "./calendar-access";
import { chordFromKeyboard, chordLabel, chordProblem } from "../shared/shortcuts";
import { rovingTarget } from "../shared/roving";
import { setRegion } from "../shared/region";
import { knownTimeZones } from "../shared/zones";
import { updateStatusLine, type UpdateStatus } from "../shared/updates";

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function fillSelect(
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
): void {
  select.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      return node;
    }),
  );
}

/** Each style previewed with today's date, the way the menu bar would show it. */
function trayGlyphUrl(style: MenuBarIconStyle, date: Date): string | null {
  if (style === "none") return null;
  if (style === "framed") return framedGlyphMask(String(date.getDate()));
  if (style === "calendar") return `url("tray/calendar.png")`;
  const day = String(date.getDate()).padStart(2, "0");
  return `url("tray/filled/day-${day}.png")`;
}

function buildIconStyles(picker: HTMLElement, date = new Date()): void {
  picker.replaceChildren(
    ...MENU_BAR_ICONS.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.style = item.id;
      button.setAttribute("aria-checked", "false");
      button.tabIndex = -1;

      const glyph = document.createElement("span");
      glyph.className = item.id === "none" ? "mb-icon none" : "mb-icon";
      glyph.setAttribute("aria-hidden", "true");
      const mask = trayGlyphUrl(item.id, date);
      if (mask) glyph.style.setProperty("--tray-glyph", mask);
      else glyph.textContent = String(date.getDate());
      // Named under the glyph, so the choice does not rest on the picture.
      const name = document.createElement("span");
      name.className = "mb-name";
      name.textContent = item.label;
      button.append(glyph, name);
      return button;
    }),
  );
}

function paintIconStyle(picker: HTMLElement, id: MenuBarIconStyle): void {
  for (const button of Array.from(picker.querySelectorAll<HTMLButtonElement>("button"))) {
    const checked = button.dataset.style === id;
    button.setAttribute("aria-checked", checked ? "true" : "false");
    // One Tab stop for the group, on the chosen style; arrows move within.
    button.tabIndex = checked ? 0 : -1;
  }
}

function showTab(name: string): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tabs [role='tab']"),
  )) {
    const selected = button.dataset.tab === name;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    // One Tab stop for the sidebar, on the open pane; arrows move within.
    button.tabIndex = selected ? 0 : -1;
    // The toolbar names the pane, as System Settings does.
    if (selected) {
      const title = document.getElementById("pane-title");
      if (title) title.textContent = button.textContent?.trim() ?? "";
    }
  }
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>("[role='tabpanel']"))) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
}

function startSettings(api: DesktopApi): void {
  enhanceSwitches(document);
  // Rows, icons and text follow the user's sidebar size, as native ones do.
  void api.getSidebarSize().then(
    (size) => (document.documentElement.dataset.sidebarSize = size),
    () => (document.documentElement.dataset.sidebarSize = "medium"),
  );
  const form = requireElement<HTMLFormElement>("form");
  const tabs = requireElement<HTMLDivElement>("tabs");
  for (const tab of Array.from(tabs.querySelectorAll<HTMLButtonElement>("[role='tab']"))) {
    const entry = TAB_ICONS[tab.dataset.tab ?? ""];
    if (!entry) continue;
    const tile = document.createElement("span");
    tile.className = "tab-tile";
    tile.style.setProperty("--tile", entry.color);
    tile.append(sfSymbol(entry.symbol));
    tab.prepend(tile);
  }
  const iconStyles = requireElement<HTMLDivElement>("icon-styles");
  const showWeekday = requireElement<HTMLInputElement>("show-weekday");
  const showMonth = requireElement<HTMLInputElement>("show-month");
  const weekStart = requireElement<HTMLSelectElement>("week-start");
  const weekNumbers = requireElement<HTMLInputElement>("week-numbers");
  const weekNumbering = requireElement<HTMLSelectElement>("week-numbering");
  const comingDays = requireElement<HTMLSelectElement>("coming-days");
  const secondTimeZone = requireElement<HTMLSelectElement>("second-time-zone");
  const secondTimeZoneInMenuBar = requireElement<HTMLInputElement>("second-time-zone-in-menu-bar");
  // Every zone the Mac knows, by region and city: "America / New York".
  secondTimeZone.append(
    ...knownTimeZones().map((zone) => {
      const option = document.createElement("option");
      option.value = zone;
      option.textContent = zone.replace(/_/g, " ").replace(/\//g, " / ");
      return option;
    }),
  );
  /** The menu bar switch means nothing without a zone. */
  const paintSecondZone = (zone: string): void => {
    secondTimeZoneInMenuBar.disabled = !zone;
    secondTimeZoneInMenuBar.closest(".row")?.classList.toggle("is-off", !zone);
  };
  /** Counting only matters while week numbers are shown. */
  const paintWeekNumbering = (shown: boolean): void => {
    weekNumbering.disabled = !shown;
    weekNumbering.closest(".row")?.classList.toggle("is-off", !shown);
  };
  const highlightDays = requireElement<HTMLDivElement>("highlight-days");
  const login = requireElement<HTMLInputElement>("login");
  const beep = requireElement<HTMLInputElement>("beep");
  const autoUpdate = requireElement<HTMLInputElement>("auto-update");
  const showUpcoming = requireElement<HTMLInputElement>("show-upcoming");
  const upcomingHorizon = requireElement<HTMLSelectElement>("upcoming-horizon");
  const upcomingIconLead = requireElement<HTMLSelectElement>("upcoming-icon-lead");
  const remindBeforeMeetings = requireElement<HTMLInputElement>("remind-before-meetings");
  const remindInPerson = requireElement<HTMLInputElement>("remind-in-person");
  /** In-person reminders ride on the reminder being on. */
  const paintInPerson = (on: boolean): void => {
    remindInPerson.disabled = !on;
    remindInPerson.closest(".row")?.classList.toggle("is-off", !on);
  };
  const includeWithoutParticipants = requireElement<HTMLInputElement>(
    "include-without-participants",
  );
  const includeWithoutLocation = requireElement<HTMLInputElement>(
    "include-without-location",
  );
  const showEventTitle = requireElement<HTMLInputElement>("show-event-title");
  const showEventTime = requireElement<HTMLInputElement>("show-event-time");
  const toggleCalendarShortcut = requireElement<HTMLButtonElement>(
    "toggle-calendar-shortcut",
  );
  const toggleCalendarShortcutClear = requireElement<HTMLButtonElement>(
    "toggle-calendar-shortcut-clear",
  );
  const joinMeetingShortcut = requireElement<HTMLButtonElement>("join-meeting-shortcut");
  const joinMeetingShortcutClear = requireElement<HTMLButtonElement>(
    "join-meeting-shortcut-clear",
  );
  const calendarAccessStatus = requireElement<HTMLParagraphElement>("calendar-access-status");
  const calendarAccess = requireElement<HTMLButtonElement>("calendar-access");
  const calendarAccessRow = requireElement<HTMLElement>("calendar-access-row");
  const calendarSources = requireElement<HTMLElement>("calendar-sources");
  const reminderSources = requireElement<HTMLElement>("reminder-sources");
  const remindersAccess = requireElement<HTMLButtonElement>("reminders-access");
  const remindersAccessRow = requireElement<HTMLElement>("reminders-access-row");
  const beepPreview = requireElement<HTMLButtonElement>("beep-preview");
  const theme = requireElement<HTMLSelectElement>("theme");
  const dayHighlight = requireElement<HTMLElement>("day-highlight");
  const dayHighlightName = requireElement<HTMLElement>("day-highlight-name");
  // A swatch per color, as System Settings sets out the accent colors. Each
  // is a radio, so the arrow keys move between them and a choice is a form
  // change like any other.
  dayHighlight.replaceChildren(
    ...DAY_HIGHLIGHTS.map((option) => {
      const swatch = document.createElement("label");
      swatch.className = `swatch swatch-${option.id}`;
      swatch.title = option.name;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "dayHighlight";
      input.value = option.id;
      input.setAttribute("aria-label", option.name);
      swatch.append(input, document.createElement("span"));
      return swatch;
    }),
  );
  const chosenHighlight = (): DayHighlight =>
    (dayHighlight.querySelector<HTMLInputElement>("input:checked")?.value ??
      DEFAULT_SETTINGS.dayHighlight) as DayHighlight;
  const paintHighlightName = (): void => {
    const id = chosenHighlight();
    dayHighlightName.textContent =
      DAY_HIGHLIGHTS.find((option) => option.id === id)?.name ?? "";
  };
  const version = requireElement<HTMLSpanElement>("version");
  const checkUpdates = requireElement<HTMLButtonElement>("check-updates");
  const updateStatus = requireElement<HTMLElement>("update-status");
  const updateNotes = requireElement<HTMLDetailsElement>("update-notes");
  const updateNotesTitle = requireElement<HTMLElement>("update-notes-title");
  const updateNotesBody = requireElement<HTMLElement>("update-notes-body");
  const updatePill = requireElement<HTMLButtonElement>("update-pill");
  const updatePillTitle = requireElement<HTMLElement>("update-pill-title");
  const updatePillAction = requireElement<HTMLElement>("update-pill-action");
  const openRepository = requireElement<HTMLButtonElement>("open-repository");
  const openOriginal = requireElement<HTMLButtonElement>("open-original");
  const openReleaseNotes = requireElement<HTMLButtonElement>("open-release-notes");
  const openIssues = requireElement<HTMLButtonElement>("open-issues");
  for (const destination of Array.from(document.querySelectorAll<HTMLElement>("[data-external]"))) {
    destination.append(sfSymbol("arrow.up.right", 10));
  }
  const openSite = requireElement<HTMLButtonElement>("open-site");

  buildIconStyles(iconStyles);
  beepPreview.append(sfSymbol("speaker.wave.2.fill", 14));
  fillSelect(
    weekStart,
    WEEK_STARTS.map((item) => ({
      value: String(item.id),
      label: item.label,
    })),
  );
  fillSelect(
    upcomingHorizon,
    UPCOMING_HORIZON_DAYS.map((days) => ({
      value: String(days),
      label: upcomingHorizonLabel(days),
    })),
  );
  fillSelect(
    upcomingIconLead,
    UPCOMING_ICON_LEAD_MINUTES.map((minutes) => ({
      value: String(minutes),
      label: upcomingIconLeadLabel(minutes),
    })),
  );

  // The days run in the month's column order, so they follow the first day
  // of the week.
  let highlightOrder = -1;
  const buildHighlightDays = (weekStartsOn: number): void => {
    if (weekStartsOn === highlightOrder) return;
    highlightOrder = weekStartsOn;
    const selected = selectedWeekdays();
    highlightDays.replaceChildren(
    ...highlightDaysFrom(weekStartsOn).map((day) => {
      // A div, not a label: a label would pass a click on the letter on to
      // the button as a second click, and the two would cancel out.
      const wrap = document.createElement("div");
      wrap.className = "weekday-toggle";
      const caption = document.createElement("span");
      caption.textContent = weekdayLetter(day.id);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.weekday = String(day.id);
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", day.name);
      button.append(sfSymbol("checkmark", 11));
      wrap.append(caption, button);
      return wrap;
    }),
    );
    paintHighlights(selected);
  };

  const selectedWeekdays = (): Weekday[] =>
    Array.from(
      highlightDays.querySelectorAll<HTMLButtonElement>("button[aria-pressed='true']"),
    )
      .map((button) => Number(button.dataset.weekday))
      .filter((value): value is Weekday => value >= 0 && value <= 6);

  const paintHighlights = (days: readonly number[]): void => {
    const selected = new Set(days);
    for (const button of Array.from(
      highlightDays.querySelectorAll<HTMLButtonElement>("button"),
    )) {
      const weekday = Number(button.dataset.weekday);
      button.setAttribute("aria-pressed", selected.has(weekday) ? "true" : "false");
    }
  };

  const upcomingControls = (): (HTMLSelectElement | HTMLInputElement)[] => [
    upcomingHorizon,
    includeWithoutParticipants,
    includeWithoutLocation,
    upcomingIconLead,
    showEventTime,
    showEventTitle,
  ];

  const paintUpcomingOptions = (enabled: boolean, leadMinutes: number): void => {
    for (const input of upcomingControls()) {
      // Look ahead only bounds the Always lead; any other lead already says
      // how far ahead the countdown looks.
      const off = !enabled || (input === upcomingHorizon && leadMinutes !== ICON_LEAD_ALWAYS);
      input.disabled = off;
      input.closest(".row")?.classList.toggle("is-off", off);
    }
  };

  let hiddenCalendarIds: string[] = [];

  const sourceInputs = (): HTMLInputElement[] =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        "#calendar-sources input[data-calendar-id], #reminder-sources input[data-calendar-id]",
      ),
    );

  const paintCalendarSelection = (hidden: readonly string[]): void => {
    const skipped = new Set(hidden);
    for (const input of sourceInputs()) {
      input.checked = !skipped.has(input.dataset.calendarId ?? "");
    }
  };

  const paintSourceList = (
    container: HTMLElement,
    calendars: CalendarInfo[],
    options: { empty: string; heading: string; headingId: string; idPrefix: string },
  ): void => {
    if (!calendars.length) {
      const empty = document.createElement("p");
      empty.className = "calendar-sources-empty";
      empty.id = options.headingId;
      empty.textContent = options.empty;
      container.replaceChildren(empty);
      return;
    }
    const groups = groupCalendarsBySource(calendars);
    const nodes: HTMLElement[] = [];
    const heading = document.createElement("p");
    heading.className = "visually-hidden";
    heading.id = options.headingId;
    heading.textContent = options.heading;
    nodes.push(heading);
    let index = 0;
    for (const group of groups) {
      if (groups.length > 1) {
        const label = document.createElement("p");
        label.className = "calendar-source-label";
        label.textContent = group.source;
        nodes.push(label);
      }
      for (const calendar of group.calendars) {
        const row = document.createElement("div");
        row.className = "row";
        const copy = document.createElement("div");
        copy.className = "copy";
        const name = document.createElement("label");
        name.className = "calendar-name";
        name.htmlFor = `${options.idPrefix}-${index}`;
        const swatch = document.createElement("span");
        swatch.className = "calendar-swatch";
        swatch.setAttribute("aria-hidden", "true");
        if (calendar.color) swatch.style.setProperty("--calendar-color", calendar.color);
        name.append(swatch, document.createTextNode(calendar.title));
        copy.append(name);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("switch", "");
        input.id = `${options.idPrefix}-${index}`;
        input.dataset.calendarId = calendar.id;
        input.checked = !hiddenCalendarIds.includes(calendar.id);
        row.append(copy, input);
        nodes.push(row);
        index += 1;
      }
    }
    container.replaceChildren(...nodes);
  };

  const hideSourceList = (container: HTMLElement): void => {
    container.hidden = true;
    container.replaceChildren();
  };

  const loadCalendarSources = async (granted: boolean): Promise<void> => {
    if (!granted) {
      hideSourceList(calendarSources);
      return;
    }
    try {
      const calendars = calendarsOfKind(await api.listCalendars(), "event");
      paintSourceList(calendarSources, calendars, {
        empty: "No calendars available.",
        heading: "Calendars",
        headingId: "calendar-sources-label",
        idPrefix: "calendar-source",
      });
      calendarSources.hidden = false;
    } catch {
      hideSourceList(calendarSources);
    }
  };

  const loadReminderSources = async (granted: boolean): Promise<void> => {
    remindersAccessRow.hidden = granted;
    if (!granted) {
      hideSourceList(reminderSources);
      return;
    }
    try {
      const calendars = calendarsOfKind(await api.listCalendars(), "reminder");
      paintSourceList(reminderSources, calendars, {
        empty: "No reminder lists available.",
        heading: "Reminders",
        headingId: "reminder-sources-label",
        idPrefix: "reminder-source",
      });
      reminderSources.hidden = false;
    } catch {
      hideSourceList(reminderSources);
    }
  };

  /** The field reads its chord in macOS glyphs; an unset one invites a recording. */
  const paintShortcut = (field: HTMLButtonElement, chord: string): void => {
    field.dataset.chord = chord;
    if (field.dataset.recording === "true") return;
    field.textContent = chordLabel(chord) || "Record Shortcut";
    field.classList.toggle("is-unset", !chord);
  };

  const toggleCalendarShortcutProblem = requireElement<HTMLElement>(
    "toggle-calendar-shortcut-problem",
  );
  const joinMeetingShortcutProblem = requireElement<HTMLElement>("join-meeting-shortcut-problem");

  /** Says why a chord was refused under its field, or clears the note. */
  const showShortcutProblem = (problem: HTMLElement, text: string | null): void => {
    problem.textContent = text ?? "";
    problem.hidden = !text;
  };

  const bindShortcutField = (
    field: HTMLButtonElement,
    clear: HTMLButtonElement,
    problem: HTMLElement,
    key: "toggleCalendarShortcut" | "joinMeetingShortcut",
    other: () => { chord: string; name: string },
  ): void => {
    // While a field records, Glance's own chords are set aside so their keys
    // reach it; otherwise ⌃⌘K would open the month rather than be recorded.
    const endRecording = (): void => {
      field.dataset.recording = "false";
      field.classList.remove("is-recording");
      void api.suspendShortcuts(false);
    };
    const stopRecording = (): void => {
      if (field.dataset.recording !== "true") return;
      endRecording();
      // A note about a refused chord is done with once recording stops.
      showShortcutProblem(problem, null);
      paintShortcut(field, field.dataset.chord ?? "");
    };
    field.addEventListener("click", () => {
      // WebKit leaves a clicked button unfocused, so its keydown would never fire.
      field.focus();
      showShortcutProblem(problem, null);
      void api.suspendShortcuts(true);
      field.dataset.recording = "true";
      field.classList.add("is-recording");
      field.textContent = "Press keys…";
    });
    field.addEventListener("blur", stopRecording);
    field.addEventListener("keydown", (event) => {
      if (field.dataset.recording !== "true") return;
      // A recording field swallows the chord rather than acting on it.
      event.preventDefault();
      if (event.key === "Escape") {
        stopRecording();
        return;
      }
      const chord = chordFromKeyboard(event);
      if (!chord) return;
      const { chord: otherChord, name } = other();
      const refused = chordProblem(chord, otherChord, name);
      showShortcutProblem(problem, refused);
      // A refused chord keeps the field listening for another.
      if (refused) return;
      endRecording();
      paintShortcut(field, chord);
      void api.updateSettings({ [key]: chord });
    });
    clear.addEventListener("click", () => {
      if (field.dataset.recording === "true") endRecording();
      showShortcutProblem(problem, null);
      paintShortcut(field, "");
      void api.updateSettings({ [key]: "" });
    });
  };

  bindShortcutField(
    toggleCalendarShortcut,
    toggleCalendarShortcutClear,
    toggleCalendarShortcutProblem,
    "toggleCalendarShortcut",
    () => ({ chord: joinMeetingShortcut.dataset.chord ?? "", name: "joins your meeting" }),
  );
  bindShortcutField(
    joinMeetingShortcut,
    joinMeetingShortcutClear,
    joinMeetingShortcutProblem,
    "joinMeetingShortcut",
    () => ({ chord: toggleCalendarShortcut.dataset.chord ?? "", name: "shows the calendar" }),
  );

  // The host could not bind a chord (another app holds it, or macOS wants
  // Accessibility first) and has put the working one back.
  api.onShortcutFailed(({ setting, chord }) => {
    const problem =
      setting === "toggleCalendarShortcut" ? toggleCalendarShortcutProblem : joinMeetingShortcutProblem;
    showShortcutProblem(
      problem,
      `macOS would not let Glance use ${chordLabel(chord)}. Another app may hold it.`,
    );
  });

  const paint = (settings: AppSettings): void => {
    applyTheme(settings.theme);
    paintIconStyle(iconStyles, settings.menuBarIcon);
    showWeekday.checked = settings.showWeekday;
    showMonth.checked = settings.showMonth;
    weekStart.value = String(settings.weekStartsOn);
    weekNumbers.checked = settings.showWeekNumbers;
    weekNumbering.value = settings.weekNumbering;
    comingDays.value = String(settings.comingDays);
    secondTimeZone.value = settings.secondTimeZone;
    secondTimeZoneInMenuBar.checked = settings.secondTimeZoneInMenuBar;
    paintSecondZone(settings.secondTimeZone);
    paintWeekNumbering(settings.showWeekNumbers);
    buildHighlightDays(settings.weekStartsOn);
    paintHighlights(settings.highlightWeekdays);
    login.checked = settings.launchAtLogin;
    beep.checked = settings.beepOnTheHour;
    autoUpdate.checked = settings.autoUpdate;
    showUpcoming.checked = settings.showUpcomingEvent;
    upcomingHorizon.value = String(settings.upcomingHorizonDays);
    upcomingIconLead.value = String(settings.upcomingIconLeadMinutes);
    remindBeforeMeetings.checked = settings.remindBeforeMeetings;
    remindInPerson.checked = settings.remindInPerson;
    paintInPerson(settings.remindBeforeMeetings);
    includeWithoutParticipants.checked = settings.includeEventsWithoutParticipants;
    includeWithoutLocation.checked = settings.includeEventsWithoutLocation;
    showEventTitle.checked = settings.showEventTitleInMenuBar;
    showEventTime.checked = settings.showEventTimeInMenuBar;
    paintUpcomingOptions(settings.showUpcomingEvent, settings.upcomingIconLeadMinutes);
    paintShortcut(toggleCalendarShortcut, settings.toggleCalendarShortcut);
    paintShortcut(joinMeetingShortcut, settings.joinMeetingShortcut);
    hiddenCalendarIds = settings.hiddenCalendarIds;
    paintCalendarSelection(settings.hiddenCalendarIds);
    theme.value = settings.theme;
    for (const input of Array.from(dayHighlight.querySelectorAll<HTMLInputElement>("input"))) {
      input.checked = input.value === settings.dayHighlight;
    }
    paintHighlightName();
  };

  const patchFromForm = (): Partial<AppSettings> => ({
    showWeekday: showWeekday.checked,
    showMonth: showMonth.checked,
    weekStartsOn: Number(weekStart.value) as WeekStartsOn,
    showWeekNumbers: weekNumbers.checked,
    weekNumbering: weekNumbering.value as WeekNumbering,
    comingDays: Number(comingDays.value) as ComingDays,
    secondTimeZone: secondTimeZone.value,
    secondTimeZoneInMenuBar: secondTimeZoneInMenuBar.checked,
    highlightWeekdays: selectedWeekdays(),
    launchAtLogin: login.checked,
    beepOnTheHour: beep.checked,
    autoUpdate: autoUpdate.checked,
    showUpcomingEvent: showUpcoming.checked,
    upcomingHorizonDays: Number(upcomingHorizon.value) as UpcomingHorizonDays,
    upcomingIconLeadMinutes: Number(upcomingIconLead.value) as UpcomingIconLeadMinutes,
    remindBeforeMeetings: remindBeforeMeetings.checked,
    remindInPerson: remindInPerson.checked,
    includeEventsWithoutParticipants: includeWithoutParticipants.checked,
    includeEventsWithoutLocation: includeWithoutLocation.checked,
    showEventTitleInMenuBar: showEventTitle.checked,
    showEventTimeInMenuBar: showEventTime.checked,
    theme: theme.value as Theme,
    dayHighlight: chosenHighlight(),
  });

  // A hover left behind when the window closes under a still pointer would
  // greet the next open. Hovers wait for the pointer to move again.
  window.addEventListener("blur", () => {
    document.documentElement.dataset.pointerAway = "";
  });
  document.addEventListener("mousemove", () => {
    delete document.documentElement.dataset.pointerAway;
  });

  // Sets the sidebar's single Tab stop on the pane that opens first.
  showTab(
    tabs.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.dataset.tab ?? "general",
  );

  tabs.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button?.dataset.tab || !tabs.contains(button)) return;
    showTab(button.dataset.tab);
  });

  tabs.addEventListener("keydown", (event) => {
    // The sidebar runs top to bottom, so Up and Down lead; Left and Right
    // still work, and Home and End jump to either end.
    const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    const current = buttons.findIndex((button) => button.getAttribute("aria-selected") === "true");
    const next = rovingTarget(buttons, Math.max(current, 0), event.key);
    if (!next?.dataset.tab) return;
    event.preventDefault();
    showTab(next.dataset.tab);
    next.focus();
  });

  form.addEventListener("change", () => {
    const patch = patchFromForm();
    paintWeekNumbering(patch.showWeekNumbers ?? false);
    paintSecondZone(patch.secondTimeZone ?? "");
    paintInPerson(patch.remindBeforeMeetings ?? false);
    applyTheme(patch.theme ?? "system");
    paintHighlightName();
    paintUpcomingOptions(
      patch.showUpcomingEvent ?? false,
      patch.upcomingIconLeadMinutes ?? ICON_LEAD_ALWAYS,
    );
    void api.updateSettings(patch);
  });

  const syncHiddenSources = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.calendarId) return;
    event.stopPropagation();
    const hidden = new Set(hiddenCalendarIds);
    for (const source of sourceInputs()) {
      const id = source.dataset.calendarId;
      if (!id) continue;
      if (source.checked) hidden.delete(id);
      else hidden.add(id);
    }
    hiddenCalendarIds = [...hidden].sort();
    void api.updateSettings({ hiddenCalendarIds });
  };
  calendarSources.addEventListener("change", syncHiddenSources);
  reminderSources.addEventListener("change", syncHiddenSources);

  const refreshRemindersAccess = async (): Promise<void> => {
    try {
      await loadReminderSources(await api.getRemindersAccess());
    } catch {
      await loadReminderSources(false);
    }
  };

  const refreshCalendarAccess = bindCalendarAccess(api, {
    status: calendarAccessStatus,
    button: calendarAccess,
    row: calendarAccessRow,
    toggle: showUpcoming,
    onGrantedChange: (granted) => {
      void loadCalendarSources(granted);
      void refreshRemindersAccess();
    },
  });
  remindersAccess.addEventListener("click", async () => {
    remindersAccess.disabled = true;
    try {
      await api.requestRemindersAccess();
      await refreshRemindersAccess();
    } finally {
      remindersAccess.disabled = false;
    }
  });
  window.addEventListener("focus", () => {
    void refreshCalendarAccess();
    void refreshRemindersAccess();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void refreshCalendarAccess();
    void refreshRemindersAccess();
  });

  iconStyles.addEventListener("keydown", (event) => {
    const buttons = Array.from(iconStyles.querySelectorAll<HTMLButtonElement>("button"));
    const current = buttons.findIndex((button) => button.getAttribute("aria-checked") === "true");
    const next = rovingTarget(buttons, Math.max(current, 0), event.key);
    if (!next?.dataset.style) return;
    event.preventDefault();
    // Moving through a radio group chooses as it goes, as macOS does.
    next.focus();
    next.click();
  });

  iconStyles.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !iconStyles.contains(button) || !button.dataset.style) return;
    const id = button.dataset.style as MenuBarIconStyle;
    paintIconStyle(iconStyles, id);
    void api.updateSettings({ menuBarIcon: id });
  });

  highlightDays.addEventListener("click", (event) => {
    const toggle = (event.target as HTMLElement).closest(".weekday-toggle");
    const button = toggle?.querySelector("button");
    if (!button || !highlightDays.contains(button)) return;
    const pressed = button.getAttribute("aria-pressed") === "true";
    button.setAttribute("aria-pressed", pressed ? "false" : "true");
    void api.updateSettings({ highlightWeekdays: selectedWeekdays() });
  });

  beepPreview.addEventListener("click", (event) => {
    event.preventDefault();
    void api.beep();
  });

  let updateAction: "check" | "install" = "check";
  /** The version the host says is waiting; null when this build is current. */
  let waiting: string | null = null;
  let installing = false;

  const setUpdateButton = (
    label: string,
    options?: { busy?: boolean; install?: boolean; detail?: string },
  ): void => {
    checkUpdates.textContent = label;
    checkUpdates.disabled = Boolean(options?.busy);
    checkUpdates.title = options?.detail ?? "";
    checkUpdates.setAttribute("aria-busy", options?.busy ? "true" : "false");
    updateAction = options?.install ? "install" : "check";
  };

  /**
   * The sidebar pill: hidden until an update is waiting, then the version and
   * the one action, then how far installing has got.
   */
  const setUpdatePill = (
    state: "available" | "working" | "error" | null,
    action = "",
    detail = "",
  ): void => {
    updatePill.hidden = state === null;
    if (state === null) return;
    updatePill.dataset.state = state;
    updatePillTitle.textContent = waiting ? `Glance ${waiting}` : "Glance update";
    updatePillAction.textContent = action;
    updatePill.title = detail;
    updatePill.disabled = state === "working";
    updatePill.setAttribute("aria-label", `${updatePillTitle.textContent}. ${action}`);
  };

  const showWaiting = (version: string | null): void => {
    waiting = version;
    // An install already under way owns both controls until it ends.
    if (installing) return;
    if (!version) {
      setUpdatePill(null);
      return;
    }
    setUpdatePill("available", "Restart to update");
    setUpdateButton(`Update to ${version} and Restart`, { install: true });
  };

  const showInstallFailure = (detail: string): void => {
    installing = false;
    setUpdateButton("Update failed", { install: true, detail });
    setUpdatePill("error", "Try again", detail);
  };

  const install = (): void => {
    installing = true;
    setUpdateButton("Downloading…", { busy: true, install: true });
    setUpdatePill("working", "Preparing…");
    // The app relaunches itself when this finishes, so success needs no message.
    void api.installUpdate().catch((error: unknown) => {
      showInstallFailure(typeof error === "string" ? error : "Update failed");
    });
  };

  /** The line under the button, and the notes of a version waiting. */
  const paintUpdateStatus = (status: UpdateStatus): void => {
    updateStatus.textContent = updateStatusLine(status, Date.now());
    updateStatus.classList.toggle("is-failure", Boolean(status.error));
    const notes = status.version ? status.notes?.trim() : "";
    updateNotes.hidden = !notes;
    if (notes) {
      updateNotesTitle.textContent = `What’s new in ${status.version}`;
      // Text, never markup: the notes come from the release, not from us.
      updateNotesBody.textContent = notes;
    }
  };

  // Checking from here only looks. What it finds waits on the button, so
  // a restart never comes as a surprise, whatever the automatic setting.
  const checkForUpdates = async (): Promise<void> => {
    setUpdateButton("Checking…", { busy: true });
    try {
      const offer = await api.checkForUpdates();
      if (!offer.version) setUpdateButton("Check for Updates");
      else showWaiting(offer.version);
    } catch {
      setUpdateButton("Check Again");
    }
    void api.getUpdateStatus().then(paintUpdateStatus);
  };
  checkUpdates.addEventListener("click", () => {
    if (updateAction === "install") {
      install();
      return;
    }
    void checkForUpdates();
  });
  void api.getUpdateStatus().then(paintUpdateStatus);
  api.onUpdateStatus(paintUpdateStatus);
  updatePill.addEventListener("click", install);
  api.onUpdateAvailable(showWaiting);
  api.onUpdateFailed(showInstallFailure);
  void api.getUpdateAvailable().then(showWaiting);

  openRepository.addEventListener("click", () => void api.openRepository());
  openOriginal.addEventListener("click", () =>
    void api.openUrl("https://github.com/vipinsight/calendo"),
  );
  openSite.addEventListener("click", () => void api.openUrl("https://github.com/zshanansari"));
  openReleaseNotes.addEventListener("click", () =>
    void api.openUrl("https://github.com/zshanansari/glance/releases"),
  );
  openIssues.addEventListener("click", () =>
    void api.openUrl("https://github.com/zshanansari/glance/issues"),
  );
  // Also arrives for an install started from the menu bar.
  api.onUpdateProgress(({ downloaded, total }) => {
    installing = true;
    const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
    setUpdateButton(percent === null ? "Downloading…" : `Downloading… ${percent}%`, {
      busy: true,
      install: true,
    });
    // The pill is narrower than the button; one line, no ellipsis.
    setUpdatePill("working", percent === null ? "Downloading" : `Downloading ${percent}%`);
  });

  // First-run welcome. Its own controls, kept apart from the panes', so the
  // welcome never has to know how those are wired.
  const page = document.querySelector<HTMLElement>(".page");
  const welcome = requireElement<HTMLElement>("welcome");
  const welcomeAccess = requireElement<HTMLButtonElement>("welcome-access");
  const welcomeLogin = requireElement<HTMLInputElement>("welcome-login");
  const welcomeCountdown = requireElement<HTMLInputElement>("welcome-countdown");
  const welcomeShortcut = requireElement<HTMLElement>("welcome-shortcut");
  const welcomeDone = requireElement<HTMLButtonElement>("welcome-done");
  const paintWelcomeAccess = (granted: boolean): void => {
    welcomeAccess.textContent = granted ? "Allowed" : "Allow Access…";
    welcomeAccess.disabled = granted;
  };
  const showWelcome = (settings: AppSettings): void => {
    welcome.hidden = false;
    page?.classList.add("is-welcome");
    welcomeLogin.checked = settings.launchAtLogin;
    welcomeCountdown.checked = settings.showUpcomingEvent;
    welcomeShortcut.textContent = chordLabel(settings.toggleCalendarShortcut) || "Not set";
    void api.getCalendarAccess().then(paintWelcomeAccess, () => paintWelcomeAccess(false));
  };
  welcomeAccess.addEventListener("click", () => {
    welcomeAccess.disabled = true;
    void api
      .requestCalendarAccess()
      .then(paintWelcomeAccess, () => paintWelcomeAccess(false))
      .then(() => refreshCalendarAccess());
  });
  welcomeLogin.addEventListener("change", () => {
    void api.updateSettings({ launchAtLogin: welcomeLogin.checked });
  });
  welcomeCountdown.addEventListener("change", () => {
    void api.updateSettings({ showUpcomingEvent: welcomeCountdown.checked });
  });
  welcomeDone.addEventListener("click", () => {
    void api.updateSettings({ onboarded: true }).then(() => {
      welcome.hidden = true;
      page?.classList.remove("is-welcome");
      void api.hideSettings();
    });
  });

  void api
    .getSystemRegion()
    .then(setRegion, () => setRegion(null))
    .then(() => api.getSettings())
    .then((settings) => {
      paint(settings);
      void refreshCalendarAccess();
      if (!settings.onboarded) showWelcome(settings);
    });
  void api.getAppVersion().then((value) => {
    version.textContent = `v${value}`;
    const sidebarVersion = document.getElementById("sidebar-version");
    if (sidebarVersion) sidebarVersion.textContent = `v${value}`;
  });
  api.onSettingsChanged(paint);
}

startSettings(installTauriBridge());
