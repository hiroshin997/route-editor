import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, Polyline, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RoutePolyline } from '../types/route';

// Fix default marker icon paths broken by webpack
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

function createIndexIcon(index: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="route-index-icon">${index}</div>`,
    iconSize: [24, 20],
    iconAnchor: [12, 10],
  });
}

/** Pixel interval between labels along a polyline. */
const LABEL_INTERVAL_PX = 640;

interface LabelMarker {
  pos: [number, number];
  index: number;
}

/**
 * Calculates label positions at equal pixel intervals along each polyline.
 * Re-runs on zoomend so spacing stays visually consistent across zoom levels.
 */
const RouteLabels: React.FC<{ routePolylines: RoutePolyline[] }> = ({ routePolylines }) => {
  const map = useMap();
  const [labels, setLabels] = useState<LabelMarker[]>([]);

  // Use a ref so the latest routePolylines/map are always captured by the
  // zoomend handler without needing to re-register it.
  const calcRef = useRef<() => void>(() => {});
  calcRef.current = () => {
    const result: LabelMarker[] = [];

    for (const rp of routePolylines) {
      if (rp.coords.length < 2) continue;

      // Start half an interval in so the first label appears midway through
      // the first stretch rather than right at the beginning.
      let distToNext = LABEL_INTERVAL_PX / 2;

      for (let i = 0; i < rp.coords.length - 1; i++) {
        const p1 = map.latLngToLayerPoint(rp.coords[i]);
        const p2 = map.latLngToLayerPoint(rp.coords[i + 1]);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const segLen = Math.sqrt(dx * dx + dy * dy);
        if (segLen < 0.001) continue;

        let walked = 0;
        while (walked + distToNext <= segLen) {
          walked += distToNext;
          const t = walked / segLen;
          result.push({
            pos: [
              rp.coords[i][0] + t * (rp.coords[i + 1][0] - rp.coords[i][0]),
              rp.coords[i][1] + t * (rp.coords[i + 1][1] - rp.coords[i][1]),
            ],
            index: rp.index,
          });
          distToNext = LABEL_INTERVAL_PX;
        }
        distToNext -= segLen - walked;
      }
    }

    setLabels(result);
  };

  // Recalculate when routes change
  useEffect(() => {
    calcRef.current();
  }, [routePolylines]);

  // Recalculate on zoom change (pixel/coord ratio changes)
  useMapEvents({
    zoomend: () => calcRef.current(),
  });

  return (
    <>
      {labels.map((lbl, i) => (
        <Marker key={i} position={lbl.pos} icon={createIndexIcon(lbl.index)} />
      ))}
    </>
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
  onCenterChange: (center: [number, number]) => void;
  onZoomChange: (zoom: number) => void;
}

const MapView: React.FC<MapViewProps> = ({
  center,
  zoom,
  polygon,
  polygonKey,
  routePolylines,
  onCenterChange,
  onZoomChange,
}) => {
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
        {routePolylines.map((rp) => (
          <Polyline
            key={`rp-${rp.index}`}
            positions={rp.coords}
            color="green"
            weight={3}
            opacity={0.8}
          />
        ))}
        <RouteLabels routePolylines={routePolylines} />
      </MapContainer>
    </div>
  );
};

export default MapView;
