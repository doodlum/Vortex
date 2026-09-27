import minimatch from "minimatch";

/**
 * `minimatch(name, expression)` without re-compiling the expression on every call.
 *
 * Reference matching globs one archive name against one fileExpression per (mod, reference)
 * pair, so a collection scan compiles the same few hundred expressions hundreds of thousands of
 * times. `minimatch(p, pattern)` is exactly `new Minimatch(pattern, {}).match(p)` after a
 * comment shortcut the compiled pattern repeats (a leading "#" matches nothing either way), and
 * `match` reads the compiled pattern without changing it. So a compiled pattern, keyed on the
 * expression string alone, answers every later call exactly as a fresh one would. Invalid
 * patterns throw from the constructor and are never stored, so they throw every time, as before.
 */
const MAX_COMPILED = 2000;
const compiled = new Map<string, minimatch.IMinimatch>();

export function globMatch(name: string, expression: string): boolean {
  let pattern = compiled.get(expression);
  if (pattern === undefined) {
    pattern = new minimatch.Minimatch(expression, {});
    if (compiled.size >= MAX_COMPILED) {
      compiled.clear();
    }
    compiled.set(expression, pattern);
  }
  return pattern.match(name);
}

/**
 * `sanitize(fileName)` for a pure `sanitize` (sanitizeExpression), remembered per file name. A scan
 * sanitizes the same archive names for every reference; the results are strings, compared by value.
 */
const MAX_SANITIZED = 20000;
const sanitized = new Map<string, string>();

export function sanitizedFileName(fileName: string, sanitize: (name: string) => string): string {
  if (typeof fileName !== "string") {
    return sanitize(fileName);
  }
  let result = sanitized.get(fileName);
  if (result === undefined) {
    result = sanitize(fileName);
    if (sanitized.size >= MAX_SANITIZED) {
      sanitized.clear();
    }
    sanitized.set(fileName, result);
  }
  return result;
}
