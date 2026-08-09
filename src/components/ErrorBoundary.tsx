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
  /** Rendered instead of the children when they throw. Receives a reset for a retry affordance. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Remounting key: when this changes, a boundary that has caught will try rendering again. */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    // Switching conversations should not leave the previous one's render failure on screen.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render failed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback(error, () => this.setState({ error: null }));
    return this.props.children;
  }
}
