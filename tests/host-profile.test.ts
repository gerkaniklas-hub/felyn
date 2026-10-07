import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  HOST_BIO_MAX,
  HOST_DISPLAY_NAME_MAX,
  HOST_LANGUAGES,
  HOST_LOCATION_MAX,
  validateHostProfile,
} from "@/lib/provider/profile";
import {
  experienceImagePathFromPublicUrl,
  hostProfilePhotoPath,
  isHostProfilePhotoPath,
} from "@/lib/storage/experience-images";

// Static checks of 0030_host_profile_editing.sql, its isolated test, and the host
// profile code (the SQL itself is not run by `npm test`).
const root = path.resolve(import.meta.dirname, "..");
const migrations = path.join(root, "supabase", "migrations");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = readFileSync(path.join(migrations, "0030_host_profile_editing.sql"), "utf8");
const isolatedTest = readFileSync(path.join(migrations, "host_profile_editing_isolated_test.sql"), "utf8");

/** Lines strictly between the first line containing `start` and the next containing `end`, trimmed, blank lines dropped. */
function section(sql: string, start: string, end: string): string[] {
  const lines = sql.split(/\r?\n/);
  const from = lines.findIndex((line) => line.includes(start));
  const to = lines.findIndex((line, i) => i > from && line.includes(end));
  assert.ok(from >= 0 && to > from, `markers "${start}" / "${end}" not found`);
  return lines
    .slice(from + 1, to)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("v_stage :="));
}

const PROVIDER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-2222-4333-8444-555555555555";

test("the isolated test runs section 2 of 0030 verbatim", () => {
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const copy = section(isolatedTest, "═════════ 1. 0030 BODY", "═════════ 2. SETUP ═════════");
  assert.ok(body.length > 20);
  assert.deepEqual(copy, body);
});

