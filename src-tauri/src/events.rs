//! Read-only integration with the user's macOS calendars.

use serde::{Deserialize, Serialize};

/// How the user answered the invitation. Events with no attendees — a plain
/// entry the user owns — report `Confirmed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Response {
    Confirmed,
    Accepted,
    Tentative,
    Declined,
    Pending,
}

/// EKParticipantStatus values: Unknown=0, Pending=1, Accepted=2, Declined=3,
/// Tentative=4, Delegated=5, Completed=6, InProcess=7.
pub(crate) fn response_for(status: isize, is_attendee: bool) -> Response {
    if !is_attendee {
        return Response::Confirmed;
    }
    // EKParticipantStatus: 0 unknown, 1 pending, 2 accepted, 3 declined,
    // 4 tentative, 5 delegated, 6 completed, 7 in process. Delegating hands
    // the seat to someone else, so for this calendar it reads as declined.
    match status {
        2 | 6 | 7 => Response::Accepted,
        3 | 5 => Response::Declined,
        4 => Response::Tentative,
        _ => Response::Pending,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingEvent {
    pub id: String,
    pub title: String,
    pub start_at: i64,
    pub end_at: i64,
    pub calendar: Option<String>,
    /// The calendar's color as `#rrggbb`, for the dots under each day.
    pub color: Option<String>,
    pub location: Option<String>,
    pub join_url: Option<String>,
    pub response: Response,
    pub kind: String,
    pub all_day: bool,
    /// Whether anyone else was invited. Reminders and solo blocks are false.
    pub has_participants: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissedOccurrence {
    pub id: String,
    pub end_at: i64,
}

/// Most dismissals kept at once. Each lasts only until its meeting ends, so
/// this is far more than a real calendar needs; the cap only stops a
/// webview gone wrong from growing the list, and the file, without end.
pub const MAX_DISMISSED: usize = 200;

/// The id is an EventKit identifier; anything longer is not one.
const MAX_DISMISSED_ID_LEN: usize = 512;

pub fn prune_dismissed(list: &mut Vec<DismissedOccurrence>, now: i64) {
    list.retain(|item| item.end_at > now && item.id.len() <= MAX_DISMISSED_ID_LEN);
    if list.len() > MAX_DISMISSED {
        let extra = list.len() - MAX_DISMISSED;
        list.drain(..extra);
    }
}

/// Dismissals saved by an earlier run, still current. A missing or unreadable
/// file is an empty list.
pub fn load_dismissed(path: &std::path::Path, now: i64) -> Vec<DismissedOccurrence> {
    let mut list: Vec<DismissedOccurrence> = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    prune_dismissed(&mut list, now);
    list
}

/// Keeps dismissals across a restart, so a skipped meeting stays skipped.
pub fn save_dismissed(path: &std::path::Path, list: &[DismissedOccurrence]) -> std::io::Result<()> {
    let body = serde_json::to_string(list)?;
    crate::settings::write_atomically(path, body.as_bytes())
}

pub fn dismiss_occurrence(list: &mut Vec<DismissedOccurrence>, id: String, end_at: i64, now: i64) {
    prune_dismissed(list, now);
    if end_at <= now || id.len() > MAX_DISMISSED_ID_LEN {
        return;
    }
    if list
        .iter()
        .any(|item| item.id == id && item.end_at == end_at)
    {
        return;
    }
    list.push(DismissedOccurrence { id, end_at });
    prune_dismissed(list, now);
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    pub source: Option<String>,
    pub color: Option<String>,
    pub kind: String,
    /// Whether events can be added to it; subscribed calendars cannot.
    pub writable: bool,
}

/// An event typed into quick add, checked by the host before it is saved.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub title: String,
    pub start_at: i64,
    pub end_at: i64,
    pub all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
}

/// The longest event quick add will create.
const NEW_EVENT_MAX_MS: i64 = 14 * 24 * 60 * 60 * 1000;

impl NewEvent {
    /// A title, a sensible span, and at most a meeting link as its address:
    /// nothing else the webview sends reaches the calendar.
    pub fn checked(mut self) -> Result<Self, String> {
        self.title = self.title.trim().chars().take(200).collect();
        if self.title.is_empty() {
            return Err("The event needs a title".into());
        }
        if self.end_at <= self.start_at || self.end_at - self.start_at > NEW_EVENT_MAX_MS {
            return Err("The event needs an end after its start".into());
        }
        self.location = self
            .location
            .map(|place| place.trim().chars().take(500).collect::<String>())
            .filter(|place| !place.is_empty());
        if let Some(url) = &self.url {
            if !is_meeting_url(url) {
                return Err("Only a meeting link can be attached".into());
            }
        }
        Ok(self)
    }
}

/// Missing identifiers stay visible so a calendar EventKit cannot name is not dropped.
pub(crate) fn calendar_is_visible(calendar_id: Option<&str>, hidden: &[String]) -> bool {
    match calendar_id {
        None => true,
        Some(id) => !hidden.iter().any(|item| item == id),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessAction {
    Granted,
    RequestPrompt,
}

/// EventKit authorizationStatus values: NotDetermined=0, Restricted=1,
/// Denied=2, FullAccess/Authorized=3, WriteOnly=4.
///
/// Always ask EventKit unless already granted. System Settings has no add
/// control for apps that have never requested TCC, so opening Privacy is a
/// dead end for new users. Apple will not re-show the sheet after a denial,
/// but requesting still registers the app so it can be toggled later.
pub(crate) fn access_action(status: isize) -> AccessAction {
    match status {
        3 => AccessAction::Granted,
        _ => AccessAction::RequestPrompt,
    }
}

pub(crate) fn access_granted(status: isize) -> bool {
    matches!(access_action(status), AccessAction::Granted)
}

/// Apple will not re-show the EventKit sheet after Don't Allow. Opening the
/// privacy pane only makes sense for that completed denial — not a grant,
/// and not an EventKit error that left TCC untouched.
pub(crate) fn should_open_privacy_after_prompt(result: &Result<bool, String>) -> bool {
    matches!(result, Ok(false))
}

/// EventKit often keeps `authorizationStatus` on Denied and
/// `calendarsForEntityType` empty until the next launch. A successful prompt
/// in this process is enough to try reading events.
pub(crate) fn can_fetch_events(status: isize, granted_this_session: bool) -> bool {
    granted_this_session || access_granted(status)
}

/// Calendar apps claim `ical://ekevent`, so this reaches whichever one the
/// user has set as default. Identifiers carry colons, which have to be
/// escaped to stay inside one path segment.
fn percent_encode_path(id: &str) -> String {
    let mut escaped = String::with_capacity(id.len());
    for byte in id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                escaped.push(byte as char)
            }
            _ => escaped.push_str(&format!("%{byte:02X}")),
        }
    }
    escaped
}

pub(crate) fn event_show_url(id: &str) -> String {
    format!(
        "ical://ekevent/{}?method=show&options=more",
        percent_encode_path(id)
    )
}

pub(crate) const REMINDER_ID_PREFIX: &str = "reminder:";

pub(crate) fn reminder_show_url(id: &str) -> String {
    format!(
        "x-apple-reminderkit://REMCDReminder/{}",
        percent_encode_path(id)
    )
}

/// Date-only reminders occupy the due day, ending where the next day starts:
/// `day_end` is that local midnight, which the calendar works out, since a
/// flat 24 hours runs an hour into the next day when the clocks go forward.
/// Timed ones get a short slot so they can sit in the same countdown as
/// meetings.
pub(crate) fn reminder_span(due_ms: i64, day_end: Option<i64>) -> (i64, i64) {
    match day_end {
        Some(end) => (due_ms, end.max(due_ms)),
        None => (due_ms, due_ms.saturating_add(15 * 60 * 1000)),
    }
}

/// The first URL must be the Ventura+ Privacy & Security extension. A bare
/// `com.apple.Settings.PrivacySecurity` pane id still launches Settings, but
/// it lands on General and `openURL` reports success, so later URLs never run.
pub(crate) const CALENDAR_PRIVACY_URLS: &[&str] = &[
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
];

pub(crate) const REMINDER_PRIVACY_URLS: &[&str] = &[
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Reminders",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
];

/// Same ordering trap as above, and the pane id is not the one the docs give:
/// it is `Date-Time`, not `Date-and-Time`. Read it off the extension bundle
/// rather than trusting a writeup --
/// `defaults read "/System/Library/ExtensionKit/Extensions/DateAndTime Extension.appex/Contents/Info.plist" CFBundleIdentifier`.
/// The documented spelling stays as a fallback for systems that do use it.
pub(crate) const DATE_TIME_SETTINGS_URLS: &[&str] = &[
    "x-apple.systempreferences:com.apple.Date-Time-Settings.extension",
    "x-apple.systempreferences:com.apple.Date-and-Time-Settings.extension",
    "x-apple.systempreferences:com.apple.preference.datetime",
];

/// Where each service holds its meetings. Keep in step with `meetings.ts`.
///
/// Hosts are matched exactly or as a subdomain, never as a lookalike suffix,
/// and a service's marketing, support and community sites are left out: an
/// invitation is written by whoever sent it, so Join must only ever open a
/// meeting, not any page a sender chose on a known company's domain.
const ZOOM_DOMAINS: &[&str] = &["zoom.us", "zoom.com"];
/// Zoom's join paths: meetings, personal rooms, webinars, the web client.
const ZOOM_JOIN_PATHS: &[&str] = &["/j/", "/my/", "/w/", "/s/", "/wc/"];
/// Zoom's own sites that sit on a subdomain but never hold a meeting.
const ZOOM_SITES: &[&str] = &[
    "community",
    "support",
    "marketplace",
    "explore",
    "developers",
    "blog",
    "news",
    "status",
];

/// The host of an https address, lowercased and without a trailing dot.
fn host_of(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    match url.host()? {
        url::Host::Domain(host) => Some(host.trim_end_matches('.').to_ascii_lowercase()),
        _ => None,
    }
}

fn serves_host(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// The label left of `domain` in `host`, as `acme` in `acme.zoom.us`.
fn subdomain_of<'a>(host: &'a str, domain: &str) -> Option<&'a str> {
    host.strip_suffix(domain)?.strip_suffix('.')
}

