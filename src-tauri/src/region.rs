//! The Mac's language and region, as System Settings → General → Language &
//! Region sets them: which locale formats dates, whether the clock is 12- or
//! 24-hour, and which day a week starts on.

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemRegion {
    /// A BCP 47 tag for the region's formats, as `en-IN`.
    pub locale: String,
    /// Whether times read 1:30 PM (true) or 13:30 (false), the 24-hour
    /// switch included.
    pub hour12: bool,
    /// The first day of the week, 0 for Sunday through 6 for Saturday.
    pub first_weekday: u8,
    /// The region's two-letter code, as `IN`, when macOS has one.
    pub region: Option<String>,
}

/// Regions that number weeks from the one holding 1 January, weeks starting
/// on Sunday, rather than by ISO 8601.
const US_WEEK_REGIONS: &[&str] = &[
    "US", "CA", "MX", "BR", "JP", "KR", "TW", "HK", "PH", "IL", "SA",
];

/// Whether a new install should number weeks the US way for this region.
pub fn numbers_weeks_like_the_us(region: Option<&str>) -> bool {
    region.is_some_and(|code| US_WEEK_REGIONS.contains(&code))
}

/// `en_IN@rg=inzzzz` as macOS writes it, or `en-IN` as a browser reads it.
pub(crate) fn bcp47(identifier: &str) -> String {
    let base = identifier.split('@').next().unwrap_or(identifier);
    base.replace('_', "-")
}

/// Whether a time format from a locale's `j` skeleton is a 12-hour one.
pub(crate) fn is_twelve_hour(format: &str) -> bool {
    format.contains('a') || format.contains('h') || format.contains('K')
}

#[cfg(target_os = "macos")]
pub fn current() -> SystemRegion {
    use objc2_foundation::{NSCalendar, NSDateFormatter, NSLocale, NSString};

    let locale = NSLocale::autoupdatingCurrentLocale();
    let identifier = locale.localeIdentifier().to_string();
    // The `j` skeleton asks for the hour as the user's preferences set it,
    // so the 24-hour switch in System Settings is honoured.
    let hour12 = NSDateFormatter::dateFormatFromTemplate_options_locale(
        &NSString::from_str("j"),
        0,
        Some(&locale),
    )
    .map(|format| is_twelve_hour(&format.to_string()))
    .unwrap_or(true);
    let first = NSCalendar::autoupdatingCurrentCalendar().firstWeekday();
    // regionCode is macOS 13 and later, which Glance requires.
    let region = locale.regionCode().map(|code| code.to_string());
    SystemRegion {
        locale: bcp47(&identifier),
        hour12,
        first_weekday: (first.clamp(1, 7) - 1) as u8,
        region,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn current() -> SystemRegion {
    SystemRegion {
        locale: "en-US".into(),
        hour12: true,
        first_weekday: 0,
        region: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_locale_as_a_browser_does() {
        assert_eq!(bcp47("en_IN"), "en-IN");
        assert_eq!(bcp47("en_GB@rg=inzzzz"), "en-GB");
        assert_eq!(bcp47("de"), "de");
    }

    #[test]
    fn tells_a_twelve_hour_clock_from_a_twenty_four_hour_one() {
        assert!(is_twelve_hour("h a"));
        assert!(is_twelve_hour("K a"));
        assert!(!is_twelve_hour("HH"));
        assert!(!is_twelve_hour("H"));
    }

    #[test]
    fn numbers_weeks_the_us_way_only_where_that_is_the_custom() {
        assert!(numbers_weeks_like_the_us(Some("US")));
        assert!(!numbers_weeks_like_the_us(Some("IN")));
        assert!(!numbers_weeks_like_the_us(Some("DE")));
        assert!(!numbers_weeks_like_the_us(None));
    }
}
