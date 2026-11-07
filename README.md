# <img src="icons/icon.png" alt="" width="48" height="48" align="absmiddle"> Glance

A month calendar in the macOS menu bar. No account, no main window, and
nothing leaves this Mac.

Apple Silicon Macs on macOS 13 or newer. Intel Macs can build it from source.

<p align="center">
  <img src="docs/screenshots/menubar.png" alt="The month calendar open under its menu bar icon, with the selected day's events" width="300">
  &nbsp;&nbsp;
  <img src="docs/screenshots/settings.png" alt="Settings → Appearance, laid out like System Settings: four menu bar styles, each named, and the theme" width="560">
</p>

## Features

- **This month, next to the clock.** Click the date for the month, with a dot
  under every day that has events. Pick a day to see its events, open one in
  Calendar, or join a meeting from it. Today's finished meetings fold into an
  “N earlier” line, and declined ones are struck through. Optionally, the list
  runs on into the coming days, so tomorrow's first meeting is in view too.
- **Add an event in your own words.** Press **⌘N** or the + in the popover's
  footer and type “Lunch with Sam tomorrow 1pm at Blue Tokai”. Glance shows
  what it understood as you type, then adds it to the calendar you chose, with
  Undo right after. “for 30m” sets the length, “on zoom” attaches your own
  meeting link, and a date with no time is all day. Add an email address, or
  ask for a Meet without a link of your own, and Glance hands the event to
  Google Calendar in your browser, which sends the invitations and makes the
  Meet link.
- **Find any event.** **⌘F** or the search icon looks through your events by
  title and place, upcoming first. Return opens the first result's day.
- **Feels like part of macOS.** The popover opens and closes like a system
  menu, in the system font and colors, and follows light and dark. Today and
  the day you pick take red, your accent, or any of the system colors.
  Settings is laid out like System Settings, with SF Symbols.
- **Your language and region.** Dates and the 12- or 24-hour clock follow
  System Settings → Language & Region. A new install also starts the week on
  your region's first day, and week numbers count the ISO way or the US way.
- **What’s next.** Optionally, the menu bar item counts down to the next
  calendar event or scheduled reminder after the date, as in “• in 25m”. A
  meeting about to start takes over from a long block still running, and the
  day’s list marks the same meeting. Done with one early? Stop its countdown
  from the list.
- **A second time zone.** Pick a city in Settings → Calendar, and each event in
  the day list also shows its start there. Optionally, the menu bar shows that
  city's time too, as in “• NY 11:17 AM”.
- **Never late to a call.** A minute before a meeting with a link starts, a
  small card under the menu bar item offers Join, without taking focus.
  Snooze it for five minutes, skip the meeting, or press Escape to put it
  away. In-person meetings can get a card too, earlier, with the place and a
  button that opens it in Maps.
- **Your calendars, your lists.** Settings → Events chooses the look-ahead,
  which events qualify and when the countdown appears; Settings → Calendar
  chooses which calendars and reminder lists Glance reads at all.
- **Keyboard and VoiceOver.** The month, search, quick add, Settings and the
  reminder card work from the keyboard. VoiceOver reads the menu bar item as
  the full date and your next meeting, and Glance follows Increase Contrast.
- **Stays on this Mac.** Calendar and Reminders are read locally, and quick
  add reads dates with macOS’s own detector. Nothing is uploaded: the only
  thing that goes out is an event you choose to hand to Google Calendar, and
  Join only ever opens a link to a known meeting service.

The popover's footer holds new event, search and settings; point at one to see
its shortcut. **⌘N** adds an event, **⌘F** searches, and **⌘,** opens
Settings. Right-click the menu bar item for Settings and Quit. **⌃⌘K** shows or
hides the calendar from any app, and Settings → General can record a chord for
joining the next meeting. macOS may ask for Accessibility the first time a
system-wide shortcut fires.

## Screenshots

<p align="center">
  <img src="docs/screenshots/countdown.png" alt="The menu bar item counting down to the next meeting: “• in 6m” after the calendar icon" width="110">
</p>

<p align="center">
  <img src="docs/screenshots/events.png" alt="Settings → Events: the menu bar countdown, which events it counts, and the meeting reminder" width="420">
  &nbsp;
  <img src="docs/screenshots/about.png" alt="Settings → About: the app icon, name and version, Check for Updates with when it last checked, and links" width="420">
</p>

## Install

Download the disk image from
[Releases](https://github.com/zshanansari/glance/releases/latest) and drag
Glance to Applications.

Releases are not notarized yet, so the first launch needs a right-click on
Glance in Applications, then **Open**. After that it opens normally.

Installed copies can update themselves from Settings → About, which also says
when Glance last checked and what’s new in a waiting release. Automatic
updates are on by default; switched off, Glance still checks and puts a dot on
its menu bar icon when a release is ready. Checking by hand always asks before
it installs.

To build from source:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dmg
```

Then open the disk image in `src-tauri/target/release/bundle/dmg` and drag
Glance to Applications. See [Building](docs/building.md) for the toolchain
and [Releasing](docs/release.md) to ship.

## Credits

Glance began as a fork of [Calendo](https://github.com/vipinsight/calendo) by
Vipin Yadav.

## License

MIT. See [LICENSE](LICENSE).
