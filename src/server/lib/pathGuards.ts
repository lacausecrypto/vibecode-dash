import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Cross-platform containment check.
 *
 * `startsWith(root + '/')` is fragile: it is POSIX-only and can be tricked by
 * prefix siblings if any caller forgets the separator. `path.relative` gives us
 * the actual filesystem relationship on the current platform.
 */
export function isSubPath(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}
