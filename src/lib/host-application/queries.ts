import type { SupabaseClient } from "@supabase/supabase-js";
import type { HostApplicationStatus } from "./constants";

export type HostApplication = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  displayName: string;
  location: string;
  experienceCategory: string;
  experienceDescription: string;
  background: string | null;
  websiteUrl: string | null;
  status: HostApplicationStatus;
  decisionMessage: string | null;
  submittedAt: string;
  reviewedAt: string | null;
};

type HostApplicationRow = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  display_name: string;
  location: string;
  experience_category: string;
  experience_description: string;
  background: string | null;
  website_url: string | null;
  status: HostApplicationStatus;
  decision_message: string | null;
  submitted_at: string;
  reviewed_at: string | null;
};

export type HostAccess = {
  /** The caller's own providers.id — present only once Felyn has approved them (created by felyn_admin.approve_host_application). */
  providerId: string | null;
  application: HostApplication | null;
};

/**
 * The single source of truth for "is this account a host / an applicant".
 * Both reads are RLS-scoped to the signed-in user (0023: "Providers read
 * their own profile", "Applicants read their own application"), and the
 * userId filter is belt-and-braces. Never derived from user metadata, URL
 * parameters, or client state — host access is exactly "a providers row
 * with this user_id exists", which only the manual approval function can
 * create.
 */
export async function getHostAccess(supabase: SupabaseClient, userId: string): Promise<HostAccess> {
  const [providerRes, applicationRes] = await Promise.all([
    supabase.from("providers").select("id").eq("user_id", userId).maybeSingle(),
    supabase
      .from("host_applications")
      .select(
        "id, first_name, last_name, phone, display_name, location, experience_category, experience_description, background, website_url, status, decision_message, submitted_at, reviewed_at",
      )
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  // Fail closed: a failed read must never look like "not a host / never
  // applied", or a rejected applicant would be shown the application form.
  // Log the error code only — no user data, query results or credentials.
  if (providerRes.error || applicationRes.error) {
    const failed = providerRes.error ? "providers" : "host_applications";
    const code = (providerRes.error ?? applicationRes.error)?.code ?? "unknown";
    console.error(`getHostAccess: ${failed} read failed (code ${code})`);
    throw new Error("Could not load host access");
  }

  const provider = providerRes.data as { id: string } | null;
  const row = applicationRes.data as HostApplicationRow | null;

  return {
    providerId: provider?.id ?? null,
    application: row
      ? {
          id: row.id,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          displayName: row.display_name,
          location: row.location,
          experienceCategory: row.experience_category,
          experienceDescription: row.experience_description,
          background: row.background,
          websiteUrl: row.website_url,
          status: row.status,
          decisionMessage: row.decision_message,
          submittedAt: row.submitted_at,
          reviewedAt: row.reviewed_at,
        }
      : null,
  };
}
