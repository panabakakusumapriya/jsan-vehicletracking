/**
 * Country name / ISO-3166-1 alpha-2 code → IANA timezone, for report day-boundaries.
 *
 * Coarse by design: a country is not a timezone (Australia alone spans five), so this is an
 * approximation used only where no more precise signal exists. The driver's own device-reported
 * `timezone` (see auth.controller.js `updateTimezone`) is the accurate source when present;
 * this map exists because the Reports tab's day view is keyed on driver + calendar date, and
 * `User.country` is the one location field guaranteed to be set by whoever created the driver.
 * Countries actually present in this fleet's data get a deliberate pick (Australia → Sydney,
 * its most populous zone, already the example zone used in report.controller.js's custody
 * endpoint) rather than an arbitrary one.
 *
 * `User.country` has historically been stored as either a full name ("Australia") or an ISO
 * alpha-2 code ("AU") depending on which seed script wrote it — both forms are aliased to the
 * same zone so neither reads as unmapped.
 */
const ZONES = {
  // Europe
  AT: 'Europe/Vienna', AUSTRIA: 'Europe/Vienna',
  DE: 'Europe/Berlin', GERMANY: 'Europe/Berlin',
  FI: 'Europe/Helsinki', FINLAND: 'Europe/Helsinki',
  FR: 'Europe/Paris', FRANCE: 'Europe/Paris',
  IT: 'Europe/Rome', ITALY: 'Europe/Rome',
  SE: 'Europe/Stockholm', SWEDEN: 'Europe/Stockholm',
  ES: 'Europe/Madrid', SPAIN: 'Europe/Madrid',
  NL: 'Europe/Amsterdam', NETHERLANDS: 'Europe/Amsterdam',
  IE: 'Europe/Dublin', IRELAND: 'Europe/Dublin',
  PL: 'Europe/Warsaw', POLAND: 'Europe/Warsaw',
  GB: 'Europe/London', UK: 'Europe/London', 'UNITED KINGDOM': 'Europe/London',

  // Oceania
  AU: 'Australia/Sydney', AUSTRALIA: 'Australia/Sydney',
  NZ: 'Pacific/Auckland', 'NEW ZEALAND': 'Pacific/Auckland',

  // Asia / Middle East
  SG: 'Asia/Singapore', SINGAPORE: 'Asia/Singapore',
  IN: 'Asia/Kolkata', INDIA: 'Asia/Kolkata',
  AE: 'Asia/Dubai', UAE: 'Asia/Dubai', 'UNITED ARAB EMIRATES': 'Asia/Dubai',
  QA: 'Asia/Qatar', QATAR: 'Asia/Qatar',
  SA: 'Asia/Riyadh', 'SAUDI ARABIA': 'Asia/Riyadh',
  OM: 'Asia/Muscat', OMAN: 'Asia/Muscat',
  BH: 'Asia/Bahrain', BAHRAIN: 'Asia/Bahrain',
  KW: 'Asia/Kuwait', KUWAIT: 'Asia/Kuwait',
  MY: 'Asia/Kuala_Lumpur', MALAYSIA: 'Asia/Kuala_Lumpur',
  PH: 'Asia/Manila', PHILIPPINES: 'Asia/Manila',
  ID: 'Asia/Jakarta', INDONESIA: 'Asia/Jakarta',
  JP: 'Asia/Tokyo', JAPAN: 'Asia/Tokyo',
  CN: 'Asia/Shanghai', CHINA: 'Asia/Shanghai',

  // Americas
  US: 'America/New_York', USA: 'America/New_York', 'UNITED STATES': 'America/New_York',
  CA: 'America/Toronto', CANADA: 'America/Toronto',

  // Africa
  ZA: 'Africa/Johannesburg', 'SOUTH AFRICA': 'Africa/Johannesburg',
  EG: 'Africa/Cairo', EGYPT: 'Africa/Cairo',
};

const DEFAULT_TIMEZONE = 'UTC';

/** country (name or ISO alpha-2, any case) → IANA zone. Unmapped/blank falls back to UTC. */
function timezoneForCountry(country) {
  if (!country) return DEFAULT_TIMEZONE;
  return ZONES[String(country).trim().toUpperCase()] || DEFAULT_TIMEZONE;
}

module.exports = { timezoneForCountry, DEFAULT_TIMEZONE, ZONES };
