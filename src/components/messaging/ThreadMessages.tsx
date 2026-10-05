"use client";

import { useEffect, useRef } from "react";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** One bubble's worth of data — presentation only; each thread decides what "mine" means. */
export type ThreadMessageItem = {
  id: string;
  body: string;
  createdAt: string;
  mine: boolean;
  /** Shown above an incoming bubble (e.g. "Felyn Team"). Booking threads leave it unset. */
  senderLabel?: string;
};

/**
 * The scrolling list of message bubbles, shared by MessageThread (guest<->host)
 * and SupportThread (guest<->Felyn Team) so both look identical. Presentation
 * only: no data fetching, sending or read-state logic lives here. Scrolls to the
 * newest message whenever one is added.
 */
export function ThreadMessages({
  messages,
  appearance = "card",
}: {
  messages: ThreadMessageItem[];
  /** "card": the boxed list (floating window, provider booking page). "pane": borderless, sky outgoing bubbles (inbox pane). */
  appearance?: "card" | "pane";
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const pane = appearance === "pane";

  return (
    <div
      ref={listRef}
      className={
        pane
          ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-5 sm:px-6"
          : "flex min-h-[220px] flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-ivory-300 bg-ivory-100 p-3"
      }
    >
      {messages.length === 0 ? (
        <p className="py-6 text-center text-sm text-navy-400">No messages yet.</p>
      ) : (
        messages.map((message) => {
          const mine = message.mine;
          const bubble = pane
            ? mine
              ? "rounded-br-md bg-sky-600 text-ivory-50"
              : "rounded-bl-md border border-ivory-300 bg-ivory-50 text-navy-900"
            : mine
              ? "bg-navy-900 text-ivory-50"
              : "border border-ivory-300 bg-ivory-50 text-navy-900";
          return (
            <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl text-sm ${pane ? "px-4 py-2.5 sm:max-w-[70%]" : "px-3 py-2"} ${bubble}`}
              >
                {!mine && message.senderLabel ? (
                  <p className="mb-0.5 text-[11px] font-semibold text-navy-500">{message.senderLabel}</p>
                ) : null}
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <p className={`mt-1 text-[11px] ${mine ? (pane ? "text-sky-100" : "text-ivory-200") : "text-navy-300"}`}>
                  {formatTimestamp(message.createdAt)}
                </p>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
