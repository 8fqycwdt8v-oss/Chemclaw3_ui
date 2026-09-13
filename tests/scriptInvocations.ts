/**
 * Which `scripts/*.mjs` a file actually **runs**, as opposed to which it mentions.
 *
 * `tests/gate.test.ts` used to answer this by grepping a comment-stripped source for
 * `scripts/<name>.mjs`. Comment-stripping was the fix for a measured defect — a comment naming a
 * script standing in for the call — and it left the identical hole one layer in, because a string
 * literal is not a comment. Measured on `11a2771`: replacing `check-container.mjs`'s real
 * invocation of `check-serving.mjs` with `{ status: 0 }` left `gate.test.ts` green, because
 * `check-container.mjs:75` prints
 *
 *     console.log('  assertions of the image it publishes, by calling scripts/check-serving.mjs.');
 *
 * in its skip branch. The four serving assertions — the only end-to-end check that the BFF's proxy
 * whitelist refuses `/api/metrics` — could be deleted with every meta-test passing.
 *
 * So this asks the parser instead of the text: a name counts when it is an argument of a call, and
 * a call whose callee is `console.*` is a print rather than an invocation. That is the distinction
 * the grep could not make, and it is the whole content of this module.
 */

import ts from 'typescript';

/** `true` for `console.log(…)`, `console.error(…)` and friends — printing, not running. */
const isPrint = (callee: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(callee) &&
  ts.isIdentifier(callee.expression) &&
  callee.expression.text === 'console';

/** Every `scripts/<name>.mjs` named by a string inside `node`, recursively. */
function scriptsNamedIn(node: ts.Node, out: Set<string>): void {
  if (ts.isStringLiteralLike(node)) {
    for (const match of node.text.matchAll(/scripts\/([\w.-]+\.mjs)/g)) out.add(match[1] as string);
  }
  ts.forEachChild(node, (child) => scriptsNamedIn(child, out));
}

/**
 * Every `scripts/<name>.mjs` this source **invokes**, by file name.
 *
 * A name is invoked when it appears in an argument of a call expression that is not a `console.*`
 * print — which covers `run(process.execPath, ['scripts/x.mjs', url])`, `spawnSync('node', [...])`
 * and `execFileSync(process.execPath, [...])` without this module having to know which helper a
 * script wraps its spawning in.
 */
export function invokedScripts(source: string, fileName = 'script.mjs'): Set<string> {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !isPrint(node.expression)) {
      for (const argument of node.arguments) scriptsNamedIn(argument, found);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}