/// A Meet room code, `abc-defg-hij`, as the first path segment.
fn meet_room_code(path: &str) -> bool {
    let code = path.trim_start_matches('/');
    let code = code.split('/').next().unwrap_or("");
    let parts: Vec<&str> = code.split('-').collect();
    parts.len() == 3
        && parts
            .iter()
            .zip([3, 4, 3])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_lowercase()))
}

/// Whether a host and path belong to a meeting on a known service. The
/// path matters on hosts that also serve help and landing pages, so that a
/// link to one of those in an invite's notes does not become a Join button.
fn meeting_place(host: &str, path: &str) -> bool {
    if host == "meet.google.com" {
        return meet_room_code(path) || path.starts_with("/lookup/");
    }
    if host == "teams.microsoft.com" {
        return path.starts_with("/l/meetup-join/")
            || path.starts_with("/meet/")
            || path.starts_with("/dl/launcher/");
    }
    if host == "teams.live.com" {
        return path.starts_with("/meet/");
    }
    if host == "facetime.apple.com" {
        return path.starts_with("/join");
    }
    if let Some(domain) = ZOOM_DOMAINS.iter().find(|domain| serves_host(host, domain)) {
        let site = subdomain_of(host, domain)
            .and_then(|sub| sub.rsplit('.').next())
            .is_some_and(|label| ZOOM_SITES.contains(&label));
        return !site
            && ZOOM_JOIN_PATHS
                .iter()
                .any(|prefix| path.starts_with(prefix));
    }
    // Webex meetings live on a company's own subdomain; www is the brochure.
    if let Some(sub) = subdomain_of(host, "webex.com") {
        return sub != "www";
    }
    // Jitsi's public rooms live on meet.jit.si; jitsi.org is the project site.
    if serves_host(host, "jit.si") {
        return true;
    }
    if serves_host(host, "gotomeeting.com") {
        return true;
    }
    host == "meet.goto.com" || host == "app.goto.com"
}

/// A link Join may open: https, no credentials or odd port, on a meeting host.
pub(crate) fn is_meeting_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(url::Host::Domain(host)) = url.host() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    meeting_place(&host, url.path())
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (from_hex(bytes[index + 1]), from_hex(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key == name {
            return Some(percent_decode(value));
        }
    }
    None
}

/// Google Calendar wraps the real join link in a redirect.
fn unwrap_redirect(url: &str) -> String {
    let host = host_of(url).unwrap_or_default();
    if (serves_host(&host, "google.com") || serves_host(&host, "googleusercontent.com"))
        && url.contains("/url?")
    {
        if let Some(target) = query_param(url, "q") {
            if target.starts_with("http://") || target.starts_with("https://") {
                return target;
            }
        }
    }
    url.to_string()
}

