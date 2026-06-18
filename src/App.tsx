import React, { useState, useEffect, useRef } from 'react';
import Cookies from 'js-cookie';
import LocationControl from './components/LocationControl';
import ZoomButtons from './components/ZoomButtons';
import MapView from './components/MapView';
import RoutePanel from './components/RoutePanel';
import NewRoutePanel from './components/NewRoutePanel';
import { BBox, RouteDoc, RoutePolyline } from './types/route';
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
          onHoveredIndexChange={setHoveredIndex}
          onSelectedIndexChange={(index) =>
            setSelectedIndex((prev) => (prev === index ? null : index))
          }
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
    </div>
  );
}

export default App;
