import "server-only";
import { after } from "next/server";
import type { BookingItemStatus, CancelledBy } from "@/lib/matching/booking-status";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readEmailConfig } from "./config";
import { processClaimedRow, type DispatchDeps, type DispatchOutcome } from "./dispatch-core";
import type { OutboxRow } from "./events";
import { sendWithResend } from "./resend";

/**
 * The trusted server-side email sender. It is the only code that reads
 * public.email_outbox or other users' email addresses, using the admin
 * client (src/lib/supabase/admin.ts). Two entry points:
 *
 *   - scheduleEmailDispatch(): called by the booking Server Actions after a
 *     successful change. Runs AFTER the response via next/server `after()`,
 *     so it never delays or fails the guest's or host's action.
 *   - dispatchDueEmails(): also used by the sweep route
 *     (src/app/api/email/sweep/route.ts) to retry failed or missed rows.
 *
 * Both process whatever is due, not just "their" row: the outbox row was
 * already committed by 0028's trigger with the booking change, and the
 * claim (FOR UPDATE SKIP LOCKED) guarantees one sender per row.
 */

export type DispatchSummary = {
  mode: "off" | "log" | "send" | "misconfigured";
  claimed: number;
  outcomes: Partial<Record<DispatchOutcome, number>>;
};

const MAX_BATCH = 25;

export async function dispatchDueEmails(limit = 10): Promise<DispatchSummary> {
  const configResult = readEmailConfig(process.env);
  if (!configResult.ok) {
    console.error(`email: delivery misconfigured — ${configResult.error}`);
    return { mode: "misconfigured", claimed: 0, outcomes: {} };
  }
  const config = configResult.config;
  if (!config) return { mode: "off", claimed: 0, outcomes: {} };

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("email: delivery misconfigured — SUPABASE_SECRET_KEY is not set");
    return { mode: "misconfigured", claimed: 0, outcomes: {} };
  }

  const { data, error } = await admin.rpc("claim_email_outbox", { p_limit: Math.min(Math.max(limit, 1), MAX_BATCH) });
  if (error) {
    console.error(`email: claiming outbox rows failed (code ${error.code ?? "unknown"})`);
    return { mode: config.mode, claimed: 0, outcomes: {} };
  }
  const rows = (data as OutboxRow[] | null) ?? [];

  async function finish(row: OutboxRow, fields: Record<string, unknown>): Promise<void> {
    const { error: updateError } = await admin!
      .from("email_outbox")
      .update({ ...fields, claim_token: null, claimed_at: null, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("claim_token", row.claim_token)
      .eq("status", "sending");
    if (updateError) throw new Error(`outbox update failed (code ${updateError.code ?? "unknown"})`);
  }

  const deps: DispatchDeps = {
    config,
    now: () => new Date(),
    async loadCurrentState(row) {
      const [itemsRes, requestRes] = await Promise.all([
        admin.from("booking_request_items").select("id, status, cancelled_by").in("id", row.booking_request_item_ids),
        admin.from("booking_requests").select("status").eq("id", row.booking_request_id).maybeSingle(),
      ]);
      if (itemsRes.error || requestRes.error) throw new Error("booking state read failed");
      const items = (itemsRes.data as { id: string; status: BookingItemStatus; cancelled_by: CancelledBy | null }[] | null) ?? [];
      if (items.length === 0 || !requestRes.data) return null;
      return {
        requestStatus: (requestRes.data as { status: string }).status,
        items: items.map((item) => ({ id: item.id, status: item.status, cancelledBy: item.cancelled_by })),
      };
    },
    async getRecipientEmail(userId) {
      const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId);
      if (userError) {
        if (userError.status === 404) return null;
        throw new Error(`recipient lookup failed (status ${userError.status ?? "unknown"})`);
      }
      return userData.user?.email ?? null;
    },
    send: (input) => sendWithResend(input),
    log: (message, details) => console.info(message, details),
    markSent: (row, providerMessageId) =>
      finish(row, { status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerMessageId, last_error: null }),
    markRetry: (row, lastError, nextAttemptAt) =>
      finish(row, { status: "pending", next_attempt_at: nextAttemptAt.toISOString(), last_error: lastError.slice(0, 1000) }),
    markFailed: (row, lastError) => finish(row, { status: "failed", last_error: lastError.slice(0, 1000) }),
    markSkipped: (row, reason) => finish(row, { status: "skipped", skip_reason: reason.slice(0, 200) }),
  };

  const outcomes: DispatchSummary["outcomes"] = {};
  for (const row of rows) {
    const outcome = await processClaimedRow(row, deps);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "failed") console.error(`email: outbox row ${row.id} (${row.event_type}) failed permanently`);
  }
  return { mode: config.mode, claimed: rows.length, outcomes };
}

/**
 * Starts delivery after the current Server Action's response has been sent.
 * Never throws and never delays the action; if this process is cut short,
 * the sweep delivers the rows later.
 */
export function scheduleEmailDispatch(): void {
  try {
    after(async () => {
      try {
        await dispatchDueEmails(10);
      } catch (error) {
        console.error("email: background dispatch failed", error instanceof Error ? error.message : error);
      }
    });
  } catch (error) {
    console.error("email: could not schedule dispatch", error instanceof Error ? error.message : error);
  }
}
