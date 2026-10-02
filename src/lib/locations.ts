/**
 * Felyn's canonical locations: a small, hand-maintained hierarchy (island ->
 * towns) that guests pick from on Explore. No geocoding and no external API.
 *
 * Transition to the database: supabase/migrations/0024_canonical_locations.sql
 * creates public.locations seeded with exactly this list. Each entry's `id`
 * here is that row's `slug`, so the two match one-to-one. Until 0024 is
 * applied in production, Explore keeps reading this list; once it is, the
 * Explore page should load the rows from public.locations and pass them in,
 * and LOCATIONS below should be deleted (the types and helpers stay). Until
 * then, any change to this list must be made in a new migration as well.
 *
 * MVP bridge: experiences don't have a location of their own yet. Hosts
 * describe where they work as free text (providers.base_location and
 * service_locations.location_text, often several towns in one string, e.g.
 * "South Tenerife (Costa Adeje, Los Cristianos, Playa de las Américas)").
 * So an experience matches a selected location when its host's location
 * text names that place or any place beneath it (see matchesLocation).
 * Once experiences carry a location id, matching can switch to ids and this
 * list can move into the database without changing the Explore UI.
 */
export type Location = {
  id: string;
  name: string;
  /** null for top-level places (islands). */
  parentId: string | null;
  /** Top-level places only; children inherit them. */
  region?: string;
  country?: string;
  /** Other common names that should find the same place. */
  aliases?: string[];
};

export const LOCATIONS: Location[] = [
  { id: "tenerife", name: "Tenerife", parentId: null, region: "Canary Islands", country: "Spain" },
  { id: "santa-cruz-de-tenerife", name: "Santa Cruz de Tenerife", parentId: "tenerife", aliases: ["Santa Cruz"] },
  { id: "la-laguna", name: "San Cristóbal de La Laguna", parentId: "tenerife", aliases: ["La Laguna"] },
  { id: "puerto-de-la-cruz", name: "Puerto de la Cruz", parentId: "tenerife" },
  { id: "la-orotava", name: "La Orotava", parentId: "tenerife" },
  { id: "los-realejos", name: "Los Realejos", parentId: "tenerife" },
  { id: "icod-de-los-vinos", name: "Icod de los Vinos", parentId: "tenerife", aliases: ["Icod"] },
  { id: "garachico", name: "Garachico", parentId: "tenerife" },
  { id: "los-gigantes", name: "Los Gigantes", parentId: "tenerife" },
  { id: "adeje", name: "Adeje", parentId: "tenerife" },
  { id: "costa-adeje", name: "Costa Adeje", parentId: "tenerife" },
  { id: "los-cristianos", name: "Los Cristianos", parentId: "tenerife" },
  { id: "playa-de-las-americas", name: "Playa de las Américas", parentId: "tenerife", aliases: ["Las Américas"] },
  { id: "arona", name: "Arona", parentId: "tenerife" },
  { id: "el-medano", name: "El Médano", parentId: "tenerife" },
  { id: "candelaria", name: "Candelaria", parentId: "tenerife" },
  { id: "guimar", name: "Güímar", parentId: "tenerife" },
];

const byId = new Map(LOCATIONS.map((location) => [location.id, location]));

/** Lowercase and strip accents, so "americas" matches "Américas" and "guimar" matches "Güímar". */
export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function getLocation(id: string): Location | undefined {
  return byId.get(id);
}

/** The line under a suggestion: parents, then region and country, e.g. "Tenerife, Canary Islands, Spain". */
export function getLocationContext(location: Location): string {
  const parts: string[] = [];
  let current: Location | undefined = location;
  let root: Location = location;
  while (current?.parentId) {
    current = byId.get(current.parentId);
    if (current) {
      parts.push(current.name);
      root = current;
    }
  }
  return [...parts, root.region, root.country].filter(Boolean).join(", ");
}

/** The location itself and every place beneath it. */
function withDescendants(id: string): Location[] {
  const result: Location[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const next = byId.get(queue.shift()!);
    if (!next) continue;
    result.push(next);
    for (const child of LOCATIONS) if (child.parentId === next.id) queue.push(child.id);
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
export function matchesLocation(placeTexts: (string | null | undefined)[], locationId: string): boolean {
  const patterns = withDescendants(locationId)
    .flatMap((location) => [location.name, ...(location.aliases ?? [])])
    .map((term) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizeText(term))}($|[^a-z0-9])`));
  return placeTexts.some((text) => text && patterns.some((pattern) => pattern.test(normalizeText(text))));
}

/**
 * Suggestions for the location field: partial, case- and accent-insensitive
 * matches on name or alias. Ranked: name/alias starts with the query, then
 * a later word starts with it, then any other match (A–Z within each).
 * An empty query lists the top-level places first, then the rest A–Z.
 */
export function searchLocations(query: string): Location[] {
  const q = normalizeText(query.trim());
  const sorted = [...LOCATIONS].sort(
    (a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.name.localeCompare(b.name),
  );
  if (!q) return sorted;
  const rank = (location: Location) => {
    const terms = [location.name, ...(location.aliases ?? [])].map(normalizeText);
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
