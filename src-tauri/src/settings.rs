//! Persisted preferences for the menu bar calendar.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MENU_BAR_ICONS: [&str; 4] = ["filled", "framed", "calendar", "none"];

/// Styles that no longer exist, mapped to the nearest one that does.
const RETIRED_ICONS: [(&str, &str); 1] = [("outline", "framed")];

/// Formats written before icon style and weekday/month toggles.
const LEGACY_FORMATS: [(&str, &str, bool, bool); 11] = [
    ("iconOnly", "filled", false, false),
    ("iconDay", "filled", false, false),
    ("iconWeekdayDay", "filled", true, false),
    ("iconWeekdayDayMonth", "filled", true, true),
    ("dateOnly", "none", true, false),
    ("weekdayDay", "filled", true, false),
    ("monthDay", "filled", false, true),
    ("weekdayMonthDay", "filled", true, true),
    ("day", "filled", false, false),
    ("weekday", "filled", true, false),
    ("full", "filled", true, true),
];

/// Today and the chosen day: the accent or a system color, red by default.
const DAY_HIGHLIGHTS: &[&str] = &[
    "accent", "blue", "purple", "pink", "red", "orange", "yellow", "green", "graphite",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub menu_bar_icon: String,
    pub show_weekday: bool,
    pub show_month: bool,
    pub week_starts_on: u8,
    pub show_week_numbers: bool,
    /// How week numbers count: "iso" (ISO 8601) or "us" (the week holding
    /// 1 January is week 1, weeks starting on Sunday).
    pub week_numbering: String,
    /// Days after today whose events follow today's list; 0 shows none.
    pub coming_days: u8,
    /// A second time zone, as an IANA name; empty for none.
    pub second_time_zone: String,
    /// Whether that zone's time shows in the menu bar too.
    pub second_time_zone_in_menu_bar: bool,
    /// Your own meeting room (Zoom, Meet, Teams…); quick add attaches it to
    /// an event typed with "zoom" or "meet". Empty when not set.
    pub meeting_link: String,
    /// The calendar quick add writes to; empty for the system default.
    pub quick_add_calendar_id: String,
    pub highlight_weekdays: Vec<u8>,
    /// Read only so files from before icon styles can be migrated.
    #[serde(default, skip_serializing)]
    pub menu_bar_format: String,
    pub launch_at_login: bool,
    pub beep_on_the_hour: bool,
    pub show_upcoming_event: bool,
    /// Days the countdown looks ahead, counted through local midnight.
    pub upcoming_horizon_days: u16,
    /// Read only so files from before the day window can be migrated.
    #[serde(default, skip_serializing)]
    pub upcoming_horizon_hours: u8,
    /// 0 follows the look-ahead; 1 holds the countdown back until the event starts.
    pub upcoming_icon_lead_minutes: u16,
    pub include_events_without_participants: bool,
    pub include_events_without_location: bool,
    pub show_event_title_in_menu_bar: bool,
    pub show_event_time_in_menu_bar: bool,
    /// A card with Join under the menu bar a minute before a meeting starts.
    pub remind_before_meetings: bool,
    /// The card also comes ten minutes before a meeting with a place and no link.
    pub remind_in_person: bool,
    pub toggle_calendar_shortcut: String,
    pub join_meeting_shortcut: String,
    pub hidden_calendar_ids: Vec<String>,
    pub auto_update: bool,
    pub theme: String,
    /// The color of today and the chosen day: "accent", or a system color
    /// such as "red", the default.
    pub day_highlight: String,
    /// Set once the first-run welcome has been seen.
    pub onboarded: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            menu_bar_icon: "filled".into(),
            // The system clock already shows the date: glyph alone by default.
            show_weekday: false,
            show_month: false,
            week_starts_on: 0,
            show_week_numbers: false,
            week_numbering: "iso".into(),
            coming_days: 3,
            second_time_zone: String::new(),
            second_time_zone_in_menu_bar: false,
            meeting_link: String::new(),
            quick_add_calendar_id: String::new(),
            highlight_weekdays: vec![0, 6],
            menu_bar_format: String::new(),
            launch_at_login: false,
            beep_on_the_hour: false,
            show_upcoming_event: false,
            upcoming_horizon_days: 1,
            upcoming_horizon_hours: 0,
            upcoming_icon_lead_minutes: 0,
            include_events_without_participants: true,
            include_events_without_location: true,
            show_event_title_in_menu_bar: false,
            show_event_time_in_menu_bar: false,
            remind_before_meetings: true,
            remind_in_person: false,
            toggle_calendar_shortcut: "Control+Command+K".into(),
            join_meeting_shortcut: String::new(),
            hidden_calendar_ids: Vec::new(),
            auto_update: true,
            theme: "system".into(),
            day_highlight: "red".into(),
            onboarded: false,
        }
    }
}

