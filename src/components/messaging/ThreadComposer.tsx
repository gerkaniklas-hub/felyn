"use client";

import { Button } from "@/components/ui/button";

/**
 * The reply box under a conversation, shared by MessageThread (guest<->host) and
 * SupportThread (guest<->Felyn Team). Controlled and presentation only: the
 * parent owns the draft, decides what sending does, and passes back any error.
 * Enter sends; Shift+Enter adds a new line.
 */
export function ThreadComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  error,
  caption,
  maxLength,
  appearance = "card",
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  /** A short note above the box (e.g. the post-decision reply window, or "reply to reopen"). */
  caption?: string;
  maxLength: number;
  appearance?: "card" | "pane";
}) {
  const pane = appearance === "pane";

  return (
    <div className={`flex flex-col gap-1.5 ${pane ? "border-t border-ivory-300 bg-ivory-50 px-4 py-3 sm:px-6" : ""}`}>
      {caption ? <p className="text-xs text-navy-400">{caption}</p> : null}
      <div className={`flex gap-2 ${pane ? "items-end" : ""}`}>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value.slice(0, maxLength))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={pane ? 1 : 2}
          placeholder="Write a message…"
          className={
            pane
              ? "max-h-40 min-h-11 flex-1 resize-none rounded-3xl border border-ivory-300 bg-ivory-100 px-4 py-2.5 text-sm text-navy-900 placeholder:text-navy-300 focus:border-sky-300 focus:outline-none"
              : "flex-1 resize-none rounded-card border border-ivory-400 bg-ivory-50 px-3 py-2 text-sm text-navy-900 placeholder:text-navy-300"
          }
        />
        <Button type="button" onClick={onSend} disabled={sending || draft.trim().length === 0}>
          Send
        </Button>
      </div>
      <div className="flex items-center justify-between">
        {error ? <p className="text-xs font-medium text-gold-700">{error}</p> : <span />}
        <span className="text-xs text-navy-300">
          {draft.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}