fn decode_entities(url: &str) -> String {
    url.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn url_end(slice: &str) -> usize {
    let mut end = 0;
    for (index, character) in slice.char_indices() {
        if character.is_whitespace()
            || matches!(
                character,
                '"' | '\'' | '<' | '>' | ')' | ']' | '`' | '{' | '}'
            )
        {
            break;
        }
        end = index + character.len_utf8();
    }
    end
}

fn take_http_url(input: &str, start: usize) -> String {
    let mut url = decode_entities(&input[start..start + url_end(&input[start..])]);
    while url.ends_with(['.', ',', ';', ':', '!', '?']) {
        url.pop();
    }
    unwrap_redirect(&url)
}

/// http(s) URLs anywhere in the text, not only as whitespace-delimited tokens.
/// Zoom invites from Google Calendar and Outlook put the join link in an href.
fn urls_in(value: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let lower = value.to_ascii_lowercase();
    let mut cursor = 0;
    while cursor < value.len() {
        let rest = &lower[cursor..];
        let https = rest.find("https://");
        let http = rest.find("http://");
        let relative = match (https, http) {
            (Some(https), Some(http)) => https.min(http),
            (Some(https), None) => https,
            (None, Some(http)) => http,
            (None, None) => break,
        };
        let start = cursor + relative;
        let raw_end = url_end(&value[start..]).max(1);
        let url = take_http_url(value, start);
        cursor = start + raw_end;
        if url.starts_with("http://") || url.starts_with("https://") {
            urls.push(url);
        }
    }
    urls
}

fn zoommtg_to_https(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let start = lower.find("zoommtg://")?;
    let rest = &value[start + "zoommtg://".len()..];
    let url = take_http_url(&format!("https://{rest}"), 0);
    let host = host_of(&url)?;
    if !serves_host(&host, "zoom.us") && !serves_host(&host, "zoom.com") {
        return None;
    }
    let confno = query_param(&url, "confno")?;
    if confno.is_empty() {
        return None;
    }
    let mut join = format!("https://{host}/j/{confno}");
    if let Some(pwd) = query_param(&url, "pwd") {
        if !pwd.is_empty() {
            join.push_str(&format!("?pwd={pwd}"));
        }
    }
    Some(join)
}

/// Pull a joinable meeting URL out of an event's URL, location, and notes.
/// Only https links on a known meeting host count: an invite is written by
/// whoever sent it, so any other link would make "Join" and its global
/// shortcut a one-press way to open a stranger's page.
pub(crate) fn extract_join_url(
    event_url: Option<&str>,
    location: Option<&str>,
    notes: Option<&str>,
) -> Option<String> {
    let mut first_meeting = None;
    for blob in [event_url, location, notes].into_iter().flatten() {
        if first_meeting.is_none() {
            if let Some(zoom) = zoommtg_to_https(blob) {
                first_meeting = Some(zoom);
            }
        }
        for url in urls_in(blob) {
            if first_meeting.is_none() && is_meeting_url(&url) {
                first_meeting = Some(url);
            }
        }
    }
    first_meeting
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        access_action, access_granted, can_fetch_events, event_show_url, reminder_show_url,
        response_for, AccessAction, Response, UpcomingEvent, CALENDAR_PRIVACY_URLS,
        DATE_TIME_SETTINGS_URLS, REMINDER_PRIVACY_URLS,
    };
    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::Bool;
    use objc2::{available, AnyThread};
    use objc2_app_kit::{NSApplication, NSColorSpace, NSWorkspace};
    use objc2_event_kit::{
        EKCalendar, EKEntityType, EKEvent, EKEventStore, EKReminder, EKSource, EKSpan,
    };
    use objc2_foundation::{
        MainThreadMarker, NSCalendar, NSDate, NSDateComponentUndefined, NSDateComponents, NSString,
        NSURL,
    };
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    thread_local! {
        static STORE: RefCell<Option<Retained<EKEventStore>>> = const { RefCell::new(None) };
    }
    static SESSION_GRANTED: AtomicBool = AtomicBool::new(false);
    static SESSION_REMINDERS_GRANTED: AtomicBool = AtomicBool::new(false);
    static NEEDS_RESET: AtomicBool = AtomicBool::new(false);

    fn require_main_thread() {
        assert!(
            MainThreadMarker::new().is_some(),
            "EventKit must run on the main thread"
        );
    }

    fn status_code() -> isize {
        unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) }.0
    }

    fn reminder_status_code() -> isize {
        unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Reminder) }.0
    }

    fn new_store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::init(EKEventStore::alloc()) }
    }

    fn event_store() -> Retained<EKEventStore> {
        require_main_thread();
        STORE.with(|slot| {
            if slot.borrow().is_none() {
                *slot.borrow_mut() = Some(new_store());
            }
            slot.borrow().clone().expect("calendar store")
        })
    }

    pub fn refresh_after_access_change() {
        require_main_thread();
        STORE.with(|slot| {
            if let Some(store) = slot.borrow().as_ref() {
                unsafe {
                    store.reset();
                    store.refreshSourcesIfNecessary();
                }
            }
        });
        NEEDS_RESET.store(false, Ordering::SeqCst);
    }

    fn mark_granted() {
        SESSION_GRANTED.store(true, Ordering::SeqCst);
        NEEDS_RESET.store(true, Ordering::SeqCst);
    }

    fn mark_reminders_granted() {
        SESSION_REMINDERS_GRANTED.store(true, Ordering::SeqCst);
        NEEDS_RESET.store(true, Ordering::SeqCst);
    }

    fn granted_this_session() -> bool {
        SESSION_GRANTED.load(Ordering::SeqCst)
    }

    fn reminders_granted_this_session() -> bool {
        SESSION_REMINDERS_GRANTED.load(Ordering::SeqCst)
    }

    pub fn finish_access_request(granted: bool) {
        require_main_thread();
        if granted {
            mark_granted();
        }
        refresh_after_access_change();
    }

    fn activate_app() {
        let Some(marker) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(marker);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }

    fn open_settings_pane(urls: &[&str], label: &str) -> Result<(), String> {
        let workspace = NSWorkspace::sharedWorkspace();
        for url in urls {
            let Some(target) = NSURL::URLWithString(&NSString::from_str(url)) else {
                continue;
            };
            if workspace.openURL(&target) {
                return Ok(());
            }
        }
        Err(format!("Could not open {label} settings"))
    }

    pub(crate) fn open_calendar_privacy_settings() -> Result<(), String> {
        open_settings_pane(CALENDAR_PRIVACY_URLS, "Calendar privacy")
    }

    pub(crate) fn open_reminder_privacy_settings() -> Result<(), String> {
        open_settings_pane(REMINDER_PRIVACY_URLS, "Reminders privacy")
    }

    pub(crate) fn open_date_time_settings() -> Result<(), String> {
        open_settings_pane(DATE_TIME_SETTINGS_URLS, "Date & Time")
    }

    fn request_access(
        store: Retained<EKEventStore>,
        reply: impl FnOnce(Result<bool, String>) + Send + 'static,
    ) {
        let reply = Mutex::new(Some(reply));
        let completion = RcBlock::new(
            move |granted: Bool, error: *mut objc2_foundation::NSError| {
                let result = if let Some(error) = unsafe { error.as_ref() } {
                    Err(error.localizedDescription().to_string())
                } else {
                    Ok(granted.as_bool())
                };
                if matches!(result, Ok(true)) {
                    mark_granted();
                }
                if let Some(reply) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                    reply(result);
                }
            },
        );
        unsafe {
            #[allow(deprecated)]
            if available!(macos = 14.0) {
                store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&completion));
            } else {
                store.requestAccessToEntityType_completion(
                    EKEntityType::Event,
                    RcBlock::as_ptr(&completion),
                );
            }
        }
        // EventKit copies the escaping completion handler, so our retain
        // can go now, as it does for the fetch below.
    }

    pub fn begin_access_request(reply: impl FnOnce(Result<bool, String>) + Send + 'static) {
        require_main_thread();
        match access_action(status_code()) {
            AccessAction::Granted => {
                mark_granted();
                reply(Ok(true));
            }
            AccessAction::RequestPrompt => {
                activate_app();
                request_access(event_store(), reply);
            }
        }
    }

    pub fn has_access() -> bool {
        require_main_thread();
        if can_fetch_events(status_code(), granted_this_session()) {
            return true;
        }
        refresh_after_access_change();
        if access_granted(status_code()) {
            mark_granted();
            return true;
        }
        false
    }

    fn request_reminders_access(
        store: Retained<EKEventStore>,
        reply: impl FnOnce(Result<bool, String>) + Send + 'static,
    ) {
        let reply = Mutex::new(Some(reply));
        let completion = RcBlock::new(
            move |granted: Bool, error: *mut objc2_foundation::NSError| {
                let result = if let Some(error) = unsafe { error.as_ref() } {
                    Err(error.localizedDescription().to_string())
                } else {
                    Ok(granted.as_bool())
                };
                if matches!(result, Ok(true)) {
                    mark_reminders_granted();
                }
                if let Some(reply) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                    reply(result);
                }
            },
        );
        unsafe {
            #[allow(deprecated)]
            if available!(macos = 14.0) {
                store.requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&completion));
            } else {
                store.requestAccessToEntityType_completion(
                    EKEntityType::Reminder,
                    RcBlock::as_ptr(&completion),
                );
            }
        }
    }

    pub fn begin_reminders_access_request(
        reply: impl FnOnce(Result<bool, String>) + Send + 'static,
    ) {
        require_main_thread();
        match access_action(reminder_status_code()) {
            AccessAction::Granted => {
                mark_reminders_granted();
                reply(Ok(true));
            }
            AccessAction::RequestPrompt => {
                activate_app();
                request_reminders_access(event_store(), reply);
            }
        }
    }

    pub fn finish_reminders_access_request(granted: bool) {
        require_main_thread();
        if granted {
            mark_reminders_granted();
        }
        refresh_after_access_change();
    }

    pub fn has_reminders_access() -> bool {
        require_main_thread();
        if can_fetch_events(reminder_status_code(), reminders_granted_this_session()) {
            return true;
        }
        refresh_after_access_change();
        if access_granted(reminder_status_code()) {
            mark_reminders_granted();
            return true;
        }
        false
    }

    fn ns_string(value: &NSString) -> String {
        value.to_string()
    }

    /// Whether the event names anyone besides its owner.
    fn has_participants(event: &objc2_event_kit::EKEvent) -> bool {
        unsafe { event.attendees() }.is_some_and(|attendees| attendees.count() > 0)
    }

    /// The user's own answer to the invitation, read from the attendee list.
    fn own_response(event: &objc2_event_kit::EKEvent) -> Response {
        let Some(attendees) = (unsafe { event.attendees() }) else {
            return Response::Confirmed;
        };
        for index in 0..attendees.count() {
            let attendee = attendees.objectAtIndex(index);
            if unsafe { attendee.isCurrentUser() } {
                return response_for(unsafe { attendee.participantStatus() }.0, true);
            }
        }
        // An invitation whose attendee list does not name us still counts as
        // one: fall back to the organizer's view of the event.
        Response::Confirmed
    }

    fn calendar_hex(calendar: &EKCalendar) -> Option<String> {
        let color = unsafe { calendar.color() };
        let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let mut red = 0.0;
        let mut green = 0.0;
        let mut blue = 0.0;
        let mut alpha = 0.0;
        unsafe {
            srgb.getRed_green_blue_alpha(&mut red, &mut green, &mut blue, &mut alpha);
        }
        let byte = |value: f64| (value * 255.0).round().clamp(0.0, 255.0) as u8;
        Some(format!(
            "#{:02X}{:02X}{:02X}",
            byte(red),
            byte(green),
            byte(blue)
        ))
    }

    fn calendar_source_title(source: Option<Retained<EKSource>>) -> Option<String> {
        source.map(|value| {
            let title = unsafe { value.title() };
            ns_string(&title)
        })
    }

    fn collect_calendars(
        store: &EKEventStore,
        entity: EKEntityType,
        kind: &str,
    ) -> Vec<super::CalendarInfo> {
        let calendars = unsafe { store.calendarsForEntityType(entity) };
        let mut found = Vec::new();
        for index in 0..calendars.count() {
            let calendar = calendars.objectAtIndex(index);
            let id_obj = unsafe { calendar.calendarIdentifier() };
            let id = ns_string(&id_obj);
            if id.is_empty() {
                continue;
            }
            let title_obj = unsafe { calendar.title() };
            let title = ns_string(&title_obj);
            found.push(super::CalendarInfo {
                id,
                title: if title.is_empty() {
                    if kind == "reminder" {
                        "Untitled list".into()
                    } else {
                        "Untitled calendar".into()
                    }
                } else {
                    title
                },
                source: calendar_source_title(unsafe { calendar.source() }),
                color: calendar_hex(&calendar),
                kind: kind.into(),
                writable: unsafe { calendar.allowsContentModifications() },
            });
        }
        found
    }

    pub fn list_macos() -> Result<Vec<super::CalendarInfo>, String> {
        require_main_thread();
        autoreleasepool(|_| {
            let store = event_store();
            if NEEDS_RESET.load(Ordering::SeqCst) {
                unsafe {
                    store.reset();
                    store.refreshSourcesIfNecessary();
                }
                NEEDS_RESET.store(false, Ordering::SeqCst);
            } else {
                unsafe { store.refreshSourcesIfNecessary() };
            }
            let mut found = Vec::new();
            if can_fetch_events(status_code(), granted_this_session()) {
                found.extend(collect_calendars(&store, EKEntityType::Event, "event"));
            }
            if can_fetch_events(reminder_status_code(), reminders_granted_this_session()) {
                found.extend(collect_calendars(
                    &store,
                    EKEntityType::Reminder,
                    "reminder",
                ));
            }
            found.sort_by(|left, right| {
                left.kind
                    .cmp(&right.kind)
                    .then_with(|| left.source.cmp(&right.source))
                    .then_with(|| left.title.cmp(&right.title))
            });
            Ok(found)
        })
    }

    pub fn fetch_macos_range(
        start_ms: i64,
        end_ms: i64,
        hidden: &[String],
    ) -> Result<super::PendingFetch, String> {
        require_main_thread();
        autoreleasepool(|_| {
            let store = event_store();
            if NEEDS_RESET.load(Ordering::SeqCst) {
                unsafe {
                    store.reset();
                    store.refreshSourcesIfNecessary();
                }
                NEEDS_RESET.store(false, Ordering::SeqCst);
            } else {
                unsafe { store.refreshSourcesIfNecessary() };
            }
            if !can_fetch_events(status_code(), granted_this_session()) {
                // src/shared/events.ts matches these words to offer the prompt.
                return Err("Calendar access is not enabled".into());
            }
            let start = NSDate::dateWithTimeIntervalSince1970(start_ms as f64 / 1000.0);
            let end = NSDate::dateWithTimeIntervalSince1970(end_ms as f64 / 1000.0);
            let predicate = unsafe {
                store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None)
            };
            let events = unsafe { store.eventsMatchingPredicate(&predicate) };
            let mut found = Vec::new();
            for index in 0..events.count() {
                let event = events.objectAtIndex(index);
                let start = unsafe { event.startDate().timeIntervalSince1970() };
                let end = unsafe { event.endDate().timeIntervalSince1970() };
                if end <= start {
                    continue;
                }
                let all_day = unsafe { event.isAllDay() };
                if unsafe { event.status() } == objc2_event_kit::EKEventStatus::Canceled {
                    continue;
                }

                let title_obj = unsafe { event.title() };
                let title = ns_string(&title_obj);
                let location: Option<String> =
                    unsafe { event.location() }.map(|value| ns_string(&value));
                let notes: Option<String> = unsafe { event.notes() }.map(|value| ns_string(&value));
                let raw_url: Option<Retained<NSURL>> = unsafe { event.URL() };
                let event_url: Option<String> = match raw_url {
                    Some(value) => value.absoluteString().map(|value| ns_string(&value)),
                    None => None,
                };
                let join_url = super::extract_join_url(
                    event_url.as_deref(),
                    location.as_deref(),
                    notes.as_deref(),
                );
                let raw_calendar: Option<Retained<EKCalendar>> = unsafe { event.calendar() };
                let calendar_id = raw_calendar.as_ref().map(|value| {
                    let id_obj = unsafe { value.calendarIdentifier() };
                    ns_string(&id_obj)
                });
                if !super::calendar_is_visible(calendar_id.as_deref(), hidden) {
                    continue;
                }
                let color = raw_calendar.as_deref().and_then(calendar_hex);
                let calendar: Option<String> = raw_calendar.map(|value| {
                    let title = unsafe { value.title() };
                    ns_string(&title)
                });
                let id = unsafe { event.eventIdentifier() }
                    .map(|value| ns_string(&value))
                    .unwrap_or_else(|| format!("{start:.3}-{end:.3}-{title}"));
                found.push(UpcomingEvent {
                    id,
                    title: if title.is_empty() {
                        "Untitled event".into()
                    } else {
                        title
                    },
                    start_at: (start * 1000.0) as i64,
                    end_at: (end * 1000.0) as i64,
                    calendar,
                    color,
                    location: location.filter(|value| !value.is_empty()),
                    join_url,
                    response: own_response(&event),
                    kind: "event".into(),
                    all_day,
                    has_participants: has_participants(&event),
                });
            }
            let reminders =
                if can_fetch_events(reminder_status_code(), reminders_granted_this_session()) {
                    Some(start_reminders_fetch(&store, start_ms, end_ms, hidden))
                } else {
                    None
                };
            Ok(super::PendingFetch {
                events: found,
                reminders,
            })
        })
    }

    /// When a reminder is due and, for one with a date but no time, where
    /// that day ends: the next local midnight by the calendar's own count,
    /// so the day is as long as the clocks make it.
    fn reminder_due(components: &NSDateComponents) -> Option<(i64, Option<i64>)> {
        use objc2_foundation::{NSCalendarOptions, NSCalendarUnit};

        if components.year() == NSDateComponentUndefined
            || components.month() == NSDateComponentUndefined
            || components.day() == NSDateComponentUndefined
        {
            return None;
        }
        let all_day = components.hour() == NSDateComponentUndefined;
        let calendar = NSCalendar::currentCalendar();
        let date = calendar.dateFromComponents(components)?;
        let ms = |date: &NSDate| (date.timeIntervalSince1970() * 1000.0) as i64;
        let day_end = all_day.then(|| {
            calendar
                .dateByAddingUnit_value_toDate_options(
                    NSCalendarUnit::Day,
                    1,
                    &date,
                    NSCalendarOptions::empty(),
                )
                .map(|next| ms(&next))
                // A calendar that cannot add a day: fall back to the flat day.
                .unwrap_or_else(|| ms(&date).saturating_add(24 * 60 * 60 * 1000))
        });
        Some((ms(&date), day_end))
    }

    /// Asks EventKit for the range's reminders and returns where they will
    /// arrive. EventKit answers on a queue of its own, so the caller waits off
    /// the main thread rather than spinning its run loop here.
    fn start_reminders_fetch(
        store: &EKEventStore,
        start_ms: i64,
        end_ms: i64,
        hidden: &[String],
    ) -> std::sync::mpsc::Receiver<Vec<UpcomingEvent>> {
        let start = NSDate::dateWithTimeIntervalSince1970(start_ms as f64 / 1000.0);
        let end = NSDate::dateWithTimeIntervalSince1970(end_ms as f64 / 1000.0);
        let predicate = unsafe {
            store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(
                Some(&start),
                Some(&end),
                None,
            )
        };
        let hidden = hidden.to_vec();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let completion = RcBlock::new(
            move |reminders: *mut objc2_foundation::NSArray<EKReminder>| {
                let mut found = Vec::new();
                if let Some(list) = unsafe { reminders.as_ref() } {
                    for index in 0..list.count() {
                        let reminder = list.objectAtIndex(index);
                        if unsafe { reminder.isCompleted() } {
                            continue;
                        }
                        let Some(components) = (unsafe { reminder.dueDateComponents() }) else {
                            continue;
                        };
                        let Some((due_ms, day_end)) = reminder_due(&components) else {
                            continue;
                        };
                        let raw_calendar: Option<Retained<EKCalendar>> =
                            unsafe { reminder.calendar() };
                        let calendar_id = raw_calendar.as_ref().map(|value| {
                            let id_obj = unsafe { value.calendarIdentifier() };
                            ns_string(&id_obj)
                        });
                        if !super::calendar_is_visible(calendar_id.as_deref(), &hidden) {
                            continue;
                        }
                        let title_obj = unsafe { reminder.title() };
                        let title = ns_string(&title_obj);
                        let id_obj = unsafe { reminder.calendarItemIdentifier() };
                        let id = ns_string(&id_obj);
                        let all_day = day_end.is_some();
                        let (start_at, end_at) = super::reminder_span(due_ms, day_end);
                        let color = raw_calendar.as_deref().and_then(calendar_hex);
                        found.push(UpcomingEvent {
                            id: format!("{}{id}", super::REMINDER_ID_PREFIX),
                            title: if title.is_empty() {
                                "Untitled reminder".into()
                            } else {
                                title
                            },
                            start_at,
                            end_at,
                            calendar: raw_calendar.map(|value| {
                                let title = unsafe { value.title() };
                                ns_string(&title)
                            }),
                            color,
                            location: None,
                            join_url: None,
                            response: Response::Confirmed,
                            kind: "reminder".into(),
                            all_day,
                            has_participants: false,
                        });
                    }
                }
                let _ = sender.send(found);
            },
        );
        // EventKit copies the block it keeps, so ours can go when this does.
        unsafe {
            store.fetchRemindersMatchingPredicate_completion(&predicate, &completion);
        }
        receiver
    }

    pub fn open_reminder(id: &str) -> Result<(), String> {
        let string = NSString::from_str(&reminder_show_url(id));
        let Some(url) = NSURL::URLWithString(&string) else {
            return Err("Invalid reminder link".into());
        };
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            return Ok(());
        }
        let fallback = NSString::from_str("reminders://");
        let Some(home) = NSURL::URLWithString(&fallback) else {
            return Err("Could not open the reminder".into());
        };
        if NSWorkspace::sharedWorkspace().openURL(&home) {
            Ok(())
        } else {
            Err("Could not open the reminder in Reminders".into())
        }
    }

    /// Saves a new event to the chosen calendar, or the default one, and
    /// returns its identifier.
    pub fn create_event(new: &super::NewEvent, calendar_id: &str) -> Result<String, String> {
        require_main_thread();
        if !can_fetch_events(status_code(), granted_this_session()) {
            return Err("Calendar access is needed to add events".into());
        }
        autoreleasepool(|_| {
            let store = event_store();
            let chosen = if calendar_id.is_empty() {
                None
            } else {
                unsafe { store.calendarWithIdentifier(&NSString::from_str(calendar_id)) }
            };
            let Some(calendar) = chosen.or_else(|| unsafe { store.defaultCalendarForNewEvents() })
            else {
                return Err("There is no calendar to add events to".into());
            };
            if !unsafe { calendar.allowsContentModifications() } {
                return Err("That calendar can’t take new events".into());
            }
            let event = unsafe { EKEvent::eventWithEventStore(&store) };
            unsafe {
                event.setCalendar(Some(&calendar));
                event.setTitle(Some(&NSString::from_str(&new.title)));
                event.setAllDay(new.all_day);
                event.setStartDate(Some(&NSDate::dateWithTimeIntervalSince1970(
                    new.start_at as f64 / 1000.0,
                )));
                event.setEndDate(Some(&NSDate::dateWithTimeIntervalSince1970(
                    new.end_at as f64 / 1000.0,
                )));
                if let Some(place) = &new.location {
                    event.setLocation(Some(&NSString::from_str(place)));
                }
                if let Some(link) = new.url.as_deref() {
                    event.setURL(NSURL::URLWithString(&NSString::from_str(link)).as_deref());
                }
                store
                    .saveEvent_span_commit_error(&event, EKSpan::ThisEvent, true)
                    .map_err(|error| ns_string(&error.localizedDescription()))?;
            }
            unsafe { event.eventIdentifier() }
                .map(|id| ns_string(&id))
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "The event was saved without an identifier".to_string())
        })
    }

    /// Removes an event quick add just created, for Undo.
    pub fn remove_event(id: &str) -> Result<(), String> {
        require_main_thread();
        autoreleasepool(|_| {
            let store = event_store();
            let Some(event) = (unsafe { store.eventWithIdentifier(&NSString::from_str(id)) })
            else {
                return Ok(());
            };
            unsafe { store.removeEvent_span_commit_error(&event, EKSpan::ThisEvent, true) }
                .map_err(|error| ns_string(&error.localizedDescription()))
        })
    }

    pub fn open_event(id: &str) -> Result<(), String> {
        let string = NSString::from_str(&event_show_url(id));
        let Some(url) = NSURL::URLWithString(&string) else {
            return Err("Invalid event link".into());
        };
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            Ok(())
        } else {
            Err("Could not open the event in your calendar".into())
        }
    }

    /// Callers vet the address first; this only hands it to the browser.
    pub fn open_https(url: &str) -> Result<(), String> {
        if !url.starts_with("https://") {
            return Err("Link must use https".into());
        }
        let string = NSString::from_str(url);
        let Some(url) = NSURL::URLWithString(&string) else {
            return Err("Invalid link".into());
        };
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            Ok(())
        } else {
            Err("Could not open link".into())
        }
    }
}

