import { createHash, timingSafeEqual } from "node:crypto";
import { dispatchDueEmails } from "@/lib/email/dispatcher";

/**
 * Retry / safety-net sweep for the transactional email outbox (0028).
 * Delivers every due row: retries after a failed attempt, and rows whose
 * immediate after() delivery never ran. Meant to be called every few minutes
 * by a scheduler (see supabase/migrations/README.md, "Migration 0028").
 *
 * POST only, with `Authorization: Bearer <EMAIL_SWEEP_SECRET>`. Without a
 * configured secret (at least 32 characters) the route does not exist.
 * The response contains counts only — never addresses or booking data.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.EMAIL_SWEEP_SECRET;
  if (!secret || secret.length < 32) return new Response(null, { status: 404 });

  const provided = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(provided), digest(`Bearer ${secret}`))) {
    return new Response(null, { status: 401 });
  }

  const summary = await dispatchDueEmails(25);
  return Response.json(summary);
}
