import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Static checks of the guest booking-flow UI: withdrawing from the booking detail
// page, and the "Request sent" modal after Explore's "Request experience".
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");

const bookingPage = read("src", "app", "bookings", "[itemId]", "page.tsx");
const withdrawButton = read("src", "components", "booking", "WithdrawRequestButton.tsx");
const bookingRequests = read("src", "lib", "matching", "booking-requests.ts");
const requestModal = read("src", "components", "booking", "RequestExperienceModal.tsx");

test("the booking detail page offers Withdraw only for a REQUESTED item", () => {
  const uses = [...bookingPage.matchAll(/<WithdrawRequestButton\b/g)];
  assert.equal(uses.length, 1);
  assert.match(bookingPage, /\{item\.status === "REQUESTED" \? <WithdrawRequestButton itemId=\{item\.id\} \/> : null\}/);
  // Cancel stays CONFIRMED-only, so the two actions never appear together.
  assert.match(bookingPage, /\{item\.status === "CONFIRMED" \? <CancelExperienceButton /);
});

test("withdrawing goes through the existing action and the 0031 database function, after a confirmation", () => {
  assert.match(withdrawButton, /import \{ withdrawBookingRequestItem \} from "@\/lib\/matching\/booking-requests";/);
  assert.doesNotMatch(withdrawButton, /\.rpc\(|\.from\(|\.update\(/);
  // The action is only called from the dialog's confirm handler, never from the trigger button.
  assert.equal([...withdrawButton.matchAll(/withdrawBookingRequestItem\(/g)].length, 1);
  assert.match(withdrawButton, /async function confirmWithdraw\(\) \{\s+setState\(\{ status: "pending" \}\);\s+const result = await withdrawBookingRequestItem\(itemId\);/);
  assert.match(withdrawButton, /onClick=\{\(\) => setState\(\{ status: "confirming", error: null \}\)\}/);
  for (const copy of ["Withdraw request?", "Keep request", "The host will no longer be able to accept it."]) {
    assert.ok(withdrawButton.includes(copy), `missing copy: ${copy}`);
  }
  const action = bookingRequests.slice(bookingRequests.indexOf("export async function withdrawBookingRequestItem("));
  assert.match(action.slice(0, action.indexOf("\n}\n")), /\.rpc\("booking_item_withdraw", \{ p_item_id: itemId \}\)/);
});

test("the Request sent modal appears only after a successful request", () => {
  const submit = requestModal.slice(requestModal.indexOf("async function submit()"));
  const body = submit.slice(0, submit.indexOf("\n  }\n"));
  // The only place the success state is set is after the `!result.ok` early return.
  assert.equal([...requestModal.matchAll(/setSentItemId\(/g)].length, 1);
  assert.ok(body.indexOf("if (!result.ok) {") >= 0);
  assert.ok(body.indexOf("setSentItemId(result.itemId)") > body.indexOf("if (!result.ok) {"));
  assert.match(body, /if \(!result\.ok\) \{\s+setSending\(false\);\s+setError\(result\.error\);\s+return;\s+\}/);
  assert.match(requestModal, /if \(sentItemId\) \{\s+return \(\s+<RequestSentModal/);
  const sentModal = read("src", "components", "booking", "RequestSentModal.tsx");
  // No mention of payment in what the guest sees (comments aside): payment isn't built yet.
  const visible = sentModal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(visible, /\bpay/i);
});