#[cfg(target_os = "macos")]
pub fn finish_access_request(granted: bool) {
    macos::finish_access_request(granted);
}

#[cfg(not(target_os = "macos"))]
pub fn finish_access_request(_granted: bool) {}

#[cfg(target_os = "macos")]
pub fn begin_access_request(reply: impl FnOnce(Result<bool, String>) + Send + 'static) {
    macos::begin_access_request(reply);
}

#[cfg(not(target_os = "macos"))]
pub fn begin_access_request(reply: impl FnOnce(Result<bool, String>) + Send + 'static) {
    reply(Ok(false));
}

#[cfg(target_os = "macos")]
pub fn begin_reminders_access_request(reply: impl FnOnce(Result<bool, String>) + Send + 'static) {
    macos::begin_reminders_access_request(reply);
}

#[cfg(not(target_os = "macos"))]
pub fn begin_reminders_access_request(reply: impl FnOnce(Result<bool, String>) + Send + 'static) {
    reply(Ok(false));
}

#[cfg(target_os = "macos")]
pub fn finish_reminders_access_request(granted: bool) {
    macos::finish_reminders_access_request(granted);
}

#[cfg(not(target_os = "macos"))]
pub fn finish_reminders_access_request(_granted: bool) {}

pub fn has_reminders_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::has_reminders_access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::list_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

