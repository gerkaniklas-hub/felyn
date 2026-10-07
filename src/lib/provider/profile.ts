/**
 * Host public-profile editing: the limits (mirroring 0030's CHECK constraints) and
 * the supported language names. Plain module — shared by the server actions
 * (the real validation) and the editor (instant feedback).
 */
export const HOST_DISPLAY_NAME_MAX = 80;
export const HOST_BIO_MAX = 1000;
export const HOST_LOCATION_MAX = 120;

/**
 * The languages a host can add, as English names — the same spelling already used in
 * provider_languages (e.g. "Spanish", "English"). A controlled list keeps values
 * consistent; a language a host already has that isn't listed here is kept and can
 * still be removed.
 */
export const HOST_LANGUAGES = [
  "Arabic",
  "Basque",
  "Catalan",
  "Chinese",
  "Croatian",
  "Czech",
  "Danish",
  "Dutch",
  "English",
  "Finnish",
  "French",
  "Galician",
  "German",
  "Greek",
  "Hebrew",
  "Hindi",
  "Hungarian",
  "Italian",
  "Japanese",
  "Korean",
  "Norwegian",
  "Polish",
  "Portuguese",
  "Romanian",
  "Russian",
  "Spanish",
  "Swedish",
  "Turkish",
  "Ukrainian",
] as const;

export type HostProfileInput = {
  displayName: string;
  bio: string;
  baseLocation: string;
  languages: string[];
};

export type HostProfileValues = {
  displayName: string;
  /** Null when left empty. */
  bio: string | null;
  baseLocation: string | null;
  languages: string[];
};

/**
 * Trims and checks the editable public-profile fields. `currentLanguages` are the
 * host's languages before this save: those may stay even if they're not in
 * HOST_LANGUAGES; anything newly added must be on the list.
 */
export function validateHostProfile(
  input: HostProfileInput,
  currentLanguages: string[],
): { ok: true; values: HostProfileValues } | { ok: false; error: string } {
  const displayName = input.displayName.trim();
  const bio = input.bio.trim();
  const baseLocation = input.baseLocation.trim();

  if (!displayName) return { ok: false, error: "Please enter the name guests see." };
  if (displayName.length > HOST_DISPLAY_NAME_MAX) {
    return { ok: false, error: `Your name can be at most ${HOST_DISPLAY_NAME_MAX} characters.` };
  }
  if (baseLocation.length > HOST_LOCATION_MAX) {
    return { ok: false, error: `Your location can be at most ${HOST_LOCATION_MAX} characters.` };
  }
  if (bio.length > HOST_BIO_MAX) {
    return { ok: false, error: `"About you" can be at most ${HOST_BIO_MAX} characters.` };
  }

  const languages = [...new Set(input.languages.map((language) => language.trim()).filter(Boolean))];
  const allowed = new Set<string>([...HOST_LANGUAGES, ...currentLanguages]);
  const unknown = languages.find((language) => !allowed.has(language));
  if (unknown) return { ok: false, error: `"${unknown}" isn't a language you can add.` };

  return {
    ok: true,
    values: { displayName, bio: bio || null, baseLocation: baseLocation || null, languages },
  };
}