test("0030 lets hosts update only four columns of their own, approved row", () => {
  assert.match(
    migration,
    /grant update \(display_name, bio, base_location, profile_photo_url\) on public\.providers to authenticated;/,
  );
  assert.doesNotMatch(migration, /grant update on public\.providers/, "never a table-level UPDATE");
  assert.doesNotMatch(migration, /grant (insert|delete|all)[^;]*public\.providers/i);
  assert.match(
    migration,
    /for update to authenticated\s+using \(auth\.uid\(\) = user_id and verification_status = 'verified'\)\s+with check \(auth\.uid\(\) = user_id and verification_status = 'verified'\)/,
  );
  // The photo can only point into the host's own profile folder of the public bucket.
  assert.match(migration, /experience-images\/'\s*\|\| new\.id::text \|\| '\/profile\//);
  // Nothing else is touched: no service role, no other table's policies.
  assert.doesNotMatch(migration, /service_role/);
  assert.doesNotMatch(migration, /create policy[^;]*on public\.(?!providers)/);
});

test("0030's length limits match the app's", () => {
  assert.match(migration, new RegExp(`char_length\\(btrim\\(display_name\\)\\) between 1 and ${HOST_DISPLAY_NAME_MAX}\\)`));
  assert.match(migration, new RegExp(`char_length\\(bio\\) <= ${HOST_BIO_MAX}\\)`));
  assert.match(migration, new RegExp(`char_length\\(base_location\\) <= ${HOST_LOCATION_MAX}\\)`));
});

test("validateHostProfile trims, limits and only adds listed languages", () => {
  const ok = validateHostProfile(
    { displayName: "  Maria  ", bio: "  ", baseLocation: " Tenerife ", languages: ["Spanish", "English", "Spanish"] },
    [],
  );
  assert.deepEqual(ok, {
    ok: true,
    values: { displayName: "Maria", bio: null, baseLocation: "Tenerife", languages: ["Spanish", "English"] },
  });
  const base = { displayName: "Maria", bio: "", baseLocation: "", languages: [] };
  assert.equal(validateHostProfile({ ...base, displayName: "   " }, []).ok, false);
  assert.equal(validateHostProfile({ ...base, displayName: "x".repeat(HOST_DISPLAY_NAME_MAX + 1) }, []).ok, false);
  assert.equal(validateHostProfile({ ...base, displayName: "x".repeat(HOST_DISPLAY_NAME_MAX) }, []).ok, true);
  assert.equal(validateHostProfile({ ...base, bio: "x".repeat(HOST_BIO_MAX + 1) }, []).ok, false);
  assert.equal(validateHostProfile({ ...base, baseLocation: "x".repeat(HOST_LOCATION_MAX + 1) }, []).ok, false);
  assert.equal(validateHostProfile({ ...base, languages: ["Klingon"] }, []).ok, false, "not on the list");
  assert.equal(validateHostProfile({ ...base, languages: ["Klingon"] }, ["Klingon"]).ok, true, "an existing one may stay");
});

test("the language list keeps the spelling already in provider_languages", () => {
  for (const language of ["Spanish", "English", "Italian", "Japanese"]) {
    assert.ok((HOST_LANGUAGES as readonly string[]).includes(language), language);
  }
});

test("profile photos live only in the host's own profile folder", () => {
  const photoPath = hostProfilePhotoPath(PROVIDER_ID, "image/png");
  assert.match(photoPath, new RegExp(`^${PROVIDER_ID}/profile/[A-Za-z0-9-]+\\.png$`));
  assert.equal(isHostProfilePhotoPath(PROVIDER_ID, photoPath), true);
  assert.equal(isHostProfilePhotoPath(OTHER_ID, photoPath), false, "another host's folder");
  assert.equal(isHostProfilePhotoPath(PROVIDER_ID, `${PROVIDER_ID}/some-experience/x.png`), false);
  assert.equal(isHostProfilePhotoPath(PROVIDER_ID, `${PROVIDER_ID}/profile/../x.png`), false);
  assert.equal(isHostProfilePhotoPath(PROVIDER_ID, `${PROVIDER_ID}/profile/a/b.png`), false);
  const url = `https://example.supabase.co/storage/v1/object/public/experience-images/${photoPath}`;
  assert.equal(experienceImagePathFromPublicUrl(url), photoPath);

  // 0022's storage policies (unchanged) are what keep each host inside their own folder.
  const bucket = read("supabase", "migrations", "0022_experience_images_bucket.sql");
  const ownFolder = /p\.user_id = auth\.uid\(\) and p\.id::text = \(storage\.foldername\(name\)\)\[1\]/g;
  assert.ok((bucket.match(ownFolder) ?? []).length >= 4, "insert, update (using + check) and delete are owner-folder only");
  assert.match(bucket, /5242880, array\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
});

test("host profile actions use the host's own session, approved hosts only", () => {
  const actions = read("src", "lib", "provider", "profile-actions.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(actions, /supabase\/admin|SECRET_KEY|service_role|createSupabaseAdminClient/);
  assert.match(actions, /\.eq\("user_id", user\.id\)/, "the provider row comes from the session user");
  assert.match(actions, /verification_status !== "verified"/);
  // Every write is scoped to the caller's own provider id.
  assert.equal((actions.match(/\.from\("providers"\)\s*\.update\(/g) ?? []).length, 3);
  assert.equal((actions.match(/\.update\([^)]*\)\s*\.eq\("id", providerId\)/g) ?? []).length, 3);
  assert.match(actions, /\.delete\(\)\s*\.eq\("provider_id", providerId\)/);
  assert.match(actions, /isHostProfilePhotoPath\(providerId, newPath\)/);
  // A failed save removes the just-uploaded file again.
  assert.match(actions, /if \(error \|\| !updated \|\| updated\.length !== 1\) \{\s*await supabase\.storage\.from\(EXPERIENCE_IMAGES_BUCKET\)\.remove\(\[newPath\]\)/);
});

test("guest profile code is untouched by host profile editing", () => {
  for (const file of ["AvatarEditor.tsx", "ProfileDetailsForm.tsx"]) {
    assert.doesNotMatch(read("src", "components", "profile", file), /provider|experience-images/i, file);
  }
});
