import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import LocationControl from './components/LocationControl';
import ZoomButtons from './components/ZoomButtons';
import MapView, { FocusRouteRequest } from './components/MapView';
import RoutePanel from './components/RoutePanel';
import NewRoutePanel from './components/NewRoutePanel';
import NamesEditModal from './components/NamesEditModal';
import CoupleRouteModal from './components/CoupleRouteModal';
import TrimRoutePanel from './components/TrimRoutePanel';
import IntersectionPanel from './components/IntersectionPanel';
import { BBox, RouteDoc, RoutePolyline, EndpointInfo, RoadArrow, PendingRoadItem, ExtendModeState, TrimModeState, SectorTrimModeState, LinkModeState, LinkCandidate, Intersection, IntersectionModeState, DisplayIntersectionState, FromScratchState } from './types/route';
import { computeBboxFromGeoJSON, computeRoutePolylines, flattenRoadSectors, rebuildRoadsFromSectorRange, sectorCount } from './utils/routeUtils';
import { getNameVariations } from './utils/nameUtils';
import { buildAddressPath, parseAddressPath, parseRouteQuery, buildRouteSearch } from './utils/addressPath';
import './App.css';

const DEFAULT_CENTER: [number, number] = [36.2048, 138.2529];
const DEFAULT_ZOOM = 6;
const COOKIE_KEY = 'route-editor-state';

interface SavedState {
  selections: string[];
  zoom: number;
  mapCenter: [number, number];
  cityBbox?: BBox;
}

