/**
 * Timezone detection via LocationIQ reverse geocoding + country→timezone mapping.
 *
 * Flow:
 *  1. Get GPS coordinates from expo-location
 *  2. Reverse geocode via LocationIQ to get country
 *  3. Map country code to primary IANA timezone
 *  4. Allow manual override via dropdown
 */

const LOCATIONIQ_KEY = 'pk.81814d1a4f682831b30412723b3c4a08';

/** Reverse geocode lat/lon → country + timezone using LocationIQ. */
export async function reverseGeocode(lat: number, lon: number): Promise<{
  timezone: string;
  country: string;
  countryCode: string;
  displayName: string;
} | null> {
  try {
    const res = await fetch(
      `https://us1.locationiq.com/v1/reverse?key=${LOCATIONIQ_KEY}&lat=${lat}&lon=${lon}&format=json`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const countryCode = (data.address?.country_code ?? '').toUpperCase();
    const country = data.address?.country ?? '';
    const timezone = countryCodeToTimezone(countryCode) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      timezone,
      country,
      countryCode,
      displayName: data.display_name ?? '',
    };
  } catch {
    return null;
  }
}

/** Map ISO 3166-1 alpha-2 country code to the primary IANA timezone. */
function countryCodeToTimezone(code: string): string | null {
  const map: Record<string, string> = {
    // Asia
    IN: 'Asia/Kolkata',
    PK: 'Asia/Karachi',
    BD: 'Asia/Dhaka',
    LK: 'Asia/Colombo',
    NP: 'Asia/Kathmandu',
    MM: 'Asia/Yangon',
    TH: 'Asia/Bangkok',
    VN: 'Asia/Ho_Chi_Minh',
    MY: 'Asia/Kuala_Lumpur',
    SG: 'Asia/Singapore',
    ID: 'Asia/Jakarta',
    PH: 'Asia/Manila',
    CN: 'Asia/Shanghai',
    JP: 'Asia/Tokyo',
    KR: 'Asia/Seoul',
    TW: 'Asia/Taipei',
    HK: 'Asia/Hong_Kong',
    AE: 'Asia/Dubai',
    SA: 'Asia/Riyadh',
    QA: 'Asia/Qatar',
    KW: 'Asia/Kuwait',
    BH: 'Asia/Bahrain',
    OM: 'Asia/Muscat',
    IQ: 'Asia/Baghdad',
    IR: 'Asia/Tehran',
    IL: 'Asia/Jerusalem',
    JO: 'Asia/Amman',
    LB: 'Asia/Beirut',
    TR: 'Europe/Istanbul',
    GE: 'Asia/Tbilisi',
    AM: 'Asia/Yerevan',
    AZ: 'Asia/Baku',
    KZ: 'Asia/Almaty',
    UZ: 'Asia/Tashkent',
    AF: 'Asia/Kabul',

    // Europe
    GB: 'Europe/London',
    IE: 'Europe/Dublin',
    FR: 'Europe/Paris',
    DE: 'Europe/Berlin',
    IT: 'Europe/Rome',
    ES: 'Europe/Madrid',
    PT: 'Europe/Lisbon',
    NL: 'Europe/Amsterdam',
    BE: 'Europe/Brussels',
    CH: 'Europe/Zurich',
    AT: 'Europe/Vienna',
    PL: 'Europe/Warsaw',
    CZ: 'Europe/Prague',
    SK: 'Europe/Bratislava',
    HU: 'Europe/Budapest',
    RO: 'Europe/Bucharest',
    BG: 'Europe/Sofia',
    GR: 'Europe/Athens',
    SE: 'Europe/Stockholm',
    NO: 'Europe/Oslo',
    DK: 'Europe/Copenhagen',
    FI: 'Europe/Helsinki',
    RU: 'Europe/Moscow',
    UA: 'Europe/Kyiv',
    HR: 'Europe/Zagreb',
    RS: 'Europe/Belgrade',

    // Americas
    US: 'America/New_York',
    CA: 'America/Toronto',
    MX: 'America/Mexico_City',
    BR: 'America/Sao_Paulo',
    AR: 'America/Argentina/Buenos_Aires',
    CL: 'America/Santiago',
    CO: 'America/Bogota',
    PE: 'America/Lima',
    VE: 'America/Caracas',
    EC: 'America/Guayaquil',
    BO: 'America/La_Paz',
    PY: 'America/Asuncion',
    UY: 'America/Montevideo',
    CR: 'America/Costa_Rica',
    PA: 'America/Panama',
    JM: 'America/Jamaica',
    TT: 'America/Port_of_Spain',

    // Africa
    ZA: 'Africa/Johannesburg',
    NG: 'Africa/Lagos',
    KE: 'Africa/Nairobi',
    EG: 'Africa/Cairo',
    GH: 'Africa/Accra',
    ET: 'Africa/Addis_Ababa',
    TZ: 'Africa/Dar_es_Salaam',
    MA: 'Africa/Casablanca',
    DZ: 'Africa/Algiers',
    TN: 'Africa/Tunis',

    // Oceania
    AU: 'Australia/Sydney',
    NZ: 'Pacific/Auckland',
    FJ: 'Pacific/Fiji',
  };
  return map[code] ?? null;
}

