"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  HOST_APPLICATION_CATEGORIES,
  HOST_APPLICATION_LIMITS as LIMITS,
} from "@/lib/host-application/constants";
import { getHostAccess } from "@/lib/host-application/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type HostApplicationFormState = {
  error?: string;
  fieldErrors?: Partial<Record<HostApplicationField, string>>;
  /** Echoed back so the form can re-fill itself after React resets it on an error. */
  values?: Partial<Record<HostApplicationField, string>>;
};

export type DisplayNameFormState = { error?: string; ok?: boolean };

type HostApplicationField =
  | "firstName"
  | "lastName"
  | "phone"
  | "location"
  | "experienceCategory"
  | "experienceDescription"
  | "background"
  | "websiteOrInstagram"
  | "displayName";

const GENERIC_ERROR = "Something went wrong while sending your application. Please try again.";
const UNIQUE_VIOLATION = "23505";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Creates the signed-in user's host application. Authorization is entirely
 * server-side: the user id comes from the verified session (never the
 * form), and the insert only names columns 0023 grants to `authenticated`.
 * status/provider_id/review fields are never sent — RLS and column
 * privileges would reject them anyway. Submitting grants no host access;
 * only felyn_admin.approve_host_application (run manually by Felyn) does.
 */
export async function submitHostApplication(
  _prevState: HostApplicationFormState,
  formData: FormData,
): Promise<HostApplicationFormState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const values = {
    firstName: text(formData, "firstName"),
    lastName: text(formData, "lastName"),
    phone: text(formData, "phone"),
    location: text(formData, "location"),
    experienceCategory: text(formData, "experienceCategory"),
    experienceDescription: text(formData, "experienceDescription"),
    background: text(formData, "background"),
    websiteOrInstagram: text(formData, "websiteOrInstagram"),
    displayName: text(formData, "displayName"),
  };

  const fieldErrors: HostApplicationFormState["fieldErrors"] = {};
  if (values.firstName.length < LIMITS.firstName.min) fieldErrors.firstName = "Please enter your first name.";
  else if (values.firstName.length > LIMITS.firstName.max) fieldErrors.firstName = "That name is a little too long.";
  if (values.lastName.length < LIMITS.lastName.min) fieldErrors.lastName = "Please enter your last name.";
  else if (values.lastName.length > LIMITS.lastName.max) fieldErrors.lastName = "That name is a little too long.";
  if (values.phone.length < LIMITS.phone.min || values.phone.length > LIMITS.phone.max) {
    fieldErrors.phone = "Please enter a phone number we can reach you on.";
  }
  if (values.location.length < LIMITS.location.min) fieldErrors.location = "Please tell us where you would host.";
  else if (values.location.length > LIMITS.location.max) fieldErrors.location = "Please keep this under 200 characters.";
  if (!HOST_APPLICATION_CATEGORIES.some((category) => category.value === values.experienceCategory)) {
    fieldErrors.experienceCategory = "Please choose the kind of experience.";
  }
  if (values.experienceDescription.length < LIMITS.experienceDescription.min) {
    fieldErrors.experienceDescription = "Please tell us a little more — at least a couple of sentences.";
  } else if (values.experienceDescription.length > LIMITS.experienceDescription.max) {
    fieldErrors.experienceDescription = "Please keep this under 2,000 characters.";
  }
  if (values.background.length > LIMITS.background.max) {
    fieldErrors.background = "Please keep this under 2,000 characters.";
  }
  if (values.displayName.length > LIMITS.displayName.max) {
    fieldErrors.displayName = "Please keep your public name under 60 characters.";
  }
  if (values.websiteOrInstagram.length > LIMITS.websiteOrInstagram.max) {
    fieldErrors.websiteOrInstagram = "Please keep this under 300 characters.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { error: "Please check the highlighted fields.", fieldErrors, values };
  }

  // Already a host, or already applied: never create a second record.
  const access = await getHostAccess(supabase, user.id);
  if (access.providerId) redirect("/provider");
  if (access.application) redirect("/host/application");

  const { error } = await supabase.from("host_applications").insert({
    user_id: user.id,
    first_name: values.firstName,
    last_name: values.lastName,
    phone: values.phone,
    // Empty -> null: the 0023 trigger defaults the public name to the first name.
    display_name: values.displayName || null,
    location: values.location,
    experience_category: values.experienceCategory,
    experience_description: values.experienceDescription,
    background: values.background || null,
    // 0023 has a single optional link column; the field accepts a website or an Instagram handle.
    website_url: values.websiteOrInstagram || null,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) redirect("/host/application");
    return { error: GENERIC_ERROR, values };
  }

  revalidatePath("/host/application");
  redirect("/host/application?submitted=1");
}

/**
 * Updates ONLY the public display name of the caller's own application.
 * 0023 allows this solely while status = 'submitted' (RLS policy +
 * column-level UPDATE grant on display_name only); the status filter here
 * mirrors that so a locked application gets a clear message instead of a
 * silent no-op.
 */
export async function updateHostDisplayName(
  _prevState: DisplayNameFormState,
  formData: FormData,
): Promise<DisplayNameFormState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const displayName = text(formData, "displayName");
  if (displayName.length < LIMITS.displayName.min) return { error: "Please enter a public name." };
  if (displayName.length > LIMITS.displayName.max) return { error: "Please keep your public name under 60 characters." };

  const { data, error } = await supabase
    .from("host_applications")
    .update({ display_name: displayName })
    .eq("user_id", user.id)
    .eq("status", "submitted")
    .select("id");

  if (error) return { error: "We couldn't save your public name. Please try again." };
  if (!data || data.length === 0) {
    return { error: "Your public name can no longer be changed here, as your application has been reviewed." };
  }

  revalidatePath("/host/application");
  return { ok: true };
}
