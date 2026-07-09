/** Resolve a user-supplied reference (id, slug, or name) to a list item. */

interface Named {
  id: string
  slug?: string | null
  name?: string | null
}

export type MatchResult<T> =
  | { kind: 'match'; item: T }
  | { kind: 'ambiguous'; matches: T[] }
  | { kind: 'none' }

/**
 * Resolve a reference by exact id, then exact slug (both unique), then
 * case-insensitive name. Names are NOT unique, so a name that matches more than
 * one item returns ``ambiguous`` (the caller should ask for a slug/id) rather
 * than silently picking the first.
 */
export function matchRef<T extends Named>(items: T[], ref: string): MatchResult<T> {
  const r = ref.trim()
  const byId = items.find((i) => i.id === r)
  if (byId) return { kind: 'match', item: byId }

  const bySlug = items.find((i) => i.slug != null && i.slug === r)
  if (bySlug) return { kind: 'match', item: bySlug }

  const lower = r.toLowerCase()
  const byName = items.filter((i) => (i.name ?? '').toLowerCase() === lower)
  if (byName.length === 1) return { kind: 'match', item: byName[0] }
  if (byName.length > 1) return { kind: 'ambiguous', matches: byName }
  return { kind: 'none' }
}