pub fn has_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::has_access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn open_calendar_privacy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open_calendar_privacy_settings()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Calendar privacy settings are only available on macOS".into())
    }
}

pub fn open_reminders_privacy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open_reminder_privacy_settings()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Reminders privacy settings are only available on macOS".into())
    }
}

pub fn open_date_time_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open_date_time_settings()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Date & Time settings are only available on macOS".into())
    }
}

/// A range's events, read at once on the main thread, and its reminders,
/// still on their way from EventKit.
pub struct PendingFetch {
    events: Vec<UpcomingEvent>,
    reminders: Option<std::sync::mpsc::Receiver<Vec<UpcomingEvent>>>,
}

/// How long to wait for reminders before showing the events without them.
const REMINDERS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl PendingFetch {
    /// Joins the reminders to the events, in start order. Blocks while they
    /// arrive, so it runs off the main thread. Reminders that fail or take
    /// too long are left out; the events still show.
    pub fn finish(self) -> Vec<UpcomingEvent> {
        let mut found = self.events;
        if let Some(receiver) = self.reminders {
            match receiver.recv_timeout(REMINDERS_TIMEOUT) {
                Ok(reminders) => found.extend(reminders),
                Err(_) => eprintln!("Glance: reminders did not arrive; showing events only"),
            }
        }
        found.sort_by_key(|event| event.start_at);
        found
    }
}

