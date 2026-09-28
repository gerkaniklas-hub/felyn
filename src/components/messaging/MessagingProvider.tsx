"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { FloatingChatWindow } from "./FloatingChatWindow";

/** Everything the floating chat window needs to open one conversation — deliberately lightweight, since every caller already has this from its own page/card data (no extra fetch to open a conversation). */
export type ConversationHandle = {
  itemId: string;
  otherParticipant: { label: string; imageUrl: string | null; providerId: string | null };
  experienceTitle: string;
  experienceImageUrl: string | null;
  bookingHref: string;
  canSend: boolean;
  closedLabel?: string;
  /** Stage 2c-B: shown only while a DECLINED/CANCELLED conversation is still inside its 30-day reply window — see getMessagingOpenCaption. */
  openCaption?: string;
};

type PanelState = "open" | "minimized";

type MessagingContextValue = {
  currentUserId: string | null;
  conversation: ConversationHandle | null;
  panelState: PanelState;
  openConversation: (handle: ConversationHandle) => void;
  minimize: () => void;
  reopen: () => void;
  close: () => void;
};

const MessagingContext = createContext<MessagingContextValue | null>(null);

/**
 * App-wide messaging state (task 2/4): mounted once in the root layout so
 * it survives client-side navigation within either the guest or provider
 * app tree — "Message host"/"Message guest" anywhere in Felyn opens the
 * SAME floating window, and moving around the app never closes it. Reuses
 * the existing MessageThread/lib/messaging entirely; this component only
 * tracks WHICH conversation is open and whether the panel is expanded or
 * minimized — it never fetches or sends a message itself.
 */
export function MessagingProvider({ children }: { children: ReactNode }) {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationHandle | null>(null);
  const [panelState, setPanelState] = useState<PanelState>("open");

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  const value = useMemo<MessagingContextValue>(
    () => ({
      currentUserId,
      conversation,
      panelState,
      openConversation: (handle) => {
        setConversation(handle);
        setPanelState("open");
      },
      minimize: () => setPanelState("minimized"),
      reopen: () => setPanelState("open"),
      close: () => setConversation(null),
    }),
    [currentUserId, conversation, panelState],
  );

  return (
    <MessagingContext.Provider value={value}>
      {children}
      <FloatingChatWindow />
    </MessagingContext.Provider>
  );
}

export function useMessaging(): MessagingContextValue {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used within MessagingProvider");
  return ctx;
}
