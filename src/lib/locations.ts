/**
 * Helpers for Felyn's canonical locations. The catalogue itself lives in the
 * database (public.locations, migration 0024): a small hierarchy (island ->
 * towns) maintained by Felyn. Explore loads the rows server-side
 * (getCanonicalLocations, lib/matching/explore.ts) and passes them to these
 * helpers; nothing here holds a list of places. No geocoding.
 *
 * MVP bridge: experiences don't have a location of their own yet
 * (experiences.location_id exists but is not populated). Hosts describe
 * where they work as free text (providers.base_location and
 * service_locations.location_text, often several towns in one string, e.g.
 * "South Tenerife (Costa Adeje, Los Cristianos, Playa de las Américas)").
 * So an experience matches a selected location when its host's location
 * text names that place or any place beneath it (see matchesLocation).
 */
export type Location = {
  id: string;
  name: string;
  /** null for top-level places (islands). */
  parentId: string | null;
  region: string | null;
  country: string;
  /** Other common names that should find the same place. */
  aliases: string[];
};

/** Lowercase and strip accents, so "americas" matches "Américas" and "guimar" matches "Güímar". */
export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function getLocation(locations: Location[], id: string): Location | undefined {
  return locations.find((location) => location.id === id);
}

/** The line under a suggestion: parents, then region and country, e.g. "Tenerife, Canary Islands, Spain". */
export function getLocationContext(locations: Location[], location: Location): string {
  const parents: string[] = [];
  const seen = new Set([location.id]);
  let current = location.parentId ? getLocation(locations, location.parentId) : undefined;
  while (current && !seen.has(current.id)) {
    parents.push(current.name);
    seen.add(current.id);
    current = current.parentId ? getLocation(locations, current.parentId) : undefined;
  }
  return [...parents, location.region, location.country].filter(Boolean).join(", ");
}

/** The location itself and every place beneath it (via parentId). */
function withDescendants(locations: Location[], id: string): Location[] {
  const result: Location[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const nextId = queue.shift()!;
    const next = seen.has(nextId) ? undefined : getLocation(locations, nextId);
    if (!next) continue;
    seen.add(next.id);
    result.push(next);
    for (const child of locations) if (child.parentId === next.id) queue.push(child.id);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether any of a host's location texts names the selected place or a
 * place beneath it (so "Tenerife" also finds hosts who only list
 * "Puerto de la Cruz"). Whole words only, case- and accent-insensitive.
 */
export function matchesLocation(
  locations: Location[],
  placeTexts: (string | null | undefined)[],
  locationId: string,
): boolean {
  const patterns = withDescendants(locations, locationId)
    .flatMap((location) => [location.name, ...location.aliases])
    .map((term) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizeText(term))}($|[^a-z0-9])`));
  return placeTexts.some((text) => text && patterns.some((pattern) => pattern.test(normalizeText(text))));
}

/**
 * Suggestions for the location field: partial, case- and accent-insensitive
 * matches on name or alias. Ranked: name/alias starts with the query, then
 * a later word starts with it, then any other match (A–Z within each).
 * An empty query lists the top-level places first, then the rest A–Z.
 */
export function searchLocations(locations: Location[], query: string): Location[] {
  const q = normalizeText(query.trim());
  const sorted = [...locations].sort(
    (a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.name.localeCompare(b.name),
  );
  if (!q) return sorted;
  const rank = (location: Location) => {
    const terms = [location.name, ...location.aliases].map(normalizeText);
    if (terms.some((term) => term.startsWith(q))) return 0;
    if (terms.some((term) => term.includes(` ${q}`))) return 1;
    if (terms.some((term) => term.includes(q))) return 2;
    return -1;
  };
  return sorted
    .map((location) => ({ location, rank: rank(location) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.location.name.localeCompare(b.location.name))
    .map((entry) => entry.location);
}

/** The readable full form saved as stays.location_text, e.g. "La Orotava, Tenerife, Canary Islands, Spain". */
export function getLocationDisplayText(locations: Location[], location: Location): string {
  return [location.name, getLocationContext(locations, location)].filter(Boolean).join(", ");
}

/**
 * For editing a stay saved before stays had a canonical location: the one
 * location its free-text `location_text` unambiguously names, or null.
 *
 * Deliberately strict, never a guess. A match needs either the whole text,
 * or its first comma-separated part (so "La Orotava, Tenerife" counts), to
 * equal exactly one location's name, alias or full display text, ignoring
 * case and accents. Anything else ("South Tenerife (Costa Adeje, …)",
 * "near Puerto de la Cruz", a name shared by two places) returns null, and
 * the guest picks the location themselves.
 */
export function findConfidentLocationMatch(locations: Location[], text: string): Location | null {
  const whole = normalizeText(text.trim());
  const firstPart = normalizeText(text.split(",")[0].trim());
  if (!whole) return null;
  const candidates = locations.filter((location) => {
    const forms = [location.name, ...location.aliases, getLocationDisplayText(locations, location)].map(normalizeText);
    return forms.includes(whole) || forms.includes(firstPart);
  });
  return candidates.length === 1 ? candidates[0] : null;
}