/// Starts reading a range. Call on the main thread, then `finish` off it.
pub fn start_range(start_ms: i64, end_ms: i64, hidden: &[String]) -> Result<PendingFetch, String> {
    #[cfg(target_os = "macos")]
    {
        if end_ms <= start_ms {
            return Ok(PendingFetch {
                events: Vec::new(),
                reminders: None,
            });
        }
        macos::fetch_macos_range(start_ms, end_ms, hidden)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (start_ms, end_ms, hidden);
        Ok(PendingFetch {
            events: Vec::new(),
            reminders: None,
        })
    }
}

pub fn create_event(new: &NewEvent, calendar_id: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::create_event(new, calendar_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (new, calendar_id);
        Err("Adding events is only supported on macOS".into())
    }
}

pub fn remove_event(id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::remove_event(id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("Removing events is only supported on macOS".into())
    }
}

pub fn open_event(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("This event has no identifier to open".into());
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(reminder_id) = id.strip_prefix(REMINDER_ID_PREFIX) {
            return macos::open_reminder(reminder_id);
        }
        macos::open_event(id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Opening events is only supported on macOS".into())
    }
}

/// Opens a meeting link, but only one `extract_join_url` would have chosen,
/// so the webview cannot use this to open an arbitrary address.
pub fn open_meeting(url: &str) -> Result<(), String> {
    if !is_meeting_url(url) {
        return Err("Not a meeting link".into());
    }
    open_https(url)
}

