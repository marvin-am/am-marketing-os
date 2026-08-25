/**
 * Array reordering, kept free of React so the pure spec operations in
 * `form-ops` and `page-ops` do not have to import a client component just to
 * move an element.
 */

/** Moves an element inside an array, returning a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}
