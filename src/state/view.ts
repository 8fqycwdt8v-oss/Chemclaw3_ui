/**
 * View-only state for the workbench: which profile a conversation was started as.
 *
 * Deliberately not in `chatStore`. That store is persisted and is the model of the conversation
 * itself; this is a note about how a *server session* was created, and the backend does not report
 * it back — `GET /sessions` returns an id and a timestamp, nothing about the profile. So this is
 * knowledge only the browser that made the choice has, and it is therefore not durable and must
 * not be shown as though it were.
 *
 * That is why it is in-memory and unpersisted: after a reload, or in another browser, the honest
 * answer to "what profile is this session running as?" is that we do not know, and an empty map
 * gives exactly that answer. A persisted copy would keep asserting a profile for a session it
 * could no longer vouch for.
 */

import { create } from 'zustand';

export interface ViewState {
  /** conversation id → the profile its session was created with. Absent means "unknown", which
   *  includes the common case of the default agent. */
  profileByConversation: Record<string, string>;
  rememberProfile: (conversationId: string, profile: string) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  profileByConversation: {},
  rememberProfile(conversationId, profile) {
    set((s) => ({
      profileByConversation: { ...s.profileByConversation, [conversationId]: profile },
    }));
  },
}));
