const ADDRESS_PREFIX = '/address/';

/**
 * Builds the /address/... path for a set of location selections.
 * Returns '/' when there are no selections.
 */
export function buildAddressPath(selections: string[]): string {
  if (selections.length === 0) return '/';
  return ADDRESS_PREFIX + selections.map(encodeURIComponent).join('/');
}

/**
 * Parses a pathname into location selection segments.
 * Returns null when the pathname is not an /address/... path.
 */
export function parseAddressPath(pathname: string): string[] | null {
  if (pathname !== '/address' && !pathname.startsWith(ADDRESS_PREFIX)) return null;
  const rest = pathname === '/address' ? '' : pathname.slice(ADDRESS_PREFIX.length);
  return rest
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}
