/**
 * The configuration gate — the outermost thing that can refuse to run the app.
 *
 * It sits ABOVE `AuthGate`, and that placement is the point rather than a detail. `configProblems`
 * used to be called from `App` itself, at which point `AuthGate` had already constructed an auth
 * provider, `useJobFeed` had already opened the push-back stream, and `Sidebar`'s effect had
 * already called `GET /sessions` — so a deployment whose configuration was broken had, by the time
 * it said so, already made unauthenticated requests. A gate that renders after the requests it
 * exists to prevent is not a gate.
 *
 * Rendering `null` children is what makes it one: nothing below this component mounts, so no
 * provider is built and no effect runs.
 */

import { configProblems } from './env.ts';

export function ConfigError({ problems }: { problems: string[] }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger-soft p-5">
        <h1 className="mb-2 font-semibold text-danger">Configuration error</h1>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-muted">
          These come from the UI server’s environment and are served at <code>/config.js</code>.
        </p>
      </div>
    </div>
  );
}

export function ConfigGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const problems = configProblems();
  if (problems.length > 0) return <ConfigError problems={problems} />;
  return <>{children}</>;
}
