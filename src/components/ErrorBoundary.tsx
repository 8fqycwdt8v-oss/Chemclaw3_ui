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
import { logger } from '../lib/logger.ts';

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
    // The console call stays: it is what a developer with the tab open actually reads, and it
    // carries the component stack, which is the part that says *where*. What is new is that the
    // failure also leaves the browser — this used to be the entire reporting story for a crash,
    // so a render error nobody was watching happen was a render error nobody ever heard about.
    logger.error('render.failed', {
      name: error.name,
      message: error.message,
      // First frames only: a component stack is long, and the top of it is what identifies the
      // subtree. The whole thing is in the console for anyone who has the tab.
      componentStack: (info.componentStack ?? '').trim().split('\n').slice(0, 5).join(' | '),
    });
    console.error('Render failed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback(error);
    return this.props.children;
  }
}
