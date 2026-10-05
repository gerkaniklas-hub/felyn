"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { openGuestSupportConversation } from "@/lib/support/actions";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  type SupportCategory,
} from "@/lib/support/constants";

/**
 * The short "talk to Felyn" form: a topic and a message — nothing that reads like
 * a ticket. Used by the Help page (general) and a booking's Get help (with
 * `bookingItemId`, which the guest never types or sees). On success the guest
 * lands in that Felyn Team conversation in Messages. The server action and the
 * database function decide everything (ownership, reuse of an open conversation);
 * the checks here only make the form pleasant.
 */
export function ContactFelynForm({
  bookingItemId = null,
  defaultCategory = null,
  onCancel,
}: {
  bookingItemId?: string | null;
  defaultCategory?: SupportCategory | null;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [category, setCategory] = useState<SupportCategory | null>(defaultCategory);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (sending) return;
    if (!category) {
      setError("Please choose what your message is about.");
      return;
    }
    if (body.trim().length === 0) {
      setError("Please write a message for Felyn.");
      return;
    }
    setSending(true);
    setError(null);
    const result = await openGuestSupportConversation({ category, body, bookingItemId });
    if (!result.ok) {
      setSending(false);
      setError(result.error);
      return;
    }
    // Stays in the "sending" state while Messages loads.
    router.push(`/messages?support=${result.threadId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-navy-700">What can we help with?</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SUPPORT_CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={category === option}
              onClick={() => {
                setCategory(option);
                setError(null);
              }}
              className={`h-11 rounded-xl border px-3 text-sm font-medium transition-colors ${
                category === option
                  ? "border-navy-900 bg-navy-900 text-ivory-50"
                  : "border-ivory-300 bg-ivory-50 text-navy-700 hover:border-navy-300"
              }`}
            >
              {SUPPORT_CATEGORY_LABELS[option]}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-navy-700">Your message</span>
        <textarea
          value={body}
          onChange={(event) => {
            setBody(event.target.value.slice(0, SUPPORT_MESSAGE_MAX_LENGTH));
            setError(null);
          }}
          rows={5}
          placeholder="Tell us what's going on — we'll reply here in Felyn."
          className="resize-none rounded-xl border border-ivory-400 bg-ivory-50 px-4 py-3 text-sm text-navy-900 outline-none placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        />
        <span className="self-end text-xs text-navy-300">
          {body.length}/{SUPPORT_MESSAGE_MAX_LENGTH}
        </span>
      </label>

      {error ? <p className="rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">{error}</p> : null}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="button" onClick={submit} disabled={sending} className="sm:flex-1">
          {sending ? "Sending…" : "Send to Felyn"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={sending} className="sm:flex-1">
            Cancel
          </Button>
        ) : null}
      </div>
      <p className="-mt-3 text-center text-xs text-navy-500">The Felyn Team replies in your Messages.</p>
    </div>
  );
}