/** All timezones available for the manual dropdown, grouped by region. */
export const TIMEZONE_OPTIONS: { label: string; value: string }[] = [
  // Asia
  { label: 'India (IST, UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'Pakistan (PKT, UTC+5)', value: 'Asia/Karachi' },
  { label: 'Bangladesh (BST, UTC+6)', value: 'Asia/Dhaka' },
  { label: 'Sri Lanka (IST, UTC+5:30)', value: 'Asia/Colombo' },
  { label: 'Nepal (NPT, UTC+5:45)', value: 'Asia/Kathmandu' },
  { label: 'Thailand (ICT, UTC+7)', value: 'Asia/Bangkok' },
  { label: 'Singapore (SGT, UTC+8)', value: 'Asia/Singapore' },
  { label: 'Malaysia (MYT, UTC+8)', value: 'Asia/Kuala_Lumpur' },
  { label: 'Indonesia - Jakarta (WIB, UTC+7)', value: 'Asia/Jakarta' },
  { label: 'Philippines (PHT, UTC+8)', value: 'Asia/Manila' },
  { label: 'China (CST, UTC+8)', value: 'Asia/Shanghai' },
  { label: 'Japan (JST, UTC+9)', value: 'Asia/Tokyo' },
  { label: 'South Korea (KST, UTC+9)', value: 'Asia/Seoul' },
  { label: 'UAE - Dubai (GST, UTC+4)', value: 'Asia/Dubai' },
  { label: 'Saudi Arabia (AST, UTC+3)', value: 'Asia/Riyadh' },
  { label: 'Iran (IRST, UTC+3:30)', value: 'Asia/Tehran' },
  { label: 'Turkey (TRT, UTC+3)', value: 'Europe/Istanbul' },

  // Europe
  { label: 'UK (GMT/BST)', value: 'Europe/London' },
  { label: 'France (CET/CEST)', value: 'Europe/Paris' },
  { label: 'Germany (CET/CEST)', value: 'Europe/Berlin' },
  { label: 'Italy (CET/CEST)', value: 'Europe/Rome' },
  { label: 'Spain (CET/CEST)', value: 'Europe/Madrid' },
  { label: 'Russia - Moscow (MSK, UTC+3)', value: 'Europe/Moscow' },

  // Americas
  { label: 'US - Eastern (EST/EDT)', value: 'America/New_York' },
  { label: 'US - Central (CST/CDT)', value: 'America/Chicago' },
  { label: 'US - Mountain (MST/MDT)', value: 'America/Denver' },
  { label: 'US - Pacific (PST/PDT)', value: 'America/Los_Angeles' },
  { label: 'Canada - Toronto (EST/EDT)', value: 'America/Toronto' },
  { label: 'Mexico City (CST)', value: 'America/Mexico_City' },
  { label: 'Brazil - Sao Paulo (BRT)', value: 'America/Sao_Paulo' },
  { label: 'Argentina (ART)', value: 'America/Argentina/Buenos_Aires' },
  { label: 'Colombia (COT)', value: 'America/Bogota' },

  // Africa
  { label: 'South Africa (SAST, UTC+2)', value: 'Africa/Johannesburg' },
  { label: 'Nigeria (WAT, UTC+1)', value: 'Africa/Lagos' },
  { label: 'Kenya (EAT, UTC+3)', value: 'Africa/Nairobi' },
  { label: 'Egypt (EET, UTC+2)', value: 'Africa/Cairo' },

  // Oceania
  { label: 'Australia - Sydney (AEST/AEDT)', value: 'Australia/Sydney' },
  { label: 'New Zealand (NZST/NZDT)', value: 'Pacific/Auckland' },
];
