//! Quick add's two host helpers: the dates macOS reads in a line of text,
//! and the Google Calendar page a meeting with guests is handed to.

use serde::{Deserialize, Serialize};

/// A date or time macOS found in the typed text. `start` and `length` count
/// UTF-16 units, as JavaScript strings do, so the webview can cut it out.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedDate {
    pub start: usize,
    pub length: usize,
    /// Milliseconds since 1970.
    pub at: i64,
    /// Seconds, for a range such as "3–4pm"; 0 for a single moment.
    pub duration: f64,
}

/// The longest line quick add reads.
const MAX_TEXT: usize = 500;

/// Dates and times in a line such as "Lunch with Sam tomorrow 1pm", read on
/// this Mac by NSDataDetector: nothing leaves the machine.
pub fn detect_dates(text: &str) -> Vec<DetectedDate> {
    let text: String = text.chars().take(MAX_TEXT).collect();
    if text.trim().is_empty() {
        return Vec::new();
    }
    #[cfg(target_os = "macos")]
    {
        macos::detect(&text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::DetectedDate;
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{
        NSDataDetector, NSMatchingOptions, NSRange, NSString, NSTextCheckingType,
    };

    pub fn detect(text: &str) -> Vec<DetectedDate> {
        autoreleasepool(|_| {
            let Ok(detector) =
                NSDataDetector::dataDetectorWithTypes_error(NSTextCheckingType::Date.0)
            else {
                return Vec::new();
            };
            let string = NSString::from_str(text);
            let range = NSRange::new(0, string.length());
            let matches =
                detector.matchesInString_options_range(&string, NSMatchingOptions::empty(), range);
            let mut found = Vec::new();
            for index in 0..matches.count() {
                let result = matches.objectAtIndex(index);
                let Some(date) = result.date() else { continue };
                let range = result.range();
                found.push(DetectedDate {
                    start: range.location,
                    length: range.length,
                    at: (date.timeIntervalSince1970() * 1000.0).round() as i64,
                    duration: result.duration().max(0.0),
                });
            }
            found
        })
    }
}

/// A meeting with guests, for Google Calendar's own new-event page, where
/// Meet is added and the invitations go out.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDraft {
    pub title: String,
    /// "20261108T073000Z/20261108T083000Z", or "20261108/20261109" all day.
    pub dates: String,
    pub location: Option<String>,
    pub guests: Vec<String>,
}

fn is_google_dates(dates: &str) -> bool {
    let Some((start, end)) = dates.split_once('/') else {
        return false;
    };
    let stamp = |part: &str| {
        let bytes = part.as_bytes();
        match bytes.len() {
            8 => bytes.iter().all(u8::is_ascii_digit),
            16 => {
                bytes[..8].iter().all(u8::is_ascii_digit)
                    && bytes[8] == b'T'
                    && bytes[9..15].iter().all(u8::is_ascii_digit)
                    && bytes[15] == b'Z'
            }
            _ => false,
        }
    };
    stamp(start) && stamp(end) && start.len() == end.len()
}

/// A plain address: something@domain.tld, no spaces or separators.
fn is_email(guest: &str) -> bool {
    let Some((name, domain)) = guest.split_once('@') else {
        return false;
    };
    guest.len() <= 254
        && !name.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && guest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._+-'".contains(c))
        && guest.matches('@').count() == 1
}

/// Google Calendar's new-event page with the draft filled in. The host is
/// fixed and every part goes in as a query value.
pub fn google_event_url(draft: &GoogleDraft) -> Result<String, String> {
    let title: String = draft.title.trim().chars().take(200).collect();
    if title.is_empty() {
        return Err("The event needs a title".into());
    }
    if !is_google_dates(&draft.dates) {
        return Err("The event needs a start and an end".into());
    }
    if draft.guests.len() > 20 || !draft.guests.iter().all(|guest| is_email(guest)) {
        return Err("Guests must be email addresses".into());
    }
    let mut query = vec![
        ("action", "TEMPLATE".to_string()),
        ("text", title),
        ("dates", draft.dates.clone()),
    ];
    if let Some(place) = draft
        .location
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        query.push(("location", place.chars().take(500).collect()));
    }
    if !draft.guests.is_empty() {
        query.push(("add", draft.guests.join(",")));
    }
    url::Url::parse_with_params("https://calendar.google.com/calendar/render", &query)
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{google_event_url, is_email, is_google_dates, GoogleDraft};

    fn draft(guests: &[&str]) -> GoogleDraft {
        GoogleDraft {
            title: "Design sync".into(),
            dates: "20261108T073000Z/20261108T083000Z".into(),
            location: None,
            guests: guests.iter().map(|g| g.to_string()).collect(),
        }
    }

    #[test]
    fn builds_a_google_calendar_page_on_the_fixed_host() {
        let url = google_event_url(&draft(&["sam@example.com", "a.b+c@team.co"])).unwrap();
        assert!(url.starts_with("https://calendar.google.com/calendar/render?action=TEMPLATE"));
        assert!(url.contains("text=Design+sync"));
        assert!(url.contains("dates=20261108T073000Z%2F20261108T083000Z"));
        assert!(url.contains("add=sam%40example.com%2Ca.b%2Bc%40team.co"));
    }

    #[test]
    fn keeps_typed_text_inside_its_query_value() {
        let mut sneaky = draft(&[]);
        sneaky.title = "x&add=evil@example.com".into();
        let url = google_event_url(&sneaky).unwrap();
        assert!(url.contains("text=x%26add%3Devil%40example.com"));
        assert!(!url.contains("&add="));
    }

    #[test]
    fn refuses_bad_dates_and_guests() {
        let mut bad = draft(&[]);
        bad.dates = "tomorrow".into();
        assert!(google_event_url(&bad).is_err());
        assert!(google_event_url(&draft(&["not an email"])).is_err());
        assert!(google_event_url(&draft(&["a@b"])).is_err());
        assert!(is_google_dates("20261108/20261109"));
        assert!(!is_google_dates("20261108/20261109T083000Z"));
        assert!(is_email("sam@example.com"));
        assert!(!is_email("sam@@example.com"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_a_date_from_plain_words() {
        let text = "Lunch with Sam tomorrow at 1pm";
        let found = super::detect_dates(text);
        assert_eq!(found.len(), 1);
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let matched =
            String::from_utf16(&utf16[found[0].start..found[0].start + found[0].length]).unwrap();
        assert!(matched.contains("tomorrow"), "{matched}");
        assert!(super::detect_dates("Buy milk").is_empty());
    }
}