/// Apple Maps searching for a meeting's place. The host is fixed and the
/// place goes in as a query value, so the text cannot point anywhere else.
pub fn maps_url(place: &str) -> Result<String, String> {
    let place = place.trim();
    if place.is_empty() || place.chars().count() > 500 {
        return Err("Not a place".into());
    }
    url::Url::parse_with_params("https://maps.apple.com/", &[("q", place)])
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

/// Opens a fixed https address the host itself chose, such as the repository.
pub fn open_https(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open_https(url)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("Links are only supported on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        access_action, access_granted, calendar_is_visible, can_fetch_events, dismiss_occurrence,
        event_show_url, extract_join_url, prune_dismissed, reminder_show_url, reminder_span,
        response_for, should_open_privacy_after_prompt, AccessAction, DismissedOccurrence,
        Response, CALENDAR_PRIVACY_URLS, REMINDER_PRIVACY_URLS,
    };

    #[test]
    fn full_access_and_the_legacy_authorized_alias_are_granted() {
        assert!(access_granted(3));
        assert_eq!(access_action(3), AccessAction::Granted);
    }

    #[test]
    fn write_only_asks_for_full_access_instead_of_opening_settings() {
        assert_eq!(access_action(4), AccessAction::RequestPrompt);
        assert!(!access_granted(4));
    }

    #[test]
    fn a_successful_prompt_can_fetch_before_status_catches_up() {
        assert!(can_fetch_events(2, true));
        assert!(!can_fetch_events(2, false));
        assert!(can_fetch_events(3, false));
    }

    #[test]
    fn undetermined_asks_for_access() {
        assert_eq!(access_action(0), AccessAction::RequestPrompt);
    }

    #[test]
    fn denied_and_restricted_still_ask_for_access() {
        assert_eq!(access_action(1), AccessAction::RequestPrompt);
        assert_eq!(access_action(2), AccessAction::RequestPrompt);
        assert!(!access_granted(2));
    }

    #[test]
    fn a_denial_opens_privacy_settings_a_grant_or_error_does_not() {
        assert!(should_open_privacy_after_prompt(&Ok(false)));
        assert!(!should_open_privacy_after_prompt(&Ok(true)));
        assert!(!should_open_privacy_after_prompt(&Err(
            "EventKit is unavailable".into()
        )));
    }

    #[test]
    fn privacy_urls_try_the_extension_pane_before_legacy_settings() {
        assert_eq!(
            CALENDAR_PRIVACY_URLS[0],
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars"
        );
        assert_eq!(
            REMINDER_PRIVACY_URLS[0],
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Reminders"
        );
        assert!(CALENDAR_PRIVACY_URLS
            .iter()
            .any(|url| url.contains("preference.security")));
        assert!(CALENDAR_PRIVACY_URLS
            .iter()
            .all(|url| url.ends_with("Privacy_Calendars")));
        assert!(REMINDER_PRIVACY_URLS
            .iter()
            .all(|url| url.ends_with("Privacy_Reminders")));
    }

    #[test]
    fn event_links_escape_the_identifier() {
        assert_eq!(
            event_show_url("ABC-123"),
            "ical://ekevent/ABC-123?method=show&options=more"
        );
        assert!(event_show_url("A1B2:C3D4").starts_with("ical://ekevent/A1B2%3AC3D4?"));
        assert!(event_show_url("with space/slash").contains("with%20space%2Fslash"));
    }

    #[test]
    fn reminder_slots_cover_a_day_or_a_short_timed_window() {
        assert_eq!(reminder_span(1_000, None), (1_000, 1_000 + 15 * 60 * 1000));
        // A 23-hour day, as when the clocks go forward: the slot ends where
        // the calendar says the next day starts, not a flat day later.
        let short_day = 23 * 60 * 60 * 1000;
        assert_eq!(
            reminder_span(1_000, Some(1_000 + short_day)),
            (1_000, 1_000 + short_day)
        );
        // A day end before the due time cannot make a negative slot.
        assert_eq!(reminder_span(5_000, Some(1_000)), (5_000, 5_000));
    }

    #[test]
    fn reminder_links_open_the_reminders_item() {
        assert!(
            reminder_show_url("ABC-123").starts_with("x-apple-reminderkit://REMCDReminder/ABC-123")
        );
        assert!(reminder_show_url("A:B").contains("A%3AB"));
        assert!(REMINDER_PRIVACY_URLS
            .iter()
            .any(|url| url.contains("Privacy_Reminders")));
    }

    #[test]
    fn hidden_calendars_are_skipped_and_unnamed_ones_stay() {
        assert!(calendar_is_visible(Some("home"), &[]));
        assert!(!calendar_is_visible(
            Some("work"),
            &["work".into(), "birthdays".into()]
        ));
        assert!(calendar_is_visible(None, &["work".into()]));
    }

    #[test]
    fn dismissed_occurrences_last_until_they_end() {
        let mut list = Vec::new();
        dismiss_occurrence(&mut list, "standup".into(), 1_000, 100);
        dismiss_occurrence(&mut list, "standup".into(), 1_000, 200);
        dismiss_occurrence(&mut list, "later".into(), 50, 100);
        assert_eq!(
            list,
            vec![DismissedOccurrence {
                id: "standup".into(),
                end_at: 1_000,
            }]
        );
        prune_dismissed(&mut list, 1_000);
        assert!(list.is_empty());
    }

    #[test]
    fn invitation_answers_map_to_marker_styles() {
        assert_eq!(response_for(0, false), Response::Confirmed);
        assert_eq!(response_for(2, true), Response::Accepted);
        assert_eq!(response_for(3, true), Response::Declined);
        assert_eq!(response_for(4, true), Response::Tentative);
        assert_eq!(response_for(1, true), Response::Pending);
        assert_eq!(response_for(0, true), Response::Pending);
        assert_eq!(response_for(5, true), Response::Declined);
        assert_eq!(response_for(6, true), Response::Accepted);
    }

    #[test]
    fn a_bare_zoom_url_in_notes_is_enough() {
        assert_eq!(
            extract_join_url(
                None,
                None,
                Some("Join Zoom Meeting\nhttps://acme.zoom.us/j/123")
            ),
            Some("https://acme.zoom.us/j/123".into())
        );
    }

    #[test]
    fn html_notes_still_yield_a_zoom_join_link() {
        let notes = concat!(
            "<html><body>Join Zoom Meeting<br>",
            "<a href=\"https://us02web.zoom.us/j/8301234567?pwd=AbCd\">",
            "https://us02web.zoom.us/j/8301234567?pwd=AbCd</a>",
            "</body></html>",
        );
        assert_eq!(
            extract_join_url(None, Some("Zoom"), Some(notes)),
            Some("https://us02web.zoom.us/j/8301234567?pwd=AbCd".into())
        );
    }

    #[test]
    fn a_quoted_url_still_counts() {
        assert_eq!(
            extract_join_url(None, None, Some("dial in: \"https://zoom.us/j/99\" thanks")),
            Some("https://zoom.us/j/99".into())
        );
    }

    #[test]
    fn a_meeting_link_wins_over_a_generic_event_url() {
        assert_eq!(
            extract_join_url(
                Some("https://calendar.google.com/calendar/event?eid=abc"),
                None,
                Some("Join: https://meet.google.com/abc-defg-hij"),
            ),
            Some("https://meet.google.com/abc-defg-hij".into())
        );
    }

    #[test]
    fn google_redirects_unwrap_to_the_zoom_link() {
        assert_eq!(
            extract_join_url(
                None,
                None,
                Some("https://www.google.com/url?q=https://zoom.us/j/123%3Fpwd%3Dsecret&sa=D"),
            ),
            Some("https://zoom.us/j/123?pwd=secret".into())
        );
    }

    #[test]
    fn zoommtg_links_become_https_join_urls() {
        assert_eq!(
            extract_join_url(
                Some("zoommtg://zoom.us/join?confno=123456789&pwd=abc"),
                None,
                None,
            ),
            Some("https://zoom.us/j/123456789?pwd=abc".into())
        );
    }

    #[test]
    fn zoom_com_hosts_count_as_zoom() {
        assert_eq!(
            extract_join_url(None, Some("https://company.zoom.com/j/55"), None),
            Some("https://company.zoom.com/j/55".into())
        );
    }

    #[test]
    fn a_link_on_an_unknown_host_is_not_joinable() {
        assert_eq!(
            extract_join_url(None, None, Some("Agenda: https://evil.example/login")),
            None
        );
    }

    #[test]
    fn a_meeting_host_over_plain_http_is_not_joinable() {
        assert_eq!(
            extract_join_url(None, None, Some("http://zoom.us/j/99")),
            None
        );
    }

    #[test]
    fn dismissals_are_capped_and_survive_a_restart() {
        use super::{dismiss_occurrence, load_dismissed, save_dismissed, MAX_DISMISSED};
        let now = 1_000;
        let mut list = Vec::new();
        for index in 0..MAX_DISMISSED + 5 {
            dismiss_occurrence(&mut list, format!("event-{index}"), 5_000, now);
        }
        assert_eq!(list.len(), MAX_DISMISSED);
        // The oldest go first.
        assert_eq!(list[0].id, "event-5");
        dismiss_occurrence(&mut list, "x".repeat(600), 5_000, now);
        assert!(list.iter().all(|item| item.id.len() < 600));

        let dir = std::env::temp_dir().join(format!("glance-dismissed-{}", std::process::id()));
        let path = dir.join("dismissed.json");
        save_dismissed(&path, &list).expect("the list is written");
        assert_eq!(load_dismissed(&path, now), list);
        // Once their meetings end, they are gone on the next load.
        assert!(load_dismissed(&path, 6_000).is_empty());
        std::fs::write(&path, "not json").unwrap();
        assert!(load_dismissed(&path, now).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// meetings.ts names the service of every link this side lets Join open;
    /// both read the same list of links.
    #[test]
    fn join_links_match_the_shared_fixture() {
        let links: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/meeting-links.json"))
                .expect("fixture is JSON");
        for link in links {
            let url = link["url"].as_str().expect("url");
            let joinable = link["joinable"].as_bool().expect("joinable");
            assert_eq!(super::is_meeting_url(url), joinable, "{url}");
        }
    }

    #[test]
    fn join_links_are_parsed_rather_than_split() {
        use super::is_meeting_url;
        for good in [
            "https://meet.google.com/abc-defg-hij",
            "https://zoom.us/j/123?pwd=x",
            "https://us02web.zoom.us/j/123",
            "https://acme.zoom.us/my/room",
            "https://company.zoom.com/j/55",
            "https://teams.microsoft.com/l/meetup-join/19%3a",
            "https://acme.webex.com/meet/someone",
            "https://meet.jit.si/SomeRoom",
            "https://global.gotomeeting.com/join/123",
            "https://meet.goto.com/123",
            "https://facetime.apple.com/join#v=1",
            "https://MEET.GOOGLE.COM./abc-defg-hij",
            "https://meet.google.com/abc-defg-hij?authuser=1",
            "https://meet.google.com/lookup/team-standup",
            "https://teams.microsoft.com/meet/9876543210?p=abc",
            "https://teams.live.com/meet/9876543210",
        ] {
            assert!(is_meeting_url(good), "{good} should be joinable");
        }
        for bad in [
            "https://meet.google.com/",
            "https://meet.google.com/landing",
            "https://meet.google.com/abc-defg-hi",
            "https://teams.microsoft.com/",
            "https://teams.microsoft.com/downloads",
            "https://teams.live.com/",
            "https://zoom.us/pricing",
            "https://community.zoom.com/j/1",
            "https://support.zoom.us/j/1",
            "https://www.webex.com/pricing",
            "https://jitsi.org/download",
            "https://www.goto.com/meeting",
            "https://zoom.us@evil.example/j/1",
            "https://user:pass@zoom.us/j/1",
            "https://zoom.us:8443/j/1",
            "https://evil.example/zoom.us/j/1",
            "https://notzoom.us/j/1",
            "https://zoom.us.evil.example/j/1",
            "https://127.0.0.1/j/1",
            "javascript:alert(1)",
        ] {
            assert!(!is_meeting_url(bad), "{bad} should not be joinable");
        }
    }

    #[test]
    fn maps_url_keeps_the_place_inside_the_query() {
        assert_eq!(
            super::maps_url("Room 4, 1 Infinite Loop").unwrap(),
            "https://maps.apple.com/?q=Room+4%2C+1+Infinite+Loop"
        );
        assert!(super::maps_url("x&y=https://evil.example")
            .unwrap()
            .starts_with("https://maps.apple.com/?q=x%26y%3D"));
        assert!(super::maps_url("  ").is_err());
    }

    #[test]
    fn open_meeting_refuses_anything_but_a_meeting_link() {
        assert!(super::open_meeting("https://evil.example/zoom.us").is_err());
        assert!(super::open_meeting("http://zoom.us/j/1").is_err());
        assert!(super::open_meeting("file:///etc/passwd").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[allow(deprecated)]
    fn eventkit_status_values_match_the_access_table() {
        use objc2_event_kit::EKAuthorizationStatus;
        assert_eq!(EKAuthorizationStatus::NotDetermined.0, 0);
        assert_eq!(EKAuthorizationStatus::Restricted.0, 1);
        assert_eq!(EKAuthorizationStatus::Denied.0, 2);
        assert_eq!(EKAuthorizationStatus::FullAccess.0, 3);
        assert_eq!(EKAuthorizationStatus::Authorized.0, 3);
        assert_eq!(EKAuthorizationStatus::WriteOnly.0, 4);
    }
}
