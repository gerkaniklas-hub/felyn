import OpenAI from "openai";

/**
 * Server-only OpenAI client. OPENAI_API_KEY has no NEXT_PUBLIC_ prefix, so
 * Next.js already refuses to inline it into any client bundle — but this
 * file must still only ever be imported from Server Components/Actions
 * (never a "use client" file), the same rule as src/lib/supabase/server.ts.
 */
export function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  return new OpenAI({ apiKey });
}
