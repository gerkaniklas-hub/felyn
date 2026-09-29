/**
 * Host application constants — mirrors the CHECK constraints of
 * public.host_applications (migration 0023) exactly, so the form rejects
 * invalid input with a friendly message before the database would.
 */

export const HOST_APPLICATION_CATEGORIES = [
  { value: "food", label: "Food" },
  { value: "drink", label: "Drinks" },
  { value: "food_drink", label: "Food & Drinks" },
  { value: "other", label: "Other" },
] as const;

export type HostApplicationCategory = (typeof HOST_APPLICATION_CATEGORIES)[number]["value"];

export type HostApplicationStatus = "submitted" | "approved" | "rejected";

export const HOST_APPLICATION_LIMITS = {
  firstName: { min: 1, max: 100 },
  lastName: { min: 1, max: 100 },
  phone: { min: 6, max: 40 },
  displayName: { min: 1, max: 60 },
  location: { min: 2, max: 200 },
  experienceDescription: { min: 20, max: 2000 },
  background: { max: 2000 },
  /** website_url (0023) — one optional field for a website or an Instagram handle. */
  websiteOrInstagram: { max: 300 },
} as const;

export function getCategoryLabel(value: string): string {
  return HOST_APPLICATION_CATEGORIES.find((category) => category.value === value)?.label ?? value;
}
