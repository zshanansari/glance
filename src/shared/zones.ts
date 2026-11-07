import { dateFormat } from "./region";

/**
 * A second time zone, as an IANA name such as "America/New_York". The
 * Mac's own time zone data handles daylight saving.
 */

/** Whether the system knows a zone name. */
export function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "America/New_York" as people say it: "New York". */
export function zoneCity(zone: string): string {
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

/**
 * A short name for the menu bar: the initials of a city of several words
 * ("NY" for New York), else the city itself when short ("Tokyo"), else its
 * first three letters ("Sin").
 */
export function zoneShort(zone: string): string {
  const city = zoneCity(zone);
  const words = city.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((word) => word[0]?.toUpperCase() ?? "").join("");
  return city.length <= 6 ? city : city.slice(0, 3);
}

/** The time at an instant in that zone, in the Mac's clock style. */
export function zoneTime(at: number, zone: string, locale?: string): string {
  return dateFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(
    new Date(at),
  );
}

/**
 * Zones the system still lists under an old spelling, by today's name:
 * WebKit offers "Asia/Calcutta" where people look for "Asia/Kolkata". Both
 * spellings keep working as a time zone.
 */
const CURRENT_NAMES: Record<string, string> = {
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** Every zone the system knows, by its current name, for the picker. */
export function knownTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let listed: string[];
  try {
    listed = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
  const named = listed.map((zone) => CURRENT_NAMES[zone] ?? zone);
  return [...new Set(named)].filter(isTimeZone).sort();
}
