import React, { useState, useEffect, useRef } from 'react';
import Cookies from 'js-cookie';
import LocationControl from './components/LocationControl';
import ZoomButtons from './components/ZoomButtons';
import MapView from './components/MapView';
import RoutePanel from './components/RoutePanel';
import NewRoutePanel from './components/NewRoutePanel';
import NamesEditModal from './components/NamesEditModal';
import { BBox, RouteDoc, RoutePolyline, EndpointInfo, RoadArrow, PendingRoadItem, ExtendModeState } from './types/route';
import { computeBboxFromGeoJSON, computeRoutePolylines } from './utils/routeUtils';
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

function App() {
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
  const [panelMode, setPanelMode] = useState<'routes' | 'newRoute'>('routes');
  const [previewRoutes, setPreviewRoutes] = useState<RoutePolyline[]>([]);
  const [cityBbox, setCityBbox] = useState<BBox | null>(saved?.cityBbox ?? null);
  const [editingRelationId, setEditingRelationId] = useState<number | null>(null);
  const [extendMode, setExtendMode] = useState<ExtendModeState | null>(null);

  // Refs for values needed inside callbacks without causing stale closures
  const latestRef  = useRef({ selections, zoom, mapCenter });
  const cityBboxRef = useRef<BBox | null>(saved?.cityBbox ?? null);
  latestRef.current = { selections, zoom, mapCenter };

  // Close newRoute panel when zoom drops below 14
  useEffect(() => {
    if (zoom < 14 && panelMode === 'newRoute') {
      setPanelMode('routes');
      setPreviewRoutes([]);
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
      await fetchOptions(1, []);

      const restoredSelections = savedRef.current?.selections ?? [];
      if (restoredSelections.length === 0) return;

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
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Event handlers ────────────────────────────────────────────────────────────

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

      writeCookieState({
        selections: newSelections,
        zoom: latestRef.current.zoom,
        mapCenter: latestRef.current.mapCenter,
        cityBbox: level <= 2 ? undefined : cityBboxRef.current ?? undefined,
      });
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
      writeCookieState({
        selections: newSelections,
        zoom: latestRef.current.zoom,
        mapCenter: latestRef.current.mapCenter,
        cityBbox: undefined,
      });
    } else if (level === 2 && geoData) {
      // City selected → compute bbox and fetch routes
      const bbox = computeBboxFromGeoJSON(geoData);
      if (bbox) {
        cityBboxRef.current = bbox;
        setCityBbox(bbox);
        setSelectedIndex(null);
        setPanelMode('routes');
        setPreviewRoutes([]);
        await fetchRoutes(bbox);
        writeCookieState({
          selections: newSelections,
          zoom: latestRef.current.zoom,
          mapCenter: latestRef.current.mapCenter,
          cityBbox: bbox,
        });
      }
    } else {
      // Level 3+: routes unchanged, just update cookie
      writeCookieState({
        selections: newSelections,
        zoom: latestRef.current.zoom,
        mapCenter: latestRef.current.mapCenter,
        cityBbox: cityBboxRef.current ?? undefined,
      });
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
      setExtendMode({ relation_id, endpoints, modal: null, pending_roads: [] });
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

    // Show modal immediately with loading state (arrows = null)
    setExtendMode((prev) => ({
      ...prev!,
      modal: {
        position: [ep.lat, ep.lon],
        node_id: ep.node_id,
        path_idx: ep.path_idx,
        endpoint_type: ep.endpoint,
        arrows: null,
        selected_road_id: null,
        excluded_road_ids: excludeIds,
      },
    }));

    const params = `nodeId=${ep.node_id}&excludeRoadIds=${excludeIds.join(',')}`;
    const res = await fetch(`/api/roads/at-node?${params}`);
    const arrows: RoadArrow[] = await res.json();

    setExtendMode((prev) => {
      if (!prev?.modal) return prev;
      return { ...prev, modal: { ...prev.modal, arrows } };
    });
  };

  const handleArrowSelect = (roadId: number): void => {
    setExtendMode((prev) => {
      if (!prev?.modal) return prev;
      const newSel = prev.modal.selected_road_id === roadId ? null : roadId;
      return { ...prev, modal: { ...prev.modal, selected_road_id: newSel } };
    });
  };

  const handleForward = async (): Promise<void> => {
    if (!extendMode?.modal?.selected_road_id) return;
    const modal = extendMode.modal;
    const arrow = modal.arrows?.find((a) => a.road_id === modal.selected_road_id);
    if (!arrow) return;

    const newPending: PendingRoadItem = {
      road_id: arrow.road_id,
      direction: arrow.direction,
      coords: arrow.coords,
      new_node_id: arrow.new_node_id,
      new_lat: arrow.new_lat,
      new_lon: arrow.new_lon,
    };

    const newExcluded = [...modal.excluded_road_ids, arrow.road_id];

    // Move modal to new position immediately with loading state
    setExtendMode((prev) => ({
      ...prev!,
      pending_roads: [...prev!.pending_roads, newPending],
      modal: {
        ...prev!.modal!,
        position: [arrow.new_lat, arrow.new_lon],
        node_id: arrow.new_node_id,
        arrows: null,
        selected_road_id: null,
        excluded_road_ids: newExcluded,
      },
    }));

    const params = `nodeId=${arrow.new_node_id}&excludeRoadIds=${newExcluded.join(',')}`;
    const res = await fetch(`/api/roads/at-node?${params}`);
    const newArrows: RoadArrow[] = await res.json();

    setExtendMode((prev) => {
      if (!prev?.modal) return prev;
      return { ...prev, modal: { ...prev.modal, arrows: newArrows } };
    });
  };

  const handleSaveExtend = async (): Promise<void> => {
    if (!extendMode || extendMode.pending_roads.length === 0) return;
    const newRoadIds = extendMode.pending_roads.map((pr) => pr.road_id);
    const res = await fetch(`/api/routes/${extendMode.relation_id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city_bbox: cityBbox, new_road_ids: newRoadIds }),
    });
    if (res.ok) {
      if (cityBboxRef.current) await fetchRoutes(cityBboxRef.current);
      setExtendMode(null);
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
          onHoveredIndexChange={setHoveredIndex}
          onSelectedIndexChange={(index) =>
            setSelectedIndex((prev) => (prev === index ? null : index))
          }
          onEndpointClick={handleEndpointClick}
          onArrowSelect={handleArrowSelect}
          onForward={handleForward}
          onSaveAndClose={handleSaveExtend}
          onCancelExtend={handleCancelExtend}
          onCenterChange={handleCenterChange}
          onZoomChange={handleZoomChange}
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
          />
        ) : (
          <NewRoutePanel
            cityBbox={cityBbox}
            routePolylines={routePolylines}
            onClose={() => {
              setPanelMode('routes');
              setPreviewRoutes([]);
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
