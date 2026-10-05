"use client";

import { useEffect, useRef, useState } from "react";
import { SUPPORT_STATUSES, type SupportStatus } from "@/lib/support/constants";
import { mapSupportMessageRow, type SupportMessage } from "@/lib/support/queries";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Live updates for ONE support conversation, shared by the guest's SupportThread
 * and the staff ticket view:
 *   - new messages: INSERT on support_messages for this thread
 *   - status changes: UPDATE on this thread's support_threads row (resolved, closed,
 *     re-opened). The row also changes on every new message (last_message_at), so
 *     `onStatus` receives every update's status and the caller ignores unchanged ones.
 * Two separate channels, so a problem with one never affects the other. RLS (0029)
 * decides what each subscriber may receive: a guest only their own thread, staff any.
 * Returns true while either channel has failed (callers show a refresh fallback).
 */
export function useSupportThreadRealtime(
  threadId: string,
  handlers: { onMessage: (message: SupportMessage) => void; onStatus: (status: SupportStatus) => void },
): boolean {
  // One browser client per instance, for the same reason MessageThread keeps one
  // (a fresh client per effect run raced its own channel cleanup in dev).
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [messagesProblem, setMessagesProblem] = useState(false);
  const [statusProblem, setStatusProblem] = useState(false);

  // The latest handlers, so the long-lived subscriptions always see current state.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const channel = supabase
      .channel(`support_messages:${threadId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages", filter: `support_thread_id=eq.${threadId}` },
        (payload) => {
          handlersRef.current.onMessage(mapSupportMessageRow(payload.new as Parameters<typeof mapSupportMessageRow>[0]));
        },
      )
      .subscribe((state) => {
        if (state === "SUBSCRIBED") setMessagesProblem(false);
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setMessagesProblem(true);
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [threadId, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`support_threads:${threadId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "support_threads", filter: `id=eq.${threadId}` },
        (payload) => {
          const next = (payload.new as { status?: string }).status;
          if (next && (SUPPORT_STATUSES as readonly string[]).includes(next)) {
            handlersRef.current.onStatus(next as SupportStatus);
          }
        },
      )
      .subscribe((state) => {
        if (state === "SUBSCRIBED") setStatusProblem(false);
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setStatusProblem(true);
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [threadId, supabase]);

  return messagesProblem || statusProblem;
}
