const ADDRESS_PREFIX = '/address/';

/**
 * Builds the /address/... path for a set of location selections.
 * Returns '/' when there are no selections.
 */
export function buildAddressPath(selections: string[]): string {
  if (selections.length === 0) return '/';
  return ADDRESS_PREFIX + selections.map(encodeURIComponent).join('/');
}

export interface RouteQuery {
  /** Parsed ?relation_id, or null when absent / not a non-negative integer. */
  relation_id: number | null;
  /** Parsed ?path, or null when absent / not a non-negative integer. */
  path: number | null;
}

/** Parses the ?relation_id=&path= query string (accepts a leading '?'). */
export function parseRouteQuery(search: string): RouteQuery {
  const params = new URLSearchParams(search);
  const ridRaw = params.get('relation_id');
  const pathRaw = params.get('path');
  return {
    relation_id: ridRaw !== null && /^\d+$/.test(ridRaw) ? Number(ridRaw) : null,
    path: pathRaw !== null && /^\d+$/.test(pathRaw) ? Number(pathRaw) : null,
  };
}

/**
 * Builds the ?relation_id=&path= search string (with leading '?').
 * Always emits both params so the URL is canonical.
 */
export function buildRouteSearch(relation_id: number, path: number): string {
  return `?relation_id=${relation_id}&path=${path}`;
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
