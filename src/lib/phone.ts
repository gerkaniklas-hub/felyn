import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";
import metadata from "libphonenumber-js/max/metadata";
import mobileExamples from "libphonenumber-js/mobile/examples";

/**
 * Phone numbers: one shared module for the browser (PhoneInput, form checks)
 * and the server (the final check before anything is saved), so both always
 * agree on what is valid.
 *
 * Uses libphonenumber-js's "max" metadata on purpose: the default "min" set
 * only checks a number's LENGTH, while "max" checks its digits against each
 * country's real numbering plan. This is validation (is this a real-looking
 * number for that country?), never ownership verification.
 *
 * Countries and calling codes come from the library; names from the
 * built-in Intl.DisplayNames. Felyn keeps no country dataset of its own.
 */

export type PhoneCountry = {
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  code: CountryCode;
  name: string;
  /** Digits only, e.g. "49". */
  callingCode: string;
};

export type PhoneValidation =
  | { ok: true; e164: string; country: CountryCode }
  | { ok: false; field: "country" | "number"; error: string };

let countries: PhoneCountry[] | null = null;

/** Every country the library knows a calling code for, sorted by English name. */
export function getPhoneCountries(): PhoneCountry[] {
  if (!countries) {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    countries = getCountries()
      .map((code) => ({ code, name: names.of(code) ?? code, callingCode: getCountryCallingCode(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }
  return countries;
}

export function isPhoneCountry(value: string): value is CountryCode {
  return getCountries().includes(value as CountryCode);
}

export function getPhoneCountry(code: string): PhoneCountry | undefined {
  return getPhoneCountries().find((country) => country.code === code);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Country search: "+49" / "49" match calling codes, "de" matches the ISO
 * code, anything else matches the name ("ger", "united", "españa" is not
 * supported: names are English). Best matches first.
 */
export function searchPhoneCountries(list: PhoneCountry[], query: string): PhoneCountry[] {
  const q = normalizeText(query);
  if (!q) return list;

  const digits = q.replace(/^\+/, "").replace(/\s/g, "");
  if (/^\d+$/.test(digits)) {
    // Exact code first, and within a shared code its main country first
    // (+1 -> United States, +44 -> United Kingdom, +7 -> Russia), per the library.
    const rank = (country: PhoneCountry) =>
      country.callingCode !== digits ? 2 : metadata.country_calling_codes[digits]?.[0] === country.code ? 0 : 1;
    return list
      .filter((country) => country.callingCode.startsWith(digits))
      .sort((a, b) => rank(a) - rank(b));
  }

  const ranked: { country: PhoneCountry; rank: number }[] = [];
  for (const country of list) {
    const name = normalizeText(country.name);
    let rank = -1;
    if (q.length === 2 && country.code.toLowerCase() === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.split(/[\s,()-]+/).some((word) => word.startsWith(q))) rank = 2;
    else if (name.includes(q)) rank = 3;
    if (rank >= 0) ranked.push({ country, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.country);
}

/**
 * Checks a country + number pair and returns the canonical E.164 form.
 * The number is normally the national number ("15123456789", "0151 2345 6789"),
 * but a pasted international one ("+49 151…", or "0049 151…" with Germany
 * selected) is accepted too, as long as it belongs to the selected country's
 * calling code.
 */
export function validatePhone(countryInput: string, numberInput: string): PhoneValidation {
  const country = countryInput.trim().toUpperCase();
  const number = numberInput.trim();

  if (!country || !isPhoneCountry(country)) {
    return { ok: false, field: "country", error: "Choose your country." };
  }
  if (!number) {
    return { ok: false, field: "number", error: "Enter your mobile number." };
  }

  const countryName = getPhoneCountry(country)?.name ?? country;
  const invalid: PhoneValidation = {
    ok: false,
    field: "number",
    error: `That doesn't look like a valid phone number for ${countryName}. Please check it and try again.`,
  };
  if (/[a-z]/i.test(number) || number.length > 40) return invalid;

  // The selected country is the default, so its own international dialling
  // prefix (00, 011, …) is understood; a leading "+" overrides it.
  const parsed = parsePhoneNumberFromString(number, country);
  if (!parsed || !parsed.isValid()) return invalid;

  const callingCode = getCountryCallingCode(country);
  if (parsed.countryCallingCode !== callingCode) {
    return {
      ok: false,
      field: "number",
      error: `That number starts with +${parsed.countryCallingCode}, not the +${callingCode} code for ${countryName}. Choose the matching country, or enter the number without the prefix.`,
    };
  }

  return { ok: true, e164: parsed.number, country };
}

/**
 * For a pasted "+…" number: the country it belongs to and its national
 * form, so the input can switch country instead of rejecting it. Null when
 * it isn't a complete, valid international number.
 */
export function detectInternationalPhone(input: string): { country: CountryCode; national: string } | null {
  const value = input.trim();
  if (!value.startsWith("+")) return null;
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed || !parsed.isValid() || !parsed.country) return null;
  return { country: parsed.country, national: parsed.formatNational() };
}

/** "+34612345678" -> "+34 612 34 56 78" (the library's international format for that country). */
export function formatPhoneInternational(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

/** "+4915123456789" -> "01512 3456789": the national form, used to pre-fill PhoneInput. */
export function formatPhoneNational(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatNational() ?? e164;
}

/** An example mobile number in the country's national format, for the input's placeholder. */
export function getPhonePlaceholder(country: string): string | undefined {
  return isPhoneCountry(country) ? getExampleNumber(country, mobileExamples)?.formatNational() : undefined;
}