impl AppSettings {
    fn migrate_legacy_format(&mut self) {
        if let Some((_, icon, weekday, month)) = LEGACY_FORMATS
            .iter()
            .find(|(legacy, _, _, _)| *legacy == self.menu_bar_format)
        {
            self.menu_bar_icon = (*icon).into();
            self.show_weekday = *weekday;
            self.show_month = *month;
        }
    }

    pub fn normalize(mut self, base: &AppSettings) -> Self {
        if let Some((_, replacement)) = RETIRED_ICONS
            .iter()
            .find(|(retired, _)| *retired == self.menu_bar_icon)
        {
            self.menu_bar_icon = (*replacement).into();
        }
        if !MENU_BAR_ICONS.contains(&self.menu_bar_icon.as_str()) {
            self.menu_bar_icon = base.menu_bar_icon.clone();
        }
        if self.week_starts_on > 6 {
            self.week_starts_on = base.week_starts_on;
        }
        // A zone name is letters, digits and / _ + - only; anything else is
        // not a zone, and is dropped rather than shown.
        self.second_time_zone = self.second_time_zone.trim().to_string();
        if self.second_time_zone.len() > 64
            || !self
                .second_time_zone
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
        {
            self.second_time_zone = String::new();
        }
        // Only a link Join would open is kept, so quick add never attaches
        // anything else to an event.
        self.meeting_link = self.meeting_link.trim().to_string();
        if self.meeting_link.len() > 512 || !crate::events::is_meeting_url(&self.meeting_link) {
            self.meeting_link = String::new();
        }
        if self.quick_add_calendar_id.len() > 256 {
            self.quick_add_calendar_id = String::new();
        }
        if !matches!(self.coming_days, 0 | 1 | 2 | 3 | 5 | 7) {
            self.coming_days = base.coming_days;
        }
        if !matches!(self.week_numbering.as_str(), "iso" | "us") {
            self.week_numbering = base.week_numbering.clone();
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = base.theme.clone();
        }
        // "calendar" was Calendar Red before the system colors joined it.
        if self.day_highlight == "calendar" {
            self.day_highlight = "red".into();
        }
        if !DAY_HIGHLIGHTS.contains(&self.day_highlight.as_str()) {
            self.day_highlight = base.day_highlight.clone();
        }
        if !matches!(
            self.upcoming_horizon_days,
            1 | 2 | 3 | 4 | 5 | 6 | 7 | 14 | 30
        ) {
            self.upcoming_horizon_days = base.upcoming_horizon_days;
        }
        // Leads that no longer exist land on the nearest one that does, so an
        // existing file does not fall back to Always.
        self.upcoming_icon_lead_minutes = match self.upcoming_icon_lead_minutes {
            10 => 15,
            120 => 60,
            other => other,
        };
        if !matches!(
            self.upcoming_icon_lead_minutes,
            0 | 1 | 15 | 30 | 60 | 240 | 480 | 720 | 1440
        ) {
            self.upcoming_icon_lead_minutes = base.upcoming_icon_lead_minutes;
        }
        self.toggle_calendar_shortcut = usable_shortcut(
            &self.toggle_calendar_shortcut,
            &base.toggle_calendar_shortcut,
        );
        self.join_meeting_shortcut =
            usable_shortcut(&self.join_meeting_shortcut, &base.join_meeting_shortcut);
        // One chord cannot do two things; the calendar keeps it.
        if !self.join_meeting_shortcut.is_empty()
            && canonical_chord(&self.join_meeting_shortcut)
                == canonical_chord(&self.toggle_calendar_shortcut)
        {
            self.join_meeting_shortcut = String::new();
        }
        let mut days: Vec<u8> = self
            .highlight_weekdays
            .iter()
            .copied()
            .filter(|day| *day <= 6)
            .collect();
        days.sort_unstable();
        days.dedup();
        self.highlight_weekdays = days;
        let mut calendars: Vec<String> = self
            .hidden_calendar_ids
            .into_iter()
            .filter(|id| !id.is_empty())
            .collect();
        calendars.sort();
        calendars.dedup();
        self.hidden_calendar_ids = calendars;
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: AppSettings,
    /// Whether there was no settings file to read: a first launch.
    fresh: bool,
}

/// Reads settings one field at a time, so a field of the wrong type (a
/// `null`, a string where a number belongs, a value from a newer or older
/// version) falls back to its default alone instead of resetting the file.
fn lenient_settings(value: &serde_json::Value) -> Option<AppSettings> {
    let fields = value.as_object()?;
    let mut kept = serde_json::Map::new();
    for (key, field) in fields {
        let mut trial = kept.clone();
        trial.insert(key.clone(), field.clone());
        if serde_json::from_value::<AppSettings>(serde_json::Value::Object(trial)).is_ok() {
            kept.insert(key.clone(), field.clone());
        }
    }
    serde_json::from_value(serde_json::Value::Object(kept)).ok()
}

/// Chords macOS or nearly every app already answers to, in canonical form.
/// Taking one system-wide would steal it from them. Keep in step with
/// `shortcuts.ts`.
pub const RESERVED_CHORDS: &[&str] = &[
    "Command+KeyQ",
    "Command+KeyW",
    "Command+KeyC",
    "Command+KeyV",
    "Command+KeyX",
    "Command+KeyZ",
    "Shift+Command+KeyZ",
    "Command+KeyA",
    "Command+KeyS",
    "Command+KeyH",
    "Command+KeyM",
    "Command+KeyN",
    "Command+KeyO",
    "Command+KeyP",
    "Command+KeyF",
    "Command+KeyT",
    "Command+Comma",
    "Command+Tab",
    "Command+Backquote",
    "Command+Space",
    "Control+Space",
    "Alt+Command+Escape",
    "Shift+Command+Digit3",
    "Shift+Command+Digit4",
    "Shift+Command+Digit5",
];

/// A chord as `Control+Alt+Shift+Command+Key…`, or None when it has no main
/// key, an unknown token, or only Shift to hold: a chord without Control,
/// Option or Command would swallow ordinary typing everywhere.
pub fn canonical_chord(chord: &str) -> Option<String> {
    let mut tokens: Vec<&str> = chord.split('+').map(str::trim).collect();
    let key = tokens.pop().filter(|key| !key.is_empty())?;
    let mut held = [false; 4];
    for token in tokens {
        let slot = match token.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => 0,
            "alt" | "option" => 1,
            "shift" => 2,
            "command" | "cmd" | "super" | "meta" | "commandorcontrol" | "commandorctrl"
            | "cmdorcontrol" | "cmdorctrl" => 3,
            _ => return None,
        };
        held[slot] = true;
    }
    if !held[0] && !held[1] && !held[3] {
        return None;
    }
    let key = match key {
        single if single.len() == 1 && single.as_bytes()[0].is_ascii_alphabetic() => {
            format!("Key{}", single.to_ascii_uppercase())
        }
        single if single.len() == 1 && single.as_bytes()[0].is_ascii_digit() => {
            format!("Digit{single}")
        }
        code => code.to_string(),
    };
    let mut parts: Vec<String> = ["Control", "Alt", "Shift", "Command"]
        .iter()
        .zip(held)
        .filter(|(_, on)| *on)
        .map(|(name, _)| (*name).to_string())
        .collect();
    parts.push(key);
    Some(parts.join("+"))
}

