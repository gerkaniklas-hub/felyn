import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Static checks of the scheduler setup script (it is never run by tests).
const root = path.resolve(import.meta.dirname, "..");
const migrations = path.join(root, "supabase", "migrations");
const file = path.join(migrations, "email_outbox_sweep_schedule.sql");
const sql = readFileSync(file, "utf8");
/** The executable SQL only: every "--" comment line removed. */
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

test("the scheduler is a separate script, not a numbered migration, and 0028 does not schedule anything", () => {
  assert.ok(!/^\d{4}_/.test(path.basename(file)));
  const numbered = readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name));
  assert.ok(
    !numbered.some((name) => readFileSync(path.join(migrations, name), "utf8").includes("email-outbox-sweep")),
    "no numbered migration schedules the sweep",
  );
  const outbox = readFileSync(path.join(migrations, "0028_email_outbox.sql"), "utf8");
  assert.doesNotMatch(outbox, /cron\.schedule|net\.http_post|vault\./);
});

test("schedules email-outbox-sweep every 5 minutes, replacing an existing job first", () => {
  assert.match(code, /cron\.schedule\('email-outbox-sweep', '\*\/5 \* \* \* \*', v_command\)/);
  const unschedule = code.indexOf("perform cron.unschedule(v_jobid)");
  assert.ok(unschedule > 0 && unschedule < code.indexOf("perform cron.schedule("));
  assert.match(code, /for v_jobid in select jobid from cron\.job where jobname = 'email-outbox-sweep' loop/);
});

test("calls the production sweep route with pg_net and a 60 s timeout", () => {
  assert.match(code, /net\.http_post\(\s*url := 'https:\/\/app\.felyn\.eu\/api\/email\/sweep'/);
  assert.match(code, /timeout_milliseconds := 60000/);
  const route = path.join(root, "src", "app", "api", "email", "sweep", "route.ts");
  assert.ok(existsSync(route), "the sweep route the job calls exists");
  assert.match(readFileSync(route, "utf8"), /export async function POST\(/);
});

test("reads the bearer secret from Vault at run time and contains no secret", () => {
  assert.match(
    code,
    /'Authorization', 'Bearer ' \|\| \(select decrypted_secret from vault\.decrypted_secrets where name = 'email_sweep_secret'\)/,
  );
  // No literal bearer token, no long random-looking literal, no secret creation, no extension changes.
  assert.doesNotMatch(code, /'Bearer [^']/);
  assert.doesNotMatch(code, /'[A-Za-z0-9_-]{32,}'/);
  assert.doesNotMatch(code, /vault\.(create|update)_secret/);
  assert.doesNotMatch(code, /create extension|alter extension|drop extension/i);
  assert.doesNotMatch(code, /EMAIL_SWEEP_SECRET|RESEND_API_KEY|SUPABASE_SECRET_KEY/);
});

test("the Vault value it requires is always accepted by the route (at least 32 characters)", () => {
  const rule = code.match(/decrypted_secret ~ '\^\[A-Za-z0-9_-\]\{(\d+),(\d+)\}\$'/);
  assert.ok(rule, "the script validates the secret's format");
  assert.ok(Number(rule[1]) >= 32);
  const route = readFileSync(path.join(root, "src", "app", "api", "email", "sweep", "route.ts"), "utf8");
  assert.match(route, /secret\.length < 32/);
});

test("is one statement with pre- and postconditions", () => {
  assert.equal(code.match(/^do \$setup\$/gm)?.length, 1);
  assert.match(code, /pg_extension where extname = 'pg_net'/);
  assert.match(code, /to_regclass\('public\.email_outbox'\)/);
  assert.match(code, /position\(s\.decrypted_secret in j\.command\) > 0/);
});
