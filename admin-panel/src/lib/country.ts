/**
 * One spelling per country — the full English name — matching backend/src/utils/country.js.
 *
 * Stored countries are normalised on the server; this keeps old links and saved filters working
 * (a Trips address still saying country=NZ means New Zealand) and gives the Drivers form its list.
 */
const NAMES: Record<string, string> = {
  AU: 'Australia', NZ: 'New Zealand', IN: 'India', FR: 'France', DE: 'Germany', IT: 'Italy',
  SE: 'Sweden', FI: 'Finland', AT: 'Austria', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands',
  BE: 'Belgium', CH: 'Switzerland', DK: 'Denmark', NO: 'Norway', PL: 'Poland', IE: 'Ireland',
  GB: 'United Kingdom', UK: 'United Kingdom', CZ: 'Czechia', HU: 'Hungary', GR: 'Greece',
  RO: 'Romania', US: 'United States', CA: 'Canada', SG: 'Singapore', JP: 'Japan',
  AUS: 'Australia', NZL: 'New Zealand', IND: 'India', USA: 'United States',
};
const BY_KEY = new Map<string, string>();
for (const [k, name] of Object.entries(NAMES)) {
  BY_KEY.set(k, name);
  BY_KEY.set(name.toUpperCase(), name);
}

/** The country's one spelling; '' for empty; anything unrecognised kept as typed. */
export function normalizeCountry(value: string | null | undefined): string {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  return BY_KEY.get(raw.toUpperCase()) ?? raw;
}

/** The names a country can be stored as — for pickers. */
export const COUNTRY_LIST = [...new Set(Object.values(NAMES))].sort();
