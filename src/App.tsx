import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import LocationControl from './components/LocationControl';
import ZoomButtons from './components/ZoomButtons';
import MapView from './components/MapView';
import RoutePanel from './components/RoutePanel';
import NewRoutePanel from './components/NewRoutePanel';
import NamesEditModal from './components/NamesEditModal';
import TrimRoutePanel from './components/TrimRoutePanel';
import IntersectionPanel from './components/IntersectionPanel';
import { BBox, RouteDoc, RoutePolyline, EndpointInfo, RoadArrow, PendingRoadItem, ExtendModeState, TrimModeState, SectorTrimModeState, LinkModeState, LinkCandidate, Intersection, IntersectionModeState, DisplayIntersectionState, FromScratchState } from './types/route';
import { computeBboxFromGeoJSON, computeRoutePolylines } from './utils/routeUtils';
import { getNameVariations } from './utils/nameUtils';
import { buildAddressPath, parseAddressPath } from './utils/addressPath';
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
 * When either the primary path or the reverse path already has one-way roads,
 * hide one-way arrows that would be skipped on the server (physically invalid
 * or would break reverse_roads on the sub-path):
 *   'end'   endpoint + oneway + descend  (to_node=nodeId – can't depart backward)
 *   'start' endpoint + oneway + ascend   (from_node=nodeId – can't arrive backward)
 */
function filterValidArrows(
  arrows: import('./types/route').RoadArrow[],
  endpointType: 'start' | 'end',
  hasOneway: boolean,
  hasSubOneway: boolean,
): import('./types/route').RoadArrow[] {
  if (!hasOneway && !hasSubOneway) return arrows;
  return arrows.filter((a) => {
    if (!a.oneway) return true;
    if (endpointType === 'end'   && a.direction === 'descend') return false;
    if (endpointType === 'start' && a.direction === 'ascend')  return false;
    return true;
  });
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

  // Refs for values needed inside callbacks without causing stale closures
  const latestRef  = useRef({ selections, zoom, mapCenter });
  const cityBboxRef = useRef<BBox | null>(saved?.cityBbox ?? null);
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
        return null;
      }
      const data = await res.json();
      console.log('[App] fetchPolygon geometry type:', (data as any)?.geometry?.type);
      setPolygon(data);
      return data;
    } catch (e) {
      console.error('[App] fetchPolygon error:', e);
      setPolygon(null);
      return null;
    }
  };

  const fetchRoutes = async (bbox: BBox): Promise<void> => {
    try {
      const params = `minLon=${bbox.minLon}&minLat=${bbox.minLat}&maxLon=${bbox.maxLon}&maxLat=${bbox.maxLat}`;
      const res = await fetch(`/api/routes/in-bbox?${params}`);
      if (!res.ok) {
        setRoutePolylines([]);
        return;
      }
      const docs: RouteDoc[] = await res.json();
      console.log('[App] fetchRoutes: received', docs.length, 'routes');
      setRoutePolylines(computeRoutePolylines(docs, bbox));
    } catch (e) {
      console.error('[App] fetchRoutes error:', e);
      setRoutePolylines([]);
    }
  };

  // ── Initialisation on mount ───────────────────────────────────────────────────

  useEffect(() => {
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

        if (matched.length > 0) {
          const geoData = await fetchPolygon(matched);
          if (matched.length >= 2 && geoData) {
            const bbox = computeBboxFromGeoJSON(geoData);
            if (bbox) {
              cityBboxRef.current = bbox;
              setCityBbox(bbox);
              await fetchRoutes(bbox);
            }
          }
        }

        writeCookieState({
          selections: matched,
          zoom: latestRef.current.zoom,
          mapCenter: latestRef.current.mapCenter,
          cityBbox: matched.length <= 2 ? undefined : cityBboxRef.current ?? undefined,
        });

        // If some trailing segments didn't match, correct the URL to what was actually selected
        const canonicalPath = buildAddressPath(matched);
        if (canonicalPath !== location.pathname) {
          navigate(canonicalPath, { replace: true });
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

      // Keep the URL in sync with the restored selection
      const canonicalPath = buildAddressPath(restoredSelections);
      if (canonicalPath !== location.pathname) {
        navigate(canonicalPath, { replace: true });
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Level 3+: routes unchanged, just update cookie and URL
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
    const arrows = filterValidArrows(rawArrows, ep.endpoint, hasOneway, hasSubOneway);

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

      const isSpecialReverse = !currentModal.has_oneway && !currentModal.has_sub_oneway && arrow.oneway && (
        (currentModal.endpoint_type === 'end'   && arrow.direction === 'descend') ||
        (currentModal.endpoint_type === 'start' && arrow.direction === 'ascend')
      );
      const newHasOneway = currentModal.has_oneway || arrow.oneway;
      const newHasSubOneway = currentModal.has_sub_oneway;
      const newEndpointType: 'start' | 'end' = isSpecialReverse
        ? (currentModal.endpoint_type === 'end' ? 'start' : 'end')
        : currentModal.endpoint_type;
      const newExcluded = [...currentModal.excluded_road_ids, arrow.road_id];

      accumulatedPendingRoads = [...accumulatedPendingRoads, newPending];

      // Fetch arrows at new node
      const params = `nodeId=${arrow.new_node_id}&excludeRoadIds=${newExcluded.join(',')}`;
      const res = await fetch(`/api/roads/at-node?${params}`);
      const rawArrows: RoadArrow[] = await res.json();
      const newArrows = filterValidArrows(rawArrows, newEndpointType, newHasOneway, newHasSubOneway);

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
  }, [selectedIndex, routePolylines, intersectionMode]);

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
    });
    setPanelMode('intersection');

    try {
      const [intRes, roadsRes] = await Promise.all([
        fetch(`/api/routes/${relation_id}/intersections`),
        fetch(`/api/routes/${relation_id}/roads?path_idx=${path_idx}`),
      ]);
      const intData = await intRes.json();
      const roadItems: any[] = await roadsRes.json();
      console.log('[handleOpenIntersectionMode] intData=', intData, 'roadItems.length=', roadItems.length);
      const allRoutesKeys: (string | null)[] = intData.routes_keys ?? [];
      const rawKey = allRoutesKeys[path_idx];
      const groups_key: string | null = rawKey != null ? String(rawKey) : null;
      const originalGroups: Record<string, Intersection[]> = intData.intersection_groups ?? {};
      // Normalize legacy name: string → names: string[]
      const normalizeIntersection = (raw: any): Intersection => ({
        ...raw,
        names: Array.isArray(raw.names) ? raw.names
          : raw.name != null ? [raw.name] : [],
      });
      const originalIntersections: Intersection[] = groups_key != null
        ? (originalGroups[groups_key] ?? []).map(normalizeIntersection) : [];
      console.log('[handleOpenIntersectionMode] groups_key=', groups_key, 'intersections=', originalIntersections.length);
      const allIds = Object.values(originalGroups).flat().map((i: any) => i.intersection_id);
      const nextId = Math.max(999000000000, ...allIds) + 1;
      setIntersectionMode({
        relation_id, path_idx, groups_key, originalIntersections,
        currentIntersections: [...originalIntersections], roadItems, originalGroups, allRoutesKeys, nextId,
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
      const { relation_id, path_idx, groups_key, currentIntersections, originalGroups } = intersectionMode;
      const routes_key_updates: { path_idx: number; key: string }[] = [];
      let effectiveKey = groups_key;
      if (!effectiveKey) {
        effectiveKey = String(Object.keys(originalGroups).length);
        routes_key_updates.push({ path_idx, key: effectiveKey });
      }
      const newGroups = { ...originalGroups, [effectiveKey]: currentIntersections };
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
      return { ...prev, currentIntersections: [...prev.currentIntersections, newItem], nextId: prev.nextId + 1 };
    });
  };

  const handleIntersectionDelete = (id: number): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      return { ...prev, currentIntersections: prev.currentIntersections.filter((i) => i.intersection_id !== id) };
    });
  };

  const handleIntersectionRename = (id: number, names: string[], highway_tag: string | null): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      return { ...prev, currentIntersections: prev.currentIntersections.map((i) =>
        i.intersection_id === id ? { ...i, names, highway_tag } : i) };
    });
  };

  const handleIntersectionMove = (
    id: number,
    snap: { road_id: number; coord_index: number; lat: number; lon: number },
  ): void => {
    setIntersectionMode((prev) => {
      if (!prev) return prev;
      return { ...prev, currentIntersections: prev.currentIntersections.map((i) =>
        i.intersection_id === id ? { ...i, ...snap } : i) };
    });
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
    if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
    setPanelMode('routes');
    setPreviewRoutes([]);
    // Select the newly created route (routePolylines updates after fetchRoutes resolves)
    setRoutePolylines((prev) => {
      const match = prev.find((p) => p.relation_id === relation_id);
      if (match) setSelectedIndex(match.index);
      return prev;
    });
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

  const handleTrimStart = (): void => {
    setTrimMode((prev) => {
      if (!prev || prev.currentRoads.length <= 1) return prev;
      return {
        ...prev,
        trimmedFromStart: [...prev.trimmedFromStart, prev.currentRoads[0]],
        currentRoads: prev.currentRoads.slice(1),
      };
    });
  };

  const handleTrimEnd = (): void => {
    setTrimMode((prev) => {
      if (!prev || prev.currentRoads.length <= 1) return prev;
      const last = prev.currentRoads[prev.currentRoads.length - 1];
      return {
        ...prev,
        trimmedFromEnd: [last, ...prev.trimmedFromEnd],
        currentRoads: prev.currentRoads.slice(0, -1),
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
      setSectorTrimMode({ relation_id, path_idx, originalRoads: roads, currentRoads: roads });
      setPanelMode('sectorTrim');
    } catch (e) {
      console.error('[App] failed to fetch road items for sector trim:', e);
    }
  };

  const handleSectorTrimStart = (): void => {
    setSectorTrimMode((prev) => {
      if (!prev || !prev.currentRoads.length) return prev;
      const firstRoad = prev.currentRoads[0];
      const newSectors = (firstRoad.road_sectors || []).slice(1);
      let newRoads;
      if (newSectors.length === 0) {
        newRoads = prev.currentRoads.slice(1);
      } else {
        newRoads = [{ ...firstRoad, road_sectors: newSectors }, ...prev.currentRoads.slice(1)];
      }
      return { ...prev, currentRoads: newRoads };
    });
  };

  const handleSectorTrimEnd = (): void => {
    setSectorTrimMode((prev) => {
      if (!prev || !prev.currentRoads.length) return prev;
      const lastRoad = prev.currentRoads[prev.currentRoads.length - 1];
      const newSectors = (lastRoad.road_sectors || []).slice(0, -1);
      let newRoads;
      if (newSectors.length === 0) {
        newRoads = prev.currentRoads.slice(0, -1);
      } else {
        newRoads = [...prev.currentRoads.slice(0, -1), { ...lastRoad, road_sectors: newSectors }];
      }
      return { ...prev, currentRoads: newRoads };
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
          onIntersectionDelete={handleIntersectionDelete}
          onIntersectionRename={handleIntersectionRename}
          onIntersectionMove={handleIntersectionMove}
          onCenterChange={handleCenterChange}
          onZoomChange={handleZoomChange}
          fromScratch={fromScratch}
          onScratchRoadSelected={handleScratchRoadSelected}
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
            onSaved={async () => {
              if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
              setPanelMode('routes');
              setPreviewRoutes([]);
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
    </div>
  );
}

export default App;
