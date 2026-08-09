/**
 * Render-error containment.
 *
 * There were none anywhere in this app, and the input is untrusted model output: markdown through
 * remark-gfm and a hand-written AST rewriter, and SMILES through smiles-drawer. A throw in any of
 * those unmounted the React root and left a blank white page, with a persisted — possibly
 * poisoned — store and no in-app way back.
 *
 * **What a boundary does not catch, so nobody treats this as blanket coverage:** event handlers,
 * async bodies inside effects, and the streaming loop, which lives outside React entirely. Those
 * paths already handle their own failures (`Molecule` catches its draw, `useJobFeed` swallows a
 * bad frame, `sendMessage` funnels everything into `failTurn`). The uncovered surface this closes
 * is *render*.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the children after a throw. `reset` clears the boundary. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /**
   * Values that should clear a caught error when they change.
   *
   * Without this a boundary never recovers: a message that throws mid-stream because its markdown
   * is momentarily unbalanced would stay broken for the rest of the session, even after
   * `finalText` replaces the partial text with well-formed content.
   */
  resetKeys?: readonly unknown[];
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
    console.error('render error contained by a boundary:', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error === null) return;
    const a = prev.resetKeys ?? [];
    const b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error !== null) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}
