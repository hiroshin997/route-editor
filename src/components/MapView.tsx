import React, { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, Polyline, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RoutePolyline, EndpointInfo, ExtendModeState, TrimModeState } from '../types/route';
import ExtendRouteOverlay from './ExtendRouteOverlay';
import TrimRouteOverlay from './TrimRouteOverlay';

// Fix default marker icon paths broken by webpack
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

/** Red rectangle DivIcon for active (hovered/selected) route label on the map. */
function createIndexIconActive(index: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="route-index-icon route-index-icon--active">${index}</div>`,
    iconSize: [24, 20],
    iconAnchor: [12, 10],
  });
}

interface RouteLineProps {
  route: RoutePolyline;
  isActive: boolean;
  selectedIndex: number | null;
  onHoveredIndexChange: (index: number | null) => void;
  onSelectedIndexChange: (index: number | null) => void;
}

/**
 * Active route is brought to front so it is never hidden under overlapping lines.
 */
const RouteLine: React.FC<RouteLineProps> = ({
  route,
  isActive,
  selectedIndex,
  onHoveredIndexChange,
  onSelectedIndexChange,
}) => {
  const lineRef = useRef<L.Polyline | null>(null);

  useEffect(() => {
    if (isActive) {
      lineRef.current?.bringToFront();
    }
  }, [isActive]);

  return (
    <Polyline
      ref={lineRef}
      key={`rp-${route.index}`}
      positions={route.coords}
      pathOptions={{
        color: isActive ? 'red' : 'green',
        weight: isActive ? 4 : 3,
        opacity: 0.8,
      }}
      eventHandlers={{
        mouseover: () => onHoveredIndexChange(route.index),
        mouseout: () => onHoveredIndexChange(null),
        click: () => onSelectedIndexChange(
          selectedIndex === route.index ? null : route.index
        ),
      }}
    >
      <Tooltip sticky className="route-tooltip-hover">
        <div className="route-index-icon route-index-icon--active">{route.index}</div>
      </Tooltip>
    </Polyline>
  );
};

interface MapControllerProps {
  zoom: number;
  polygon: object | null;
  polygonKey: string;
  onZoomChange: (zoom: number) => void;
  onCenterChange: (center: [number, number]) => void;
}

/**
 * Inner component that accesses the Leaflet map instance.
 * Synchronises zoom from parent and reports user-driven zoom/move back up.
 * When polygon changes, pans map to polygon center without changing zoom.
 */
const MapController: React.FC<MapControllerProps> = ({
  zoom,
  polygon,
  polygonKey,
  onZoomChange,
  onCenterChange,
}) => {
  const map = useMap();
  const prevZoomRef = useRef<number>(zoom);

  // When the zoom prop changes (e.g. from ZoomButtons), apply it to the map.
  useEffect(() => {
    if (map.getZoom() !== zoom) {
      map.setZoom(zoom);
    }
    prevZoomRef.current = zoom;
  }, [zoom, map]);

  // When the polygon changes, pan to its center without altering zoom.
  useEffect(() => {
    console.log('[MapController] pan effect triggered / polygonKey:', polygonKey, '/ polygon:', polygon);
    if (!polygon) {
      console.log('[MapController] polygon is null, skipping panTo');
      return;
    }
    try {
      const layer = L.geoJSON(polygon as any);
      const bounds = layer.getBounds();
      console.log('[MapController] bounds valid:', bounds.isValid(), '/ bounds:', bounds.isValid() ? bounds.toBBoxString() : 'N/A');
      if (bounds.isValid()) {
        const center = bounds.getCenter();
        console.log('[MapController] panTo center:', center.lat, center.lng);
        map.panTo(center, { animate: true });
      }
    } catch (e) {
      console.error('[MapController] geoJSON parse error:', e);
    }
  // Depend on both polygonKey and polygon:
  // - polygonKey changes first (selection change), polygon is still null → skip
  // - polygon then changes from null to data → this effect fires and pans
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygonKey, polygon, map]);

  useMapEvents({
    zoomend: () => {
      const z = map.getZoom();
      prevZoomRef.current = z;
      onZoomChange(z);
    },
    moveend: () => {
      const c = map.getCenter();
      onCenterChange([c.lat, c.lng]);
    },
  });

  return null;
};

interface MapViewProps {
  center: [number, number];
  zoom: number;
  /** GeoJSON Feature or null */
  polygon: object | null;
  /** Stable key to force GeoJSON layer replacement when selection changes */
  polygonKey: string;
  routePolylines: RoutePolyline[];
  /** Preview polylines shown as blinking red dotted lines */
  previewRoutes: RoutePolyline[];
  hoveredIndex: number | null;
  selectedIndex: number | null;
  extendMode: ExtendModeState | null;
  trimMode: TrimModeState | null;
  onHoveredIndexChange: (index: number | null) => void;
  onSelectedIndexChange: (index: number | null) => void;
  onEndpointClick: (ep: EndpointInfo) => void;
  onArrowSelect: (roadId: number) => void;
  onForward: () => void;
  onSaveAndClose: () => void;
  onCancelExtend: () => void;
  onTrimStart: () => void;
  onTrimEnd: () => void;
  onCenterChange: (center: [number, number]) => void;
  onZoomChange: (zoom: number) => void;
}

const MapView: React.FC<MapViewProps> = ({
  center,
  zoom,
  polygon,
  polygonKey,
  routePolylines,
  previewRoutes,
  hoveredIndex,
  selectedIndex,
  extendMode,
  trimMode,
  onHoveredIndexChange,
  onSelectedIndexChange,
  onEndpointClick,
  onArrowSelect,
  onForward,
  onSaveAndClose,
  onCancelExtend,
  onTrimStart,
  onTrimEnd,
  onCenterChange,
  onZoomChange,
}) => {
  // In extend mode: hide all routes except the one being extended.
  // In trim mode: hide all routes – TrimRouteOverlay handles rendering.
  const visiblePolylines = (() => {
    if (extendMode) {
      return routePolylines.filter((rp) => rp.relation_id === extendMode.relation_id);
    }
    if (trimMode) {
      return [];
    }
    return routePolylines;
  })();

  // Midpoint coord of the selected polyline for the persistent label marker
  const selectedPolyline = selectedIndex !== null
    ? visiblePolylines.find((rp) => rp.index === selectedIndex) ?? null
    : null;
  const selectedMidpoint: [number, number] | null =
    selectedPolyline && selectedPolyline.coords.length > 0
      ? selectedPolyline.coords[Math.floor(selectedPolyline.coords.length / 2)]
      : null;

  return (
    <div className="map-view-area">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <MapController
          zoom={zoom}
          polygon={polygon}
          polygonKey={polygonKey}
          onZoomChange={onZoomChange}
          onCenterChange={onCenterChange}
        />
        {polygon && (
          <GeoJSON
            key={polygonKey}
            data={polygon as any}
            style={{
              color: '#2563eb',
              weight: 2,
              fillColor: '#3b82f6',
              fillOpacity: 0.15,
            }}
          />
        )}
        {visiblePolylines.map((rp) => (
          <RouteLine
            key={`rp-${rp.index}`}
            route={rp}
            isActive={rp.index === hoveredIndex || rp.index === selectedIndex}
            selectedIndex={selectedIndex}
            onHoveredIndexChange={onHoveredIndexChange}
            onSelectedIndexChange={onSelectedIndexChange}
          />
        ))}
        {/* Fixed label at polyline midpoint when selected from panel */}
        {selectedMidpoint && selectedIndex !== null && (
          <Marker
            position={selectedMidpoint}
            icon={createIndexIconActive(selectedIndex)}
          />
        )}
        {/* Preview polylines: blinking red dotted lines */}
        {previewRoutes.map((rp) => (
          <Polyline
            key={`preview-${rp.index}`}
            positions={rp.coords}
            pathOptions={{ color: 'red', weight: 3, dashArray: '8 6', className: 'route-preview-blink' }}
          />
        ))}
        <ExtendRouteOverlay
          extendMode={extendMode}
          onEndpointClick={onEndpointClick}
          onArrowSelect={onArrowSelect}
          onForward={onForward}
          onSaveAndClose={onSaveAndClose}
          onCancelExtend={onCancelExtend}
        />
        <TrimRouteOverlay
          trimMode={trimMode}
          onTrimStart={onTrimStart}
          onTrimEnd={onTrimEnd}
        />
      </MapContainer>
    </div>
  );
};

export default MapView;