function readCookieState(): SavedState | null {
  try {
    const raw = Cookies.get(COOKIE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedState;
  } catch {
    return null;
  }
}

function writeCookieState(state: SavedState): void {
  Cookies.set(COOKIE_KEY, JSON.stringify(state), { expires: 365 });
}

/**
 * Filter arrow candidates from /api/roads/at-node.
 * The existing route (route_a) is never reversed to fit a candidate, so a
 * one-way road that would have to be driven against its arrow to attach here
 * is dropped — regardless of whether the route already contains one-way roads:
 *   'end'   endpoint + oneway + descend  (to_node=nodeId – can't depart backward)
 *   'start' endpoint + oneway + ascend   (from_node=nodeId – can't arrive backward)
 */
function filterValidArrows(
  arrows: import('./types/route').RoadArrow[],
  endpointType: 'start' | 'end',
): import('./types/route').RoadArrow[] {
  return arrows.filter((a) => {
    if (!a.oneway) return true;
    if (endpointType === 'end'   && a.direction === 'descend') return false;
    if (endpointType === 'start' && a.direction === 'ascend')  return false;
    return true;
  });
}

/** Normalize a raw intersection: legacy `name: string` → `names: string[]`. */
function normalizeIntersection(raw: any): Intersection {
  return {
    ...raw,
    names: Array.isArray(raw.names) ? raw.names : raw.name != null ? [raw.name] : [],
  };
}

/**
 * Group keys of OTHER paths that must receive a mirrored copy of an intersection
 * sitting on `road_id`: paths whose two-way (oneway === false) roads include that
 * same road. Empty unless the clicked road is itself two-way.
 */
function siblingKeysForRoad(state: IntersectionModeState, road_id: number): string[] {
  const road = state.roadItems.find((r: any) => r.road_id === road_id);
  if (!road || road.oneway !== false) return [];
  return Object.entries(state.twoWayRoadIdsByKey)
    .filter(([key, ids]) => key !== state.groups_key && ids.includes(road_id))
    .map(([key]) => key);
}

/**
 * Rewrite every sibling-group copy of intersection `id` via `fn` (return `null`
 * to drop it). Sibling groups that don't mirror `id` are left untouched.
 */
function mapMirroredIntersection(
  siblingGroups: Record<string, Intersection[]>,
  id: number,
  fn: (i: Intersection) => Intersection | null,
): Record<string, Intersection[]> {
  const out: Record<string, Intersection[]> = {};
  for (const [key, arr] of Object.entries(siblingGroups)) {
    out[key] = arr.flatMap((it) => {
      if (it.intersection_id !== id) return [it];
      const next = fn(it);
      return next ? [next] : [];
    });
  }
  return out;
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const savedRef = useRef<SavedState | null>(readCookieState());
  const saved = savedRef.current;

  const [selections, setSelections] = useState<string[]>(saved?.selections ?? []);
  const [zoom, setZoom] = useState<number>(saved?.zoom ?? DEFAULT_ZOOM);
  const [mapCenter, setMapCenter] = useState<[number, number]>(saved?.mapCenter ?? DEFAULT_CENTER);
  const [optionsByLevel, setOptionsByLevel] = useState<{ [level: number]: string[] }>({});
  const [polygon, setPolygon] = useState<object | null>(null);
  const [routePolylines, setRoutePolylines] = useState<RoutePolyline[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [panelMode, setPanelMode] = useState<'routes' | 'newRoute' | 'trim' | 'sectorTrim' | 'intersection'>('routes');
  const [previewRoutes, setPreviewRoutes] = useState<RoutePolyline[]>([]);
  const [cityBbox, setCityBbox] = useState<BBox | null>(saved?.cityBbox ?? null);
  const [editingRelationId, setEditingRelationId] = useState<number | null>(null);
  const [couplingRelationId, setCouplingRelationId] = useState<number | null>(null);
  const [extendMode, setExtendMode] = useState<ExtendModeState | null>(null);
  const [trimMode, setTrimMode] = useState<TrimModeState | null>(null);
  const [isTrimSaving, setIsTrimSaving] = useState(false);
  const [sectorTrimMode, setSectorTrimMode] = useState<SectorTrimModeState | null>(null);
  const [isSectorTrimSaving, setIsSectorTrimSaving] = useState(false);
  const [linkMode, setLinkMode] = useState<LinkModeState | null>(null);
  const [displayIntersections, setDisplayIntersections] = useState<DisplayIntersectionState | null>(null);
  const [intersectionMode, setIntersectionMode] = useState<IntersectionModeState | null>(null);
  const [isIntersectionSaving, setIsIntersectionSaving] = useState(false);
  const [fromScratch, setFromScratch] = useState<FromScratchState | null>(null);
  // Set right after a route is created: selects that route and flies the map to
  // its path 0. `nonce` lets a repeat creation re-trigger the fly.
  const [focusRoute, setFocusRoute] = useState<FocusRouteRequest | null>(null);
  // Bumped after a map context-menu "交差点の追加" persists, to re-run the
  // display-intersection fetch effect below.
  const [intersectionRefreshToken, setIntersectionRefreshToken] = useState(0);

  // Refs for values needed inside callbacks without causing stale closures
  const latestRef  = useRef({ selections, zoom, mapCenter });
  // Blocks the URL-sync effect until the initial mount parsing has run and
  // written its own canonical URL.
  const initializedRef = useRef(false);
  const cityBboxRef = useRef<BBox | null>(saved?.cityBbox ?? null);
  // Whether the deepest currently selected location's boundary doc has
  // properties.motorways_only === true (restricts fetchRoutes to highway_stat.motorway docs).
  const motorwaysOnlyRef = useRef<boolean>(false);
  latestRef.current = { selections, zoom, mapCenter };

  // Close newRoute / trim / intersection panel when zoom drops below 10
  useEffect(() => {
    if (zoom < 10 && (panelMode === 'newRoute' || panelMode === 'trim' || panelMode === 'sectorTrim' || panelMode === 'intersection')) {
      setPanelMode('routes');
      setPreviewRoutes([]);
      setTrimMode(null);
      setIntersectionMode(null);
    }
  }, [zoom, panelMode]);

  // ── API helpers ───────────────────────────────────────────────────────────────

  const fetchOptions = async (
    level: number,
    parents: string[],
  ): Promise<Array<{ id: unknown; name: string }>> => {
    try {
      const parentsParam =
        parents.length > 0 ? `&parents=${encodeURIComponent(parents.join(','))}` : '';
      const res = await fetch(`/api/locations/options?level=${level}${parentsParam}`);
      if (!res.ok) return [];
      const data: Array<{ id: unknown; name: string }> = await res.json();
      setOptionsByLevel((prev) => ({ ...prev, [level]: data.map((d) => d.name) }));
      return data;
    } catch {
      return [];
    }
  };

  /**
   * Fetches a polygon and sets the polygon state.
   * Returns the raw GeoJSON so callers can use it (e.g. for bbox computation).
   */
  const fetchPolygon = async (addresses: string[]): Promise<object | null> => {
    console.log('[App] fetchPolygon called with:', addresses);
    try {
      const url = `/api/locations/polygon?addresses=${encodeURIComponent(addresses.join(','))}`;
      const res = await fetch(url);
      console.log('[App] fetchPolygon response status:', res.status);
      if (!res.ok) {
        setPolygon(null);
        motorwaysOnlyRef.current = false;
        return null;
      }
      const data = await res.json();
      console.log('[App] fetchPolygon geometry type:', (data as any)?.geometry?.type);
      setPolygon(data);
      motorwaysOnlyRef.current = (data as any)?.properties?.motorways_only === true;
      return data;
    } catch (e) {
      console.error('[App] fetchPolygon error:', e);
      setPolygon(null);
      return null;
    }
  };

  const fetchRoutes = async (bbox: BBox): Promise<RoutePolyline[]> => {
    try {
      const params = `minLon=${bbox.minLon}&minLat=${bbox.minLat}&maxLon=${bbox.maxLon}&maxLat=${bbox.maxLat}&motorwaysOnly=${motorwaysOnlyRef.current}`;
      const res = await fetch(`/api/routes/in-bbox?${params}`);
      if (!res.ok) {
        setRoutePolylines([]);
        return [];
      }
      const docs: RouteDoc[] = await res.json();
      console.log('[App] fetchRoutes: received', docs.length, 'routes');
      const polylines = computeRoutePolylines(docs, bbox);
      setRoutePolylines(polylines);
      return polylines;
    } catch (e) {
      console.error('[App] fetchRoutes error:', e);
      setRoutePolylines([]);
      return [];
    }
  };

  // ── Initialisation on mount ───────────────────────────────────────────────────

  useEffect(() => {
    /**
     * Applies the ?relation_id=&path= query against the freshly-fetched route
     * list and selects the matching item in the right panel.
     * Fallback rules:
     *   - no relation_id, or no route with that relation_id  → ignore, return ''
     *   - valid relation_id, path absent / invalid           → path 0
     * Returns the canonical search string to put on the URL ('' when ignored).
     */
    const selectRouteFromQuery = (polylines: RoutePolyline[]): string => {
      const { relation_id, path } = parseRouteQuery(location.search);
      if (relation_id === null) return '';
      const matches = polylines.filter((p) => p.relation_id === relation_id);
      if (matches.length === 0) return '';
      const atRequested =
        path !== null ? matches.find((p) => (p.path_idx ?? 0) === path) : undefined;
      const chosen =
        atRequested ?? matches.find((p) => (p.path_idx ?? 0) === 0) ?? matches[0];
      setSelectedIndex(chosen.index);
      return buildRouteSearch(relation_id, chosen.path_idx ?? 0);
    };

    const init = async () => {
      const level1Data = await fetchOptions(1, []);
      const urlSegments = parseAddressPath(location.pathname);

      if (urlSegments !== null) {
        // URL-driven: walk the path segments, validating each against the
        // real options for its level. Stop at the first segment that has no
        // matching option — everything from there stays unselected.
        const matched: string[] = [];
        let levelData = level1Data;
        for (let i = 0; i < urlSegments.length; i++) {
          const level = i + 1;
          if (level > 1) {
            levelData = await fetchOptions(level, matched);
          }
          const found = levelData.some((d) => d.name === urlSegments[i]);
          if (!found) break;
          matched.push(urlSegments[i]);
        }

        setSelections(matched);

        // Resolved ?relation_id=&path= for the canonical URL. Stays '' (params
        // dropped) unless both location_0/location_1 resolved AND the query
        // points at a real route in the fetched list.
        let routeSearch = '';
        if (matched.length > 0) {
          const geoData = await fetchPolygon(matched);
          if (matched.length >= 2 && geoData) {
            const bbox = computeBboxFromGeoJSON(geoData);
            if (bbox) {
              cityBboxRef.current = bbox;
              setCityBbox(bbox);
              const polylines = await fetchRoutes(bbox);
              routeSearch = selectRouteFromQuery(polylines);
            }
          }
        }

        writeCookieState({
          selections: matched,
          zoom: latestRef.current.zoom,
          mapCenter: latestRef.current.mapCenter,
          cityBbox: matched.length <= 2 ? undefined : cityBboxRef.current ?? undefined,
        });

        // If some trailing segments didn't match, correct the URL to what was
        // actually selected — including the normalised route query.
        const canonicalUrl = buildAddressPath(matched) + routeSearch;
        if (canonicalUrl !== location.pathname + location.search) {
          navigate(canonicalUrl, { replace: true });
        }
        return;
      }

      // Not an /address/... URL: fall back to restoring from the cookie
      const restoredSelections = savedRef.current?.selections ?? [];
      if (restoredSelections.length > 0) {
        for (let i = 2; i <= restoredSelections.length + 1; i++) {
          const data = await fetchOptions(i, restoredSelections.slice(0, i - 1));
          if (data.length === 0) break;
        }

        await fetchPolygon(restoredSelections);

        // Restore routes using the stored city bbox
        const savedBbox = savedRef.current?.cityBbox;
        if (restoredSelections.length >= 2 && savedBbox) {
          cityBboxRef.current = savedBbox;
          await fetchRoutes(savedBbox);
        }
      }

      // Keep the URL in sync with the restored selection. A non-/address URL
      // never carries a valid route query, so any ?relation_id=&path= is dropped.
      const canonicalPath = buildAddressPath(restoredSelections);
      if (canonicalPath !== location.pathname || location.search) {
        navigate(canonicalPath, { replace: true });
      }
    };

    init().finally(() => {
      initializedRef.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ?relation_id=&path= in sync with the route selected from the map view
  // or the right panel. Runs only after the initial mount parsing has settled.
  // The live URL (window.location) is read rather than the router's location so
  // this never clobbers an in-flight /address/... path change from handleSelect.
  useEffect(() => {
    if (!initializedRef.current) return;
    let targetSearch = '';
    if (selectedIndex !== null) {
      const rp = routePolylines.find((p) => p.index === selectedIndex);
      if (rp?.relation_id !== undefined) {
        targetSearch = buildRouteSearch(rp.relation_id, rp.path_idx ?? 0);
      }
    }
    if (targetSearch !== window.location.search) {
      navigate(window.location.pathname + targetSearch, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, routePolylines]);

  // ── Event handlers ────────────────────────────────────────────────────────────

  /** Persists the selection to the cookie and keeps the /address/... URL in sync. */
  const persistSelections = (sel: string[], cityBboxForCookie: BBox | undefined): void => {
    writeCookieState({
      selections: sel,
      zoom: latestRef.current.zoom,
      mapCenter: latestRef.current.mapCenter,
      cityBbox: cityBboxForCookie,
    });
    const target = buildAddressPath(sel);
    if (target !== location.pathname) {
      navigate(target);
    }
  };

  const handleSelect = async (level: number, name: string): Promise<void> => {
    const newSelections = name
      ? [...selections.slice(0, level - 1), name]
      : selections.slice(0, level - 1);

    setSelections(newSelections);
    setPolygon(null);

    setOptionsByLevel((prev) => {
      const next: { [k: number]: string[] } = {};
      for (let i = 1; i <= level; i++) {
        if (prev[i]) next[i] = prev[i];
      }
      return next;
    });

    let geoData: object | null = null;
    if (newSelections.length > 0) {
      geoData = await fetchPolygon(newSelections);
    }

    if (name) {
      await fetchOptions(level + 1, newSelections);
    }

    if (!name) {
      if (level <= 2) {
        cityBboxRef.current = level === 1 ? null : cityBboxRef.current;
        setRoutePolylines([]);
        setSelectedIndex(null);
        setHoveredIndex(null);
      }

      if (level === 2) {
        cityBboxRef.current = null;
      }

      if (level > 2 && cityBboxRef.current) {
        // Deselecting a deeper level may change which boundary's motorways_only
        // applies, even though the city bbox itself is unchanged.
        await fetchRoutes(cityBboxRef.current);
      }

      persistSelections(newSelections, level <= 2 ? undefined : cityBboxRef.current ?? undefined);
      return;
    }

    if (level === 1) {
      // Prefecture changed → clear routes and city bbox
      cityBboxRef.current = null;
      setCityBbox(null);
      setRoutePolylines([]);
      setSelectedIndex(null);
      setHoveredIndex(null);
      setPanelMode('routes');
      setPreviewRoutes([]);
      setTrimMode(null);
      setIntersectionMode(null);
      setDisplayIntersections(null);
      persistSelections(newSelections, undefined);
    } else if (level === 2 && geoData) {
      // City selected → compute bbox and fetch routes
      const bbox = computeBboxFromGeoJSON(geoData);
      if (bbox) {
        cityBboxRef.current = bbox;
        setCityBbox(bbox);
        setSelectedIndex(null);
        setPanelMode('routes');
        setPreviewRoutes([]);
        setTrimMode(null);
        setIntersectionMode(null);
        setDisplayIntersections(null);
        await fetchRoutes(bbox);
        persistSelections(newSelections, bbox);
      }
    } else {
      // Level 3+: city bbox unchanged, but the deeper boundary's motorways_only
      // flag may differ from its parent, so refresh the route filter.
      if (cityBboxRef.current) {
        await fetchRoutes(cityBboxRef.current);
      }
      persistSelections(newSelections, cityBboxRef.current ?? undefined);
    }
  };

  const handleZoomChange = (newZoom: number): void => {
    setZoom(newZoom);
    writeCookieState({
      selections: latestRef.current.selections,
      zoom: newZoom,
      mapCenter: latestRef.current.mapCenter,
      cityBbox: cityBboxRef.current ?? undefined,
    });
  };

  const handleCenterChange = (newCenter: [number, number]): void => {
    setMapCenter(newCenter);
    writeCookieState({
      selections: latestRef.current.selections,
      zoom: latestRef.current.zoom,
      mapCenter: newCenter,
      cityBbox: cityBboxRef.current ?? undefined,
    });
  };

  // ── Route extension handlers ──────────────────────────────────────────────────

  const handleOpenExtendMode = async (relation_id: number): Promise<void> => {
    if (extendMode?.relation_id === relation_id) {
      setExtendMode(null);
      return;
    }
    // Also set this route as selected
    const rp = routePolylines.find((p) => p.relation_id === relation_id);
    if (rp) setSelectedIndex(rp.index);
    try {
      const res = await fetch(`/api/routes/${relation_id}/endpoints`);
      const endpoints: EndpointInfo[] = await res.json();
      setExtendMode({ relation_id, endpoints, modal: null, pending_roads: [], fastForwardResetToken: 0 });
    } catch (e) {
      console.error('[App] failed to fetch endpoints:', e);
    }
  };

  const handleCancelExtend = (): void => {
    if (extendMode && extendMode.pending_roads.length > 0) {
      if (!window.confirm('編集された内容は全て破棄されます。よろしいですか？')) return;
    }
    setExtendMode(null);
  };

  const handleEndpointClick = async (ep: EndpointInfo): Promise<void> => {
    if (!extendMode) return;
    const excludeIds = [ep.road_id, ...extendMode.pending_roads.map((pr) => pr.road_id)];

    // has_oneway = route already has a one-way road (from DB) OR any pending road is one-way
    const hasOneway = ep.has_oneway || extendMode.pending_roads.some((pr) => pr.oneway);
    // has_sub_oneway = the OTHER path already has a one-way road (from DB, unchanged during session)
    const hasSubOneway = ep.has_sub_oneway;

    // Show modal immediately with loading state (arrows = null)
    setExtendMode((prev) => ({
      ...prev!,
      modal: {
        position: [ep.lat, ep.lon],
        node_id: ep.node_id,
        path_idx: ep.path_idx,
        endpoint_type: ep.endpoint,
        has_oneway: hasOneway,
        has_sub_oneway: hasSubOneway,
        arrows: null,
        selected_road_id: null,
        excluded_road_ids: excludeIds,
      },
    }));

    const params = `nodeId=${ep.node_id}&excludeRoadIds=${excludeIds.join(',')}`;
    const res = await fetch(`/api/roads/at-node?${params}`);
    const rawArrows: RoadArrow[] = await res.json();
    const arrows = filterValidArrows(rawArrows, ep.endpoint);

    setExtendMode((prev) => {
      if (!prev?.modal) return prev;
      const autoSelect = arrows.length === 1 ? arrows[0].road_id : null;
      return { ...prev, modal: { ...prev.modal, arrows, selected_road_id: autoSelect } };
    });
  };

  const handleArrowSelect = (roadId: number): void => {
    setExtendMode((prev) => {
      if (!prev?.modal) return prev;
      const newSel = prev.modal.selected_road_id === roadId ? null : roadId;
      return { ...prev, modal: { ...prev.modal, selected_road_id: newSel } };
    });
  };

  const handleForward = async (fastForward = false): Promise<void> => {
    if (!extendMode?.modal?.selected_road_id) return;

    // Capture initial state before any async ops
    let currentArrow: RoadArrow | undefined = extendMode.modal.arrows?.find((a) => a.road_id === extendMode.modal!.selected_road_id);
    if (!currentArrow) return;

    let currentModal = extendMode.modal;
    let accumulatedPendingRoads = [...extendMode.pending_roads];

    // Show loading state immediately
    setExtendMode((prev) => prev ? { ...prev, modal: { ...prev.modal!, arrows: null, selected_road_id: null } } : null);

    // ── Fast-forward loop: process one road per iteration ──────────────────────
    while (true) {
      const arrow: RoadArrow = currentArrow!;

      const newPending: PendingRoadItem = {
        road_id: arrow.road_id,
        direction: arrow.direction,
        oneway: arrow.oneway,
        coords: arrow.coords,
        new_node_id: arrow.new_node_id,
        new_lat: arrow.new_lat,
        new_lon: arrow.new_lon,
      };

      // route_a is never reversed, so the endpoint type stays fixed for the
      // whole fast-forward chain.
      const newEndpointType = currentModal.endpoint_type;
      const newHasOneway = currentModal.has_oneway || arrow.oneway;
      const newHasSubOneway = currentModal.has_sub_oneway;
      const newExcluded = [...currentModal.excluded_road_ids, arrow.road_id];

      accumulatedPendingRoads = [...accumulatedPendingRoads, newPending];

      // Fetch arrows at new node
      const params = `nodeId=${arrow.new_node_id}&excludeRoadIds=${newExcluded.join(',')}`;
      const res = await fetch(`/api/roads/at-node?${params}`);
      const rawArrows: RoadArrow[] = await res.json();
      const newArrows = filterValidArrows(rawArrows, newEndpointType);

      // Update local modal state
      currentModal = {
        ...currentModal,
        endpoint_type: newEndpointType,
        has_oneway: newHasOneway,
        has_sub_oneway: newHasSubOneway,
        position: [arrow.new_lat, arrow.new_lon],
        node_id: arrow.new_node_id,
        excluded_road_ids: newExcluded,
        arrows: newArrows,
        selected_road_id: null,
      };

      // ── Fast-forward condition check ────────────────────────────────────────
      if (fastForward && arrow.name !== '') {
        // Condition 2: exactly one candidate with the same name
        const sameNameCandidates = newArrows.filter((a) => a.name === arrow.name);
        if (sameNameCandidates.length === 1) {
          const candidate = sameNameCandidates[0];
          // Condition 3: angle between candidate bearing and current arrow bearing < 90°
          const diff = Math.abs(arrow.bearing - candidate.bearing);
          const angle = Math.min(diff, 360 - diff);
          if (angle < 90) {
            // All conditions met → auto-select and continue loop
            currentArrow = candidate;
            continue;
          }
        }
      }

      // Fast-forward stops (or was never active) → apply normal single-arrow auto-select
      const autoSelect = newArrows.length === 1 ? newArrows[0].road_id : null;
      currentModal = { ...currentModal, selected_road_id: autoSelect };
      break;
    }

    // ── Commit final state in one update ──────────────────────────────────────
    setExtendMode((prev) => prev ? {
      ...prev,
      pending_roads: accumulatedPendingRoads,
      modal: currentModal,
      // Increment token to signal ExtendRouteOverlay to reset the FF checkbox
      ...(fastForward && { fastForwardResetToken: (prev.fastForwardResetToken ?? 0) + 1 }),
    } : null);
  };

  const handleSaveExtend = async (): Promise<void> => {
    if (!extendMode || extendMode.pending_roads.length === 0) return;
    const newRoadIds = extendMode.pending_roads.map((pr) => pr.road_id);
    const res = await fetch(`/api/routes/${extendMode.relation_id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city_bbox: cityBbox,
        new_road_ids: newRoadIds,
        // Direct extension context – enables bypass of the chaining algorithm
        path_idx: extendMode.modal?.path_idx,
        endpoint_type: extendMode.modal?.endpoint_type,
        pending_roads: extendMode.pending_roads,
      }),
    });
    if (res.ok) {
      if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
      setExtendMode(null);
    }
  };

  // ── Intersection display: fetch when a route is selected ─────────────────────

  useEffect(() => {
    console.log('[intersections displayEffect] selectedIndex=', selectedIndex, 'intersectionMode=', !!intersectionMode);
    if (selectedIndex === null) { setDisplayIntersections(null); return; }
    if (intersectionMode) return;
    const rp = routePolylines.find((p) => p.index === selectedIndex);
    console.log('[intersections displayEffect] rp=', rp ? { relation_id: rp.relation_id, path_idx: rp.path_idx } : null);
    if (!rp?.relation_id) { setDisplayIntersections(null); return; }
    const { relation_id, path_idx = 0 } = rp;
    (async () => {
      try {
        console.log(`[intersections displayEffect] fetching /api/routes/${relation_id}/intersections`);
        const res = await fetch(`/api/routes/${relation_id}/intersections`);
        const data = await res.json();
        console.log('[intersections displayEffect] data=', data);
        const rawKey = (data.routes_keys ?? [])[path_idx];
        const groups_key: string | null = rawKey != null ? String(rawKey) : null;
        const intersections: Intersection[] = groups_key != null
          ? (data.intersection_groups?.[groups_key] ?? []) : [];
        console.log('[intersections displayEffect] groups_key=', groups_key, 'count=', intersections.length);
        setDisplayIntersections({ relation_id, path_idx, groups_key, intersections });
      } catch (e) {
        console.error('[intersections displayEffect] error:', e);
        setDisplayIntersections(null);
      }
    })();
  }, [selectedIndex, routePolylines, intersectionMode, intersectionRefreshToken]);

  // ── Intersection edit mode handlers ──────────────────────────────────────────

  const handleOpenIntersectionMode = async (relation_id: number, path_idx: number): Promise<void> => {
    const rp = routePolylines.find((p) => p.relation_id === relation_id && p.path_idx === path_idx);
    if (rp) setSelectedIndex(rp.index);

    // Open panel immediately with empty state – data fills in asynchronously
    setIntersectionMode({
      relation_id, path_idx,
      groups_key: null,
      originalIntersections: [],
      currentIntersections: [],
      roadItems: [],
      originalGroups: {},
      allRoutesKeys: [],
      nextId: 999000000001,
      siblingGroups: {},
      twoWayRoadIdsByKey: {},
    });
    setPanelMode('intersection');

    try {
      const intRes = await fetch(`/api/routes/${relation_id}/intersections`);
      const intData = await intRes.json();
      const allRoutesKeys: (string | null)[] = intData.routes_keys ?? [];

      // Roads for every path – needed to know which two-way roads are shared
      // between paths so an intersection can be mirrored to sibling groups.
      const roadsByPath: any[][] = await Promise.all(
        allRoutesKeys.map((_, i) =>
          fetch(`/api/routes/${relation_id}/roads?path_idx=${i}`).then((r) => r.json())
        )
      );
      const roadItems: any[] = roadsByPath[path_idx] ?? [];

      // key → road_id[] of oneway === false roads belonging to paths with that key
      const twoWayRoadIdsByKey: Record<string, number[]> = {};
      allRoutesKeys.forEach((rawKey, i) => {
        if (rawKey == null) return;
        const key = String(rawKey);
        const set = twoWayRoadIdsByKey[key] ?? (twoWayRoadIdsByKey[key] = []);
        for (const road of roadsByPath[i] ?? []) {
          if (road?.oneway === false && !set.includes(road.road_id)) set.push(road.road_id);
        }
      });

      console.log('[handleOpenIntersectionMode] intData=', intData, 'roadItems.length=', roadItems.length);
      const rawKey = allRoutesKeys[path_idx];
      const groups_key: string | null = rawKey != null ? String(rawKey) : null;
      const originalGroups: Record<string, Intersection[]> = intData.intersection_groups ?? {};
      const originalIntersections: Intersection[] = groups_key != null
        ? (originalGroups[groups_key] ?? []).map(normalizeIntersection) : [];
      console.log('[handleOpenIntersectionMode] groups_key=', groups_key, 'intersections=', originalIntersections.length);
      const allIds = Object.values(originalGroups).flat().map((i: any) => i.intersection_id);
      const nextId = Math.max(999000000000, ...allIds) + 1;
      setIntersectionMode({
        relation_id, path_idx, groups_key, originalIntersections,
        currentIntersections: [...originalIntersections], roadItems, originalGroups, allRoutesKeys, nextId,
        siblingGroups: {}, twoWayRoadIdsByKey,
      });
    } catch (e) {
      console.error('[App] handleOpenIntersectionMode error:', e);
    }
  };

  const handleCancelIntersectionMode = (): void => {
    const isDirty = intersectionMode &&
      JSON.stringify(intersectionMode.currentIntersections) !==
      JSON.stringify(intersectionMode.originalIntersections);
    if (isDirty && !window.confirm('変更した内容は破棄されます。よろしいですか？')) return;
    setIntersectionMode(null);
    setPanelMode('routes');
  };

  const handleSaveIntersections = async (): Promise<void> => {
    if (!intersectionMode) return;
    setIsIntersectionSaving(true);
    try {
      const { relation_id, path_idx, groups_key, currentIntersections, originalGroups, siblingGroups } = intersectionMode;
      const routes_key_updates: { path_idx: number; key: string }[] = [];
      let effectiveKey = groups_key;
      if (!effectiveKey) {
        effectiveKey = String(Object.keys(originalGroups).length);
        routes_key_updates.push({ path_idx, key: effectiveKey });
      }
      // siblingGroups holds only the sibling paths mirrored into; the current
      // path's own edits are applied last so they always win.
      const newGroups = { ...originalGroups, ...siblingGroups, [effectiveKey]: currentIntersections };
      const res = await fetch(`/api/routes/${relation_id}/intersections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intersection_groups: newGroups, routes_key_updates }),
      });
      if (res.ok) {
        if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
        setIntersectionMode(null);
        setPanelMode('routes');
      }
    } finally { setIsIntersectionSaving(false); }
  };

  const handleIntersectionAdd = (
    snap: { road_id: number; coord_index: number; lat: number; lon: number },
    names: string[],
    highway_tag: string | null,
  ): void => {
    console.log('[handleIntersectionAdd] snap=', snap, 'names=', names, 'highway_tag=', highway_tag);
    setIntersectionMode((prev) => {
      if (!prev) { console.log('[handleIntersectionAdd] intersectionMode is null!'); return prev; }
      const newItem: Intersection = { intersection_id: prev.nextId, names, ...snap, highway_tag };
      console.log('[handleIntersectionAdd] adding', newItem, 'total will be', prev.currentIntersections.length + 1);
      // When the road is two-way and shared with another path, mirror the same
      // intersection into that path's intersection group as well.
      const siblingGroups = { ...prev.siblingGroups };
      for (const key of siblingKeysForRoad(prev, snap.road_id)) {
        const base = key in siblingGroups
          ? siblingGroups[key]
          : (prev.originalGroups[key] ?? []).map(normalizeIntersection);
        siblingGroups[key] = base.some((i) => i.intersection_id === newItem.intersection_id)
          ? base
          : [...base, newItem];
      }
      return {
        ...prev,
        currentIntersections: [...prev.currentIntersections, newItem],
        siblingGroups,
        nextId: prev.nextId + 1,
      };
    });
  };

  const handleIntersectionDelete = (id: number): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        currentIntersections: prev.currentIntersections.filter((i) => i.intersection_id !== id),
        siblingGroups: mapMirroredIntersection(prev.siblingGroups, id, () => null),
      };
    });
  };

  const handleIntersectionRename = (id: number, names: string[], highway_tag: string | null): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        currentIntersections: prev.currentIntersections.map((i) =>
          i.intersection_id === id ? { ...i, names, highway_tag } : i),
        siblingGroups: mapMirroredIntersection(prev.siblingGroups, id, (i) => ({ ...i, names, highway_tag })),
      };
    });
  };

  const handleIntersectionMove = (
    id: number,
    snap: { road_id: number; coord_index: number; lat: number; lon: number },
  ): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      // Keep any mirrored copies in sync with the moved position/road.
      return {
        ...prev,
        currentIntersections: prev.currentIntersections.map((i) =>
          i.intersection_id === id ? { ...i, ...snap } : i),
        siblingGroups: mapMirroredIntersection(prev.siblingGroups, id, (i) => ({ ...i, ...snap })),
      };
    });
  };

  /**
   * Map context-menu "交差点の追加" while a route is only selected (not in the
   * right-panel intersection editor). Persists the new intersection to
   * osm.jproad_routes immediately, then refreshes the displayed markers.
   * Resolves only once the DB write + refetch have completed so the caller can
   * keep its modal open until then.
   */
  const handleQuickAddIntersection = async (
    lat: number,
    lon: number,
    names: string[],
    highway_tag: string | null,
  ): Promise<void> => {
    if (!displayIntersections) return;
    const { relation_id, path_idx } = displayIntersections;
    try {
      const res = await fetch(`/api/routes/${relation_id}/intersections/point`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path_idx, lat, lon, names, highway_tag }),
      });
      if (!res.ok) {
        console.error('[handleQuickAddIntersection] server error:', await res.text());
        return;
      }
      setIntersectionRefreshToken((t) => t + 1);
    } catch (e) {
      console.error('[handleQuickAddIntersection] error:', e);
    }
  };

  /**
   * After a route is created, select its path 0 in the right panel (which
   * auto-scrolls the list to it) and ask the map to fly to that path.
   */
  const focusNewRoute = (polylines: RoutePolyline[], relation_id: number): void => {
    const match =
      polylines.find((p) => p.relation_id === relation_id && (p.path_idx ?? 0) === 0) ??
      polylines.find((p) => p.relation_id === relation_id);
    if (!match) return;
    setSelectedIndex(match.index);
    setFocusRoute({ relation_id, path_idx: match.path_idx ?? 0, nonce: Date.now() });
  };

  // ── From-scratch handlers ────────────────────────────────────────────────────

  const handleEnterScratch = (query: string): void => {
    setFromScratch({ query, road: null });
  };

  const handleExitScratch = (): void => {
    setFromScratch(null);
  };

  const handleScratchRoadSelected = (road: FromScratchState['road']): void => {
    setFromScratch((prev) => prev ? { ...prev, road } : prev);
  };

  const handleSaveScratch = async (): Promise<void> => {
    if (!fromScratch?.road) return;
    const viewBbox = cityBbox;
    if (!viewBbox) return;

    const names = getNameVariations(fromScratch.query);

    const res = await fetch('/api/routes/from-scratch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ road_id: fromScratch.road.road_id, names, viewBbox }),
    });
    if (!res.ok) {
      console.error('[handleSaveScratch] server error:', await res.text());
      return;
    }
    const { relation_id } = await res.json();
    setFromScratch(null);
    const polylines = cityBboxRef.current ? await fetchRoutes(cityBboxRef.current) : [];
    setPanelMode('routes');
    setPreviewRoutes([]);
    focusNewRoute(polylines, relation_id);
  };

  // ── Route trim handlers ────────────────────────────────────────────────────────

  const handleOpenTrimMode = async (relation_id: number, path_idx: number): Promise<void> => {
    const rp = routePolylines.find((p) => p.relation_id === relation_id && p.path_idx === path_idx);
    if (rp) setSelectedIndex(rp.index);
    try {
      const res = await fetch(`/api/routes/${relation_id}/roads?path_idx=${path_idx}`);
      const roads: any[] = await res.json();
      setTrimMode({ relation_id, path_idx, originalRoads: roads, currentRoads: roads, trimmedFromStart: [], trimmedFromEnd: [] });
      setPanelMode('trim');
    } catch (e) {
      console.error('[App] failed to fetch road items for trim:', e);
    }
  };

  // targetIndex is a global index into trimMode.originalRoads. Moving it toward the
  // opposite end cuts further roads; moving it back toward the original endpoint
  // restores previously-trimmed roads (drag onto the gray dashed line to undo).
  const handleTrimStart = (targetIndex: number): void => {
    setTrimMode((prev) => {
      if (!prev) return prev;
      const n = prev.originalRoads.length;
      const maxStart = n - prev.trimmedFromEnd.length - 1;
      const startCount = Math.max(0, Math.min(targetIndex, maxStart));
      const endCount = prev.trimmedFromEnd.length;
      return {
        ...prev,
        trimmedFromStart: prev.originalRoads.slice(0, startCount),
        currentRoads: prev.originalRoads.slice(startCount, n - endCount),
      };
    });
  };

  const handleTrimEnd = (targetIndex: number): void => {
    setTrimMode((prev) => {
      if (!prev) return prev;
      const n = prev.originalRoads.length;
      const startCount = prev.trimmedFromStart.length;
      const lastKeptIdx = Math.max(startCount, Math.min(targetIndex, n - 1));
      const endCount = n - 1 - lastKeptIdx;
      return {
        ...prev,
        trimmedFromEnd: prev.originalRoads.slice(n - endCount),
        currentRoads: prev.originalRoads.slice(startCount, n - endCount),
      };
    });
  };

  const handleSaveTrim = async (): Promise<void> => {
    if (!trimMode) return;
    setIsTrimSaving(true);
    try {
      const res = await fetch(`/api/routes/${trimMode.relation_id}/trim`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path_idx: trimMode.path_idx, new_roads: trimMode.currentRoads }),
      });
      if (res.ok) {
        if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
        setTrimMode(null);
        setPanelMode('routes');
      }
    } finally {
      setIsTrimSaving(false);
    }
  };

  const handleCancelTrim = (): void => {
    const isDirty =
      trimMode ? trimMode.trimmedFromStart.length > 0 || trimMode.trimmedFromEnd.length > 0 : false;
    if (isDirty && !window.confirm('編集された内容は全て破棄されます。よろしいですか？')) return;
    setTrimMode(null);
    setPanelMode('routes');
  };

  // ── Sector-level trim handlers ────────────────────────────────────────────────

  const handleOpenSectorTrimMode = async (relation_id: number, path_idx: number): Promise<void> => {
    const rp = routePolylines.find((p) => p.relation_id === relation_id && p.path_idx === path_idx);
    if (rp) setSelectedIndex(rp.index);
    try {
      const res = await fetch(`/api/routes/${relation_id}/roads?path_idx=${path_idx}`);
      const roads: any[] = await res.json();
      setSectorTrimMode({ relation_id, path_idx, originalRoads: roads, currentRoads: roads, trimmedFromStart: [], trimmedFromEnd: [] });
      setPanelMode('sectorTrim');
    } catch (e) {
      console.error('[App] failed to fetch road items for sector trim:', e);
    }
  };

  // targetSectorIndex is a global sector index into the flattened sectors of
  // sectorTrimMode.originalRoads. Same drag/restore model as the road-level trim
  // (handleTrimStart/handleTrimEnd), but at road_sector ("node") granularity, so a
  // single drag only ever advances/retreats the boundary through the current
  // first/last road's sectors — never jumps a whole road at once.
  const handleSectorTrimStart = (targetSectorIndex: number): void => {
    setSectorTrimMode((prev) => {
      if (!prev) return prev;
      const flat = flattenRoadSectors(prev.originalRoads);
      const n = flat.length;
      const endCount = sectorCount(prev.trimmedFromEnd);
      const maxStart = n - endCount - 1;
      const startCount = Math.max(0, Math.min(targetSectorIndex, maxStart));
      return {
        ...prev,
        trimmedFromStart: rebuildRoadsFromSectorRange(prev.originalRoads, flat, 0, startCount),
        currentRoads: rebuildRoadsFromSectorRange(prev.originalRoads, flat, startCount, n - endCount),
      };
    });
  };

  const handleSectorTrimEnd = (targetSectorIndex: number): void => {
    setSectorTrimMode((prev) => {
      if (!prev) return prev;
      const flat = flattenRoadSectors(prev.originalRoads);
      const n = flat.length;
      const startCount = sectorCount(prev.trimmedFromStart);
      const lastKeptIdx = Math.max(startCount, Math.min(targetSectorIndex, n - 1));
      const endCount = n - 1 - lastKeptIdx;
      return {
        ...prev,
        trimmedFromEnd: rebuildRoadsFromSectorRange(prev.originalRoads, flat, n - endCount, n),
        currentRoads: rebuildRoadsFromSectorRange(prev.originalRoads, flat, startCount, n - endCount),
      };
    });
  };

  const handleSaveSectorTrim = async (): Promise<void> => {
    if (!sectorTrimMode) return;
    setIsSectorTrimSaving(true);
    try {
      const { relation_id, path_idx, currentRoads } = sectorTrimMode;
      const res = await fetch(`/api/routes/${relation_id}/sector-trim`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path_idx, new_roads: currentRoads }),
      });
      if (res.ok) {
        setSectorTrimMode(null);
        setPanelMode('routes');
        if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
      }
    } catch (e) {
      console.error('[App] sector trim save error:', e);
    } finally {
      setIsSectorTrimSaving(false);
    }
  };

  const handleCancelSectorTrim = (): void => {
    const isDirty = sectorTrimMode
      ? JSON.stringify(sectorTrimMode.currentRoads) !== JSON.stringify(sectorTrimMode.originalRoads)
      : false;
    if (isDirty && !window.confirm('編集された内容は全て破棄されます。よろしいですか？')) return;
    setSectorTrimMode(null);
    setPanelMode('routes');
  };

  // ── Route link handlers ───────────────────────────────────────────────────────

  const handleOpenLinkMode = async (relation_id: number, path_idx: number): Promise<void> => {
    if (linkMode?.relation_id === relation_id && linkMode?.path_idx === path_idx) {
      setLinkMode(null);
      return;
    }
    const rp = routePolylines.find((p) => p.relation_id === relation_id && p.path_idx === path_idx);
    if (rp) setSelectedIndex(rp.index);
    try {
      const res = await fetch(`/api/routes/${relation_id}/endpoints`);
      const endpoints: EndpointInfo[] = await res.json();
      const startEp = endpoints.find((e) => e.path_idx === path_idx && e.endpoint === 'start');
      const endEp = endpoints.find((e) => e.path_idx === path_idx && e.endpoint === 'end');
      if (!startEp || !endEp) return;
      setLinkMode({
        relation_id,
        path_idx,
        startPos: [startEp.lat, startEp.lon],
        startNodeId: startEp.node_id,
        endPos: [endEp.lat, endEp.lon],
        endNodeId: endEp.node_id,
        clickedEndpoint: null,
        status: 'idle',
        candidates: null,
        selectedCandidateRelationId: null,
      });
    } catch (e) {
      console.error('[App] failed to fetch endpoints for link:', e);
    }
  };

  const handleLinkEndpointClick = async (endpoint: 'start' | 'end'): Promise<void> => {
    if (!linkMode) return;
    const { relation_id, path_idx } = linkMode;
    const node_id = endpoint === 'start' ? linkMode.startNodeId : linkMode.endNodeId;
    setLinkMode((prev) => prev
      ? { ...prev, clickedEndpoint: endpoint, status: 'fetching', candidates: null, selectedCandidateRelationId: null }
      : prev);
    try {
      const res = await fetch(`/api/routes/${relation_id}/find-linkable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id, endpoint_type: endpoint }),
      });
      const candidates: LinkCandidate[] = await res.json();
      setLinkMode((prev) => (prev && prev.relation_id === relation_id && prev.path_idx === path_idx)
        ? { ...prev, status: 'done', candidates }
        : prev);
    } catch (e) {
      console.error('[App] find-linkable error:', e);
      setLinkMode((prev) => prev ? { ...prev, status: 'done', candidates: [] } : prev);
    }
  };

  const handleLinkSelectCandidate = (relation_id: number): void => {
    setLinkMode((prev) => prev ? { ...prev, selectedCandidateRelationId: relation_id } : prev);
  };

  const handleResetLinkModal = (): void => {
    setLinkMode((prev) => prev
      ? { ...prev, clickedEndpoint: null, status: 'idle', candidates: null, selectedCandidateRelationId: null }
      : prev);
  };

  const handleConfirmLink = async (): Promise<void> => {
    if (!linkMode || !linkMode.clickedEndpoint || !linkMode.selectedCandidateRelationId) return;
    const candidate = linkMode.candidates?.find((c) => c.relation_id === linkMode.selectedCandidateRelationId);
    if (!candidate) return;
    try {
      const res = await fetch(`/api/routes/${linkMode.relation_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path_idx: linkMode.path_idx,
          endpoint_type: linkMode.clickedEndpoint,
          candidate_relation_id: candidate.relation_id,
          candidate_path_idx: candidate.path_idx,
          reverse: candidate.reverse,
        }),
      });
      if (res.ok) {
        setLinkMode(null);
        if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
      }
    } catch (e) {
      console.error('[App] link confirm error:', e);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────────

  const nextLevel = selections.length + 1;
  const numDropdowns =
    (optionsByLevel[nextLevel]?.length ?? 0) > 0
      ? nextLevel
      : Math.max(1, selections.length);

  return (
    <div className="app">
      <LocationControl
        selections={selections}
        optionsByLevel={optionsByLevel}
        numDropdowns={numDropdowns}
        onSelect={handleSelect}
      />
      <ZoomButtons zoom={zoom} onZoomChange={handleZoomChange} />
      <div className="content-area">
        <MapView
          center={mapCenter}
          zoom={zoom}
          polygon={polygon}
          polygonKey={selections.join(',')}
          routePolylines={routePolylines}
          previewRoutes={previewRoutes}
          hoveredIndex={hoveredIndex}
          selectedIndex={selectedIndex}
          extendMode={extendMode}
          trimMode={trimMode}
          sectorTrimMode={sectorTrimMode}
          intersections={intersectionMode?.currentIntersections ?? displayIntersections?.intersections ?? []}
          intersectionRoutePolyline={(() => {
            const rid = intersectionMode?.relation_id ?? displayIntersections?.relation_id;
            const pidx = intersectionMode?.path_idx ?? displayIntersections?.path_idx;
            return rid !== undefined
              ? routePolylines.find((rp) => rp.relation_id === rid && rp.path_idx === pidx) ?? null
              : null;
          })()}
          isIntersectionEditMode={!!intersectionMode}
          intersectionRoadItems={intersectionMode?.roadItems ?? []}
          onHoveredIndexChange={setHoveredIndex}
          onSelectedIndexChange={(index) =>
            setSelectedIndex((prev) => (prev === index ? null : index))
          }
          onEndpointClick={handleEndpointClick}
          onArrowSelect={handleArrowSelect}
          onForward={handleForward}
          onSaveAndClose={handleSaveExtend}
          onCancelExtend={handleCancelExtend}
          onTrimStart={handleTrimStart}
          onTrimEnd={handleTrimEnd}
          onSectorTrimStart={handleSectorTrimStart}
          onSectorTrimEnd={handleSectorTrimEnd}
          linkMode={linkMode}
          onLinkEndpointClick={handleLinkEndpointClick}
          onLinkSelectCandidate={handleLinkSelectCandidate}
          onConfirmLink={handleConfirmLink}
          onDismissLinkModal={handleResetLinkModal}
          onCancelLink={handleResetLinkModal}
          onIntersectionAdd={handleIntersectionAdd}
          onIntersectionQuickAdd={panelMode === 'routes' ? handleQuickAddIntersection : undefined}
          onIntersectionDelete={handleIntersectionDelete}
          onIntersectionRename={handleIntersectionRename}
          onIntersectionMove={handleIntersectionMove}
          onCenterChange={handleCenterChange}
          onZoomChange={handleZoomChange}
          fromScratch={fromScratch}
          onScratchRoadSelected={handleScratchRoadSelected}
          focusRoute={focusRoute}
        />
        {panelMode === 'routes' ? (
          <RoutePanel
            routePolylines={routePolylines}
            hoveredIndex={hoveredIndex}
            selectedIndex={selectedIndex}
            zoom={zoom}
            citySelected={selections.length >= 2}
            onSelect={(index) =>
              setSelectedIndex((prev) => (prev === index ? null : index))
            }
            onNewRoute={() => setPanelMode('newRoute')}
            onEditNames={(rid) => setEditingRelationId(rid)}
            onExtendRoute={handleOpenExtendMode}
            extendingRelationId={extendMode?.relation_id}
            onTrimRoute={handleOpenTrimMode}
            trimmingRelationId={trimMode?.relation_id}
            onSectorTrimRoute={handleOpenSectorTrimMode}
            sectorTrimmingRelationId={sectorTrimMode?.relation_id}
            onLinkRoute={handleOpenLinkMode}
            linkingRelationId={linkMode?.relation_id}
            onIntersectionRoute={handleOpenIntersectionMode}
            intersectionRelationId={intersectionMode?.relation_id}
            onCoupleRoute={(rid) => setCouplingRelationId(rid)}
          />
        ) : panelMode === 'trim' ? (
          <TrimRoutePanel
            isDirty={!!(trimMode && (trimMode.trimmedFromStart.length > 0 || trimMode.trimmedFromEnd.length > 0))}
            isSaving={isTrimSaving}
            onSave={handleSaveTrim}
            onCancel={handleCancelTrim}
            onClose={handleCancelTrim}
          />
        ) : panelMode === 'sectorTrim' ? (
          <TrimRoutePanel
            isDirty={!!(sectorTrimMode &&
              JSON.stringify(sectorTrimMode.currentRoads) !== JSON.stringify(sectorTrimMode.originalRoads))}
            isSaving={isSectorTrimSaving}
            onSave={handleSaveSectorTrim}
            onCancel={handleCancelSectorTrim}
            onClose={handleCancelSectorTrim}
          />
        ) : panelMode === 'intersection' ? (
          <IntersectionPanel
            isDirty={!!(intersectionMode &&
              JSON.stringify(intersectionMode.currentIntersections) !==
              JSON.stringify(intersectionMode.originalIntersections))}
            isSaving={isIntersectionSaving}
            onSave={handleSaveIntersections}
            onCancel={handleCancelIntersectionMode}
            onClose={handleCancelIntersectionMode}
          />
        ) : (
          <NewRoutePanel
            cityBbox={cityBbox}
            routePolylines={routePolylines}
            fromScratch={fromScratch}
            onClose={() => {
              setPanelMode('routes');
              setPreviewRoutes([]);
              setFromScratch(null);
            }}
            onPreviewRoutes={setPreviewRoutes}
            onExistingRouteSelect={(index) => {
              setSelectedIndex((prev) => (prev === index ? null : index));
              setPanelMode('routes');
              setPreviewRoutes([]);
            }}
            onSaved={async (relation_id: number) => {
              const polylines = cityBboxRef.current ? await fetchRoutes(cityBboxRef.current) : [];
              setPanelMode('routes');
              setPreviewRoutes([]);
              focusNewRoute(polylines, relation_id);
            }}
            onEnterScratch={handleEnterScratch}
            onExitScratch={handleExitScratch}
            onSaveScratch={handleSaveScratch}
          />
        )}
      </div>
      {editingRelationId !== null && (
        <NamesEditModal
          relation_id={editingRelationId}
          onClose={() => setEditingRelationId(null)}
          onSaved={async () => {
            if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
            setEditingRelationId(null);
          }}
        />
      )}
      {couplingRelationId !== null && (
        <CoupleRouteModal
          relation_id={couplingRelationId}
          routePolylines={routePolylines}
          onClose={() => setCouplingRelationId(null)}
          onCoupled={async () => {
            if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
            setCouplingRelationId(null);
          }}
        />
      )}
    </div>
  );
}

export default App;