/// The chord if it can be bound, empty when cleared, else the fallback.
fn usable_shortcut(chord: &str, fallback: &str) -> String {
    let chord = chord.trim();
    if chord.is_empty() {
        return String::new();
    }
    match canonical_chord(chord) {
        Some(canonical) if !RESERVED_CHORDS.contains(&canonical.as_str()) => chord.to_string(),
        _ => fallback.trim().to_string(),
    }
}

impl SettingsStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let fresh = !path.exists();
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| {
                let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
                let mut parsed = lenient_settings(&value)?;
                if value.get("highlightWeekdays").is_none() {
                    let dim = value
                        .get("dimWeekends")
                        .and_then(|item| item.as_bool())
                        .unwrap_or(true);
                    parsed.highlight_weekdays = if dim { vec![0, 6] } else { vec![] };
                }
                if value.get("menuBarIcon").is_none() {
                    parsed.migrate_legacy_format();
                }
                if value.get("upcomingHorizonDays").is_none() {
                    parsed.upcoming_horizon_days = match parsed.upcoming_horizon_hours {
                        48 => 2,
                        _ => 1,
                    };
                }
                Some(parsed.normalize(&AppSettings::default()))
            })
            .unwrap_or_default();
        Self {
            path,
            current,
            fresh,
        }
    }

    /// On a first launch, starts the week on the day the Mac does and
    /// numbers weeks as its region does. An existing file keeps its choices.
    pub fn adopt_region_if_new(&mut self, first_weekday: u8, us_weeks: bool) {
        if !self.fresh {
            return;
        }
        let mut next = self.current.clone();
        next.week_starts_on = first_weekday;
        next.week_numbering = if us_weeks { "us" } else { "iso" }.into();
        self.update(next);
        self.fresh = false;
    }

    pub fn value(&self) -> AppSettings {
        self.current.clone()
    }

    pub fn update(&mut self, patch: AppSettings) -> AppSettings {
        self.current = patch.normalize(&self.current);
        self.write();
        self.current.clone()
    }

    fn write(&self) {
        if let Ok(body) = serde_json::to_string_pretty(&self.current) {
            let _ = write_atomically(&self.path, format!("{body}\n").as_bytes());
        }
    }
}

