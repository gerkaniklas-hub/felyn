"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fieldClass, fieldLabelClass, textareaClass } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { textLinkClass } from "@/components/ui/page";
import { updateHostPublicProfile } from "@/lib/provider/profile-actions";
import {
  HOST_BIO_MAX,
  HOST_DISPLAY_NAME_MAX,
  HOST_LANGUAGES,
  HOST_LOCATION_MAX,
  validateHostProfile,
} from "@/lib/provider/profile";

type State = { status: "idle" | "pending" | "saved" } | { status: "error"; message: string };

function humanize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The editable part of the host's public profile — name, location, "About you" and
 * languages, saved together by "Save changes" (updateHostPublicProfile checks
 * everything again on the server). Same field styling, saving state, "Saved." and
 * inline errors as the guest ProfileDetailsForm. Specialties are shown read-only:
 * they come from the specialty tags on the host's published experiences.
 */
export function HostProfileForm({
  displayName,
  baseLocation,
  bio,
  languages: initialLanguages,
  specialties,
}: {
  displayName: string;
  baseLocation: string | null;
  bio: string | null;
  languages: string[];
  specialties: string[];
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const [bioText, setBioText] = useState(bio ?? "");
  const [languages, setLanguages] = useState<string[]>(initialLanguages);
  const [languageToAdd, setLanguageToAdd] = useState("");

  const addable = HOST_LANGUAGES.filter((language) => !languages.includes(language));

  function addLanguage() {
    if (!languageToAdd || languages.includes(languageToAdd)) return;
    setLanguages((prev) => [...prev, languageToAdd]);
    setLanguageToAdd("");
    setState({ status: "idle" });
  }

  function removeLanguage(language: string) {
    setLanguages((prev) => prev.filter((value) => value !== language));
    setState({ status: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const input = {
      displayName: String(formData.get("displayName") ?? ""),
      baseLocation: String(formData.get("baseLocation") ?? ""),
      bio: bioText,
      languages,
    };
    // Instant feedback only — the server action validates again.
    const check = validateHostProfile(input, initialLanguages);
    if (!check.ok) {
      setState({ status: "error", message: check.error });
      return;
    }

    setState({ status: "pending" });
    const result = await updateHostPublicProfile(input);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "saved" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Input
        label="Name"
        name="displayName"
        defaultValue={displayName}
        maxLength={HOST_DISPLAY_NAME_MAX}
        autoComplete="name"
        required
      />
      <Input
        label="Location"
        name="baseLocation"
        defaultValue={baseLocation ?? ""}
        maxLength={HOST_LOCATION_MAX}
        placeholder="e.g. Los Cristianos, Tenerife"
      />

      <label htmlFor="host-bio" className="flex flex-col gap-1.5">
        <span className={fieldLabelClass}>About you</span>
        <textarea
          id="host-bio"
          name="bio"
          value={bioText}
          onChange={(event) => setBioText(event.target.value)}
          maxLength={HOST_BIO_MAX}
          rows={5}
          placeholder="Your story, what you love to share and what guests can expect from you."
          className={textareaClass}
        />
        <span className="self-end text-xs text-navy-400">
          {bioText.length}/{HOST_BIO_MAX}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span className={fieldLabelClass}>Languages</span>
        {languages.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {languages.map((language) => (
              <li key={language}>
                <span className="inline-flex items-center gap-1 rounded-full bg-navy-100 py-1 pr-1.5 pl-3 text-xs font-medium text-navy-700">
                  {language}
                  <button
                    type="button"
                    onClick={() => removeLanguage(language)}
                    aria-label={`Remove ${language}`}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-navy-500 hover:bg-navy-200 hover:text-navy-900"
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-navy-500">No languages yet.</p>
        )}
        {addable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="host-language-add">
              Add language
            </label>
            <select
              id="host-language-add"
              value={languageToAdd}
              onChange={(event) => setLanguageToAdd(event.target.value)}
              className={`${fieldClass} min-w-0 flex-1 sm:max-w-60 sm:flex-none`}
            >
              <option value="">Choose a language</option>
              {addable.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
            <Button type="button" variant="secondary" size="sm" onClick={addLanguage} disabled={!languageToAdd}>
              Add language
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className={fieldLabelClass}>Specialties</span>
        {specialties.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {specialties.map((specialty) => (
              <Badge key={specialty} tone="gold">
                {humanize(specialty)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-navy-500">No specialties yet.</p>
        )}
        <Link href="/provider/experiences" className={`self-start ${textLinkClass}`}>
          Set by the tags on your experiences →
        </Link>
      </div>

      <div className="flex flex-col gap-2 border-t border-ivory-300 pt-5">
        {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
        {state.status === "saved" ? <p className="text-sm text-sky-700">Saved.</p> : null}
        <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={state.status === "pending"}>
          {state.status === "pending" ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
