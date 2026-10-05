import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getContactAgainHref, getSupportConversationHref } from "@/lib/support/inbox";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const ITEM = "11111111-1111-4111-8111-111111111111";

test("routes: guest defaults are unchanged; the host side uses host pages", () => {
  assert.equal(getContactAgainHref(null), "/help");
  assert.equal(getContactAgainHref(ITEM), `/bookings/${ITEM}?help=1`);
  assert.equal(getSupportConversationHref("t"), "/messages?support=t");
  assert.equal(getContactAgainHref(null, "host"), "/provider/help");
  assert.equal(getContactAgainHref(ITEM, "host"), `/provider/requests/${ITEM}?help=1`);
  assert.equal(getSupportConversationHref("t", "host"), "/provider/messages?support=t");
});

test("every host support action verifies an approved host profile first and always uses requester_role 'host'", () => {
  const code = read("src", "lib", "support", "host-actions.ts");
  assert.match(code, /^"use server";/);
  const fns = code.split(/\nexport async function /).slice(1);
  assert.equal(fns.length, 4);
  for (const fn of fns) {
    const name = fn.slice(0, fn.indexOf("("));
    assert.match(fn, /const supabase = await approvedHostClient\(\);\s+if \(!supabase\)/, `${name} must check the host profile first`);
    assert.doesNotMatch(fn, /"guest"/, `${name} must never act as a guest`);
  }
  // The host check is the caller's own providers row, failing closed; never the journey cookie.
  assert.match(code, /from\("providers"\)\.select\("id"\)\.eq\("user_id", user\.id\)\.maybeSingle\(\)/);
  const codeOnly = code
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(codeOnly, /journey|JOURNEY/i);
  assert.match(code, /openSupportConversation\(supabase, "host", input\)/);
  assert.match(code, /loadSupportThread\(supabase, threadId, "host"\)/);
  assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/);
});

test("guest support actions are unchanged in gating and role", () => {
  const code = read("src", "lib", "support", "actions.ts");
  const fns = code.split(/\nexport async function /).slice(1);
  assert.equal(fns.length, 4);
  for (const fn of fns) {
    assert.match(fn, /await assertGuestJourney\(\);/);
    assert.doesNotMatch(fn, /"host"/);
  }
  assert.match(code, /openSupportConversation\(await createSupabaseServerClient\(\), "guest", input\)/);
});

test("the shared core is server-only and not itself a callable Server Action module", () => {
  const core = read("src", "lib", "support", "thread-core.ts");
  assert.match(core, /^import "server-only";/);
  assert.doesNotMatch(core, /"use server"/);
});

test("support reads filter to one side; the guest helpers still mean the guest side", () => {
  const code = read("src", "lib", "support", "queries.ts");
  assert.equal((code.match(/\.eq\("requester_role", role\)/g) ?? []).length, 3);
  assert.doesNotMatch(code, /\.eq\("requester_role", "guest"\)/);
  assert.match(code, /return getSupportConversations\(supabase, "guest"\);/);
  assert.match(code, /return getSupportThread\(supabase, threadId, "guest"\);/);
  assert.match(code, /return getOpenSupportThreadId\(supabase, "guest", bookingItemId\);/);
});

test("host pages: Help next to Log out (6 items kept), host-side reads only, panel instead of floating chat", () => {
  const nav = read("src", "components", "provider", "ProviderNav.tsx");
  assert.equal((nav.match(/\{ href: "\/provider/g) ?? []).length, 6, "the host navigation keeps its 6 items");
  assert.match(nav, /utilities=\{<HelpLink href="\/provider\/help" \/>\}/);
  assert.match(read("src", "components", "navigation", "GuestNav.tsx"), /<HelpLink href="\/help" \/>/);

  const messages = read("src", "app", "provider", "messages", "page.tsx");
  assert.match(messages, /getSupportConversations\(supabase, "host"\)/);
  assert.match(messages, /getSupportThread\(supabase, support, "host"\)/);
  assert.match(messages, /<SupportConversationPanel/);
  assert.match(messages, /<ConversationList conversations=\{conversations\} autoOpenItemId=\{item\} \/>/, "booking list unchanged");

  const help = read("src", "app", "provider", "help", "page.tsx");
  assert.match(help, /getOpenSupportThreadId\(supabase, "host", null\)/);
  assert.match(help, /<ContactFelynForm requesterRole="host" \/>/);

  const request = read("src", "app", "provider", "requests", "[itemId]", "page.tsx");
  assert.match(request, /getOpenSupportThreadId\(supabase, "host", item\.itemId\)/);
  assert.match(request, /<GetHelpButton[\s\S]*?bookingItemId=\{item\.itemId\}[\s\S]*?requesterRole="host"/);
});

test("booking messaging components do not know about support", () => {
  for (const file of ["ConversationList.tsx", "FloatingChatWindow.tsx", "MessagingProvider.tsx", "MessageLauncherButton.tsx"]) {
    assert.doesNotMatch(read("src", "components", "messaging", file), /support/i, file);
  }
  assert.doesNotMatch(read("src", "lib", "messaging", "actions.ts"), /support/i);
});