/// Writes beside the target and renames over it, so a crash mid-write leaves
/// the old file rather than a torn one that would load as defaults. The file
/// is readable only by its owner, since it names the calendars being read.
pub(crate) fn write_atomically(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(body)?;
    file.sync_all()?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_week_starts_on_sunday() {
        assert_eq!(AppSettings::default().week_starts_on, 0);
    }

    #[test]
    fn accepts_every_week_start_and_rejects_out_of_range() {
        let base = AppSettings::default();
        for day in 0..=6 {
            let mut input = base.clone();
            input.week_starts_on = day;
            assert_eq!(input.normalize(&base).week_starts_on, day);
        }
        let mut input = base.clone();
        input.week_starts_on = 7;
        assert_eq!(input.normalize(&base).week_starts_on, base.week_starts_on);
    }

    #[test]
    fn rejects_an_unknown_icon() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = "rainbow".into();
        assert_eq!(input.normalize(&base).menu_bar_icon, base.menu_bar_icon);
    }

    #[test]
    fn writes_replace_the_file_whole_and_keep_it_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "glance-atomic-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let path = dir.join("settings.json");
        write_atomically(&path, b"{\"theme\": \"dark\"}\n").expect("first write");
        write_atomically(&path, b"{\"theme\": \"light\"}\n").expect("second write");
        assert_eq!(
            fs::read_to_string(&path).expect("reads"),
            "{\"theme\": \"light\"}\n"
        );
        assert!(!path.with_extension("json.tmp").exists());
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_a_format_from_before_icon_styles() {
        let dir = std::env::temp_dir().join(format!(
            "glance-settings-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(
            dir.join("settings.json"),
            r#"{"menuBarFormat": "dateOnly", "theme": "dark"}
"#,
        )
        .expect("writes");
        let store = SettingsStore::load(dir.clone());
        assert_eq!(store.value().menu_bar_icon, "none");
        assert!(store.value().show_weekday);
        assert!(!store.value().show_month);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_the_retired_outline_glyph_to_the_framed_date() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = "outline".into();
        assert_eq!(input.normalize(&base).menu_bar_icon, "framed");
    }

    #[test]
    fn keeps_the_undated_calendar_glyph() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = "calendar".into();
        assert_eq!(input.normalize(&base).menu_bar_icon, "calendar");
    }

    #[test]
    fn keeps_the_framed_date_and_the_hour_chime() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = "framed".into();
        input.beep_on_the_hour = true;
        let settings = input.normalize(&base);
        assert_eq!(settings.menu_bar_icon, "framed");
        assert!(settings.beep_on_the_hour);
    }

    #[test]
    fn keeps_upcoming_event_preference() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.show_upcoming_event = true;
        assert!(input.normalize(&base).show_upcoming_event);
    }

    #[test]
    fn keeps_every_look_ahead_window_and_rejects_the_rest() {
        let base = AppSettings::default();
        for days in [1, 2, 3, 4, 5, 6, 7, 14, 30] {
            let mut input = base.clone();
            input.upcoming_horizon_days = days;
            assert_eq!(input.normalize(&base).upcoming_horizon_days, days);
        }
        let mut input = base.clone();
        input.upcoming_horizon_days = 9;
        assert_eq!(input.normalize(&base).upcoming_horizon_days, 1);
    }

    #[test]
    fn keeps_an_icon_lead_and_rejects_the_rest() {
        let base = AppSettings::default();
        for minutes in [0, 1, 15, 30, 60, 240, 480, 720, 1440] {
            let mut input = base.clone();
            input.upcoming_icon_lead_minutes = minutes;
            assert_eq!(input.normalize(&base).upcoming_icon_lead_minutes, minutes);
        }
        let mut input = base.clone();
        input.upcoming_icon_lead_minutes = 20;
        assert_eq!(input.normalize(&base).upcoming_icon_lead_minutes, 0);
    }

    #[test]
    fn moves_retired_leads_to_the_nearest_surviving_one() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.upcoming_icon_lead_minutes = 10;
        assert_eq!(input.normalize(&base).upcoming_icon_lead_minutes, 15);
        let mut input = base.clone();
        input.upcoming_icon_lead_minutes = 120;
        assert_eq!(input.normalize(&base).upcoming_icon_lead_minutes, 60);
    }

    #[test]
    fn migrates_the_hour_look_ahead_to_days() {
        for (hours, days) in [(24u8, 1u16), (48, 2)] {
            let dir = std::env::temp_dir().join(format!(
                "glance-horizon-{hours}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).expect("temp dir");
            fs::write(
                dir.join("settings.json"),
                format!("{{\"upcomingHorizonHours\": {hours}}}\n"),
            )
            .expect("writes");
            let store = SettingsStore::load(dir.clone());
            assert_eq!(store.value().upcoming_horizon_days, days);
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn defaults_the_look_ahead_to_the_rest_of_today() {
        assert_eq!(AppSettings::default().upcoming_horizon_days, 1);
        assert_eq!(AppSettings::default().upcoming_icon_lead_minutes, 0);
    }

    #[test]
    fn defaults_the_include_filters_and_the_menu_bar_preview() {
        let settings = AppSettings::default();
        assert!(settings.remind_before_meetings);
        assert!(settings.include_events_without_participants);
        assert!(settings.include_events_without_location);
        assert!(!settings.show_event_title_in_menu_bar);
        assert!(!settings.show_event_time_in_menu_bar);
        assert_eq!(settings.toggle_calendar_shortcut, "Control+Command+K");
        assert!(settings.join_meeting_shortcut.is_empty());
    }

    #[test]
    fn trims_recorded_shortcuts_and_keeps_an_unset_one_empty() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.toggle_calendar_shortcut = "  Control+Command+J  ".into();
        input.join_meeting_shortcut = "   ".into();
        let settings = input.normalize(&base);
        assert_eq!(settings.toggle_calendar_shortcut, "Control+Command+J");
        assert!(settings.join_meeting_shortcut.is_empty());
    }

    #[test]
    fn refuses_chords_that_belong_to_macos_or_need_no_modifier() {
        let base = AppSettings::default();
        for chord in [
            "Command+KeyQ",
            "Cmd+C",
            "Command+Space",
            "Shift+KeyK",
            "KeyK",
            "Command+",
            "Hyper+KeyK",
        ] {
            let mut input = base.clone();
            input.toggle_calendar_shortcut = chord.into();
            input.join_meeting_shortcut = chord.into();
            let settings = input.normalize(&base);
            assert_eq!(
                settings.toggle_calendar_shortcut, base.toggle_calendar_shortcut,
                "{chord}"
            );
            assert_eq!(
                settings.join_meeting_shortcut, base.join_meeting_shortcut,
                "{chord}"
            );
        }
    }

    #[test]
    fn one_chord_cannot_do_both_jobs() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.toggle_calendar_shortcut = "Control+Command+KeyJ".into();
        input.join_meeting_shortcut = "Command+Control+J".into();
        let settings = input.normalize(&base);
        assert_eq!(settings.toggle_calendar_shortcut, "Control+Command+KeyJ");
        assert!(settings.join_meeting_shortcut.is_empty());
    }

    #[test]
    fn spells_chords_one_way() {
        assert_eq!(
            super::canonical_chord("cmd+ctrl+k").as_deref(),
            Some("Control+Command+KeyK")
        );
        assert_eq!(
            super::canonical_chord("Option+Shift+5").as_deref(),
            Some("Alt+Shift+Digit5")
        );
        assert_eq!(super::canonical_chord("Shift+KeyK"), None);
    }

    #[test]
    fn keeps_hidden_calendars_and_drops_empty_duplicates() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.hidden_calendar_ids =
            vec!["work".into(), String::new(), "home".into(), "work".into()];
        assert_eq!(
            input.normalize(&base).hidden_calendar_ids,
            vec!["home".to_string(), "work".to_string()]
        );
    }

    #[test]
    fn keeps_monday_as_a_week_start() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.week_starts_on = 1;
        assert_eq!(input.normalize(&base).week_starts_on, 1);
    }

    #[test]
    fn keeps_a_midweek_start() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.week_starts_on = 3;
        assert_eq!(input.normalize(&base).week_starts_on, 3);
    }

    /// The settings window starts from `DEFAULT_SETTINGS` in settings.ts; both
    /// are held to one fixture so the two cannot drift apart.
    #[test]
    fn defaults_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/default-settings.json"))
                .expect("fixture is JSON");
        let ours = serde_json::to_value(AppSettings::default()).expect("defaults serialize");
        assert_eq!(ours, fixture);
    }

    #[test]
    fn lets_every_highlighted_column_be_cleared() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.highlight_weekdays = Vec::new();
        assert!(input.normalize(&base).highlight_weekdays.is_empty());
    }

    #[test]
    fn writes_camel_case_keys() {
        let body = serde_json::to_string(&AppSettings::default()).expect("serializes");
        assert!(body.contains("\"menuBarIcon\""));
        assert!(body.contains("\"showWeekday\""));
        assert!(body.contains("\"beepOnTheHour\""));
        assert!(body.contains("\"showUpcomingEvent\""));
        assert!(body.contains("\"upcomingHorizonDays\""));
        assert!(body.contains("\"remindBeforeMeetings\""));
        assert!(body.contains("\"showEventTitleInMenuBar\""));
        assert!(body.contains("\"toggleCalendarShortcut\""));
        assert!(!body.contains("upcomingHorizonHours"));
        assert!(body.contains("\"upcomingIconLeadMinutes\""));
        assert!(body.contains("\"hiddenCalendarIds\""));
        assert!(body.contains("\"weekStartsOn\""));
        assert!(body.contains("\"highlightWeekdays\""));
        assert!(body.contains("\"launchAtLogin\""));
        assert!(!body.contains("menu_bar_icon"));
        assert!(!body.contains("menuBarFormat"));
        assert!(!body.contains("dimWeekends"));
    }

    #[test]
    fn reads_a_camel_case_settings_file() {
        let raw = r#"{
            "menuBarIcon": "framed",
            "showWeekday": false,
            "showMonth": true,
            "weekStartsOn": 1,
            "showWeekNumbers": true,
            "highlightWeekdays": [1, 5],
            "launchAtLogin": true,
            "beepOnTheHour": true,
            "theme": "dark"
        }"#;
        let parsed: AppSettings = serde_json::from_str(raw).expect("parses");
        let settings = parsed.normalize(&AppSettings::default());
        assert_eq!(settings.menu_bar_icon, "framed");
        assert!(!settings.show_weekday);
        assert!(settings.show_month);
        assert_eq!(settings.week_starts_on, 1);
        assert!(settings.show_week_numbers);
        assert_eq!(settings.highlight_weekdays, vec![1, 5]);
        assert!(settings.launch_at_login);
        assert!(settings.beep_on_the_hour);
        assert_eq!(settings.theme, "dark");
    }

    #[test]
    fn one_mistyped_field_falls_back_alone() {
        let dir = std::env::temp_dir().join(format!(
            "glance-lenient-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("dir");
        fs::write(
            dir.join("settings.json"),
            r#"{"theme": "dark", "weekStartsOn": "1", "highlightWeekdays": [-1],
                "joinMeetingShortcut": null, "showWeekNumbers": true}"#,
        )
        .expect("write");
        let settings = SettingsStore::load(dir.clone()).value();
        let defaults = AppSettings::default();
        assert_eq!(settings.theme, "dark");
        assert!(settings.show_week_numbers);
        assert_eq!(settings.week_starts_on, defaults.week_starts_on);
        assert_eq!(settings.highlight_weekdays, defaults.highlight_weekdays);
        assert_eq!(
            settings.join_meeting_shortcut,
            defaults.join_meeting_shortcut
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_a_system_color_for_today_and_drops_an_unknown_one() {
        let base = AppSettings::default();
        let green = AppSettings {
            day_highlight: "green".into(),
            ..AppSettings::default()
        };
        assert_eq!(green.normalize(&base).day_highlight, "green");
        let unknown = AppSettings {
            day_highlight: "rainbow".into(),
            ..AppSettings::default()
        };
        assert_eq!(unknown.normalize(&base).day_highlight, "red");
        let older = AppSettings {
            day_highlight: "calendar".into(),
            ..AppSettings::default()
        };
        assert_eq!(older.normalize(&base).day_highlight, "red");
    }

    #[test]
    fn migrates_dim_weekends_off_to_no_highlights() {
        let dir = std::env::temp_dir().join(format!(
            "glance-settings-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(
            dir.join("settings.json"),
            r#"{"dimWeekends": false, "theme": "dark"}
"#,
        )
        .expect("writes");
        let store = SettingsStore::load(dir.clone());
        assert!(store.value().highlight_weekdays.is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
