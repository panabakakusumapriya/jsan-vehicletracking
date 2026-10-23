/**
 * One spelling per country: the full English name.
 *
 * The Drivers form took the country as free text and the VTS importers wrote ISO codes, so the
 * same country was stored as "AU" for some drivers and "Australia" for others (and "FR" / "France",
 * "SE" / "Sweden", "NZ" / "New Zealand", "india"). Every country dropdown then listed it twice and
 * a filter on one spelling silently missed the drivers stored under the other.
 *
 * normalizeCountry() is applied as a Mongoose setter on every model that stores a country, so
 * whatever is typed or imported — a code, a name, any case — is saved as the name below. A value
 * it does not recognise is kept as typed (trimmed), never dropped.
 */
const COUNTRY_NAMES = {
  AU: 'Australia', NZ: 'New Zealand', IN: 'India', FR: 'France', DE: 'Germany', IT: 'Italy',
  SE: 'Sweden', FI: 'Finland', AT: 'Austria', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands',
  BE: 'Belgium', CH: 'Switzerland', DK: 'Denmark', NO: 'Norway', PL: 'Poland', IE: 'Ireland',
  GB: 'United Kingdom', UK: 'United Kingdom', CZ: 'Czechia', HU: 'Hungary', GR: 'Greece',
  RO: 'Romania', US: 'United States', CA: 'Canada', SG: 'Singapore', JP: 'Japan',
};

// Extra spellings seen or likely: three-letter codes and common alternatives.
const ALIASES = {
  AUS: 'Australia', NZL: 'New Zealand', IND: 'India', FRA: 'France', DEU: 'Germany', GER: 'Germany',
  ITA: 'Italy', SWE: 'Sweden', FIN: 'Finland', AUT: 'Austria', ESP: 'Spain', SGP: 'Singapore',
  USA: 'United States', 'UNITED STATES OF AMERICA': 'United States', 'GREAT BRITAIN': 'United Kingdom',
  ENGLAND: 'United Kingdom', 'CZECH REPUBLIC': 'Czechia',
};

const BY_KEY = new Map();
for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
  BY_KEY.set(code, name);
  BY_KEY.set(name.toUpperCase(), name);
}
for (const [alias, name] of Object.entries(ALIASES)) BY_KEY.set(alias, name);

/** The country's one spelling; null for empty; anything unrecognised kept as typed (trimmed). */
function normalizeCountry(value) {
  if (value == null) return value;
  const raw = String(value).trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  return BY_KEY.get(raw.toUpperCase()) || raw;
}

/** Every name a country field can hold once normalised — for pickers. */
const COUNTRY_LIST = [...new Set(Object.values(COUNTRY_NAMES))].sort();

module.exports = { normalizeCountry, COUNTRY_NAMES, COUNTRY_LIST };
