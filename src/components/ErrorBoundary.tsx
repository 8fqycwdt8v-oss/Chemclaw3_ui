/**
 * Render-error containment.
 *
 * Two boundaries, for two different blast radii:
 *
 *  - One at the root, so a throw anywhere leaves a page that explains itself instead of a white
 *    screen with a stack trace in the console.
 *  - One around the transcript, because that subtree renders *model-authored* markdown through
 *    `remarkCitations`. A malformed AST there is a content bug, not an app bug, and it should cost
 *    the reader one message — not the composer, the sidebar and every earlier answer.
 *
 * Deliberately a class: `componentDidCatch` has no hook equivalent, and `react-error-boundary`
 * would be a dependency for thirty lines.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the children when they throw.
   *
   *  It takes no reset. Both fallbacks deliberately stay shown — the transcript's renders the raw
   *  answer text, which is what the reader came for — and a `reset` neither of them accepted was a
   *  retry capability that read as available and could not fire. The same went for a `resetKey`
   *  whose only caller passed `message.id` to a boundary already inside a bubble keyed on it, so
   *  it was constant for the boundary's whole life; switching conversations is handled where it
   *  actually happens, by `key={conversationId}` on `MessageList`. Re-add either one WITH the
   *  affordance that calls it. */
  fallback: (error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render failed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback(error);
    return this.props.children;
  }
}
