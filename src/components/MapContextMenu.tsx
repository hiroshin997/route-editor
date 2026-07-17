import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

interface ThisRoadState {
  /** [lat, lon] pairs for Leaflet */
  coords: [number, number][];
  road_id: number;
  /** Right-click position where the label is anchored */
  lat: number;
  lon: number;
}

/**
 * Global map context-menu that appears on every right-click not consumed
 * by a more specific handler (e.g. IntersectionOverlay).
 */
const MapContextMenu: React.FC = () => {
  const map = useMap();
  const [menu, setMenu] = useState<{
    x: number; y: number; lat: number; lon: number;
  } | null>(null);
  const [thisRoad, setThisRoad] = useState<ThisRoadState | null>(null);
  const [isFetchingRoad, setIsFetchingRoad] = useState(false);

  useMapEvents({
    contextmenu: (e) => {
      e.originalEvent.preventDefault();
      const pt = map.latLngToContainerPoint(e.latlng);
      setMenu({ x: pt.x, y: pt.y, lat: e.latlng.lat, lon: e.latlng.lng });
    },
    // Left-click dismisses both the context menu and the road highlight
    click: () => { setMenu(null); setThisRoad(null); },
  });

  const handleThisRoad = async () => {
    if (!menu || isFetchingRoad) return;
    const { lat, lon } = menu;
    setMenu(null);
    setIsFetchingRoad(true);
    try {
      const bounds = map.getBounds();
      const params = new URLSearchParams({
        lat: String(lat), lon: String(lon),
        minLon: String(bounds.getWest()),  minLat: String(bounds.getSouth()),
        maxLon: String(bounds.getEast()),  maxLat: String(bounds.getNorth()),
      });
      const res = await fetch(`/api/roads/nearest?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data) return;
      // API returns coords as [[lon, lat], ...]; convert to [lat, lon] for Leaflet
      const coords: [number, number][] = (data.coords as number[][]).map(([lo, la]) => [la, lo]);
      setThisRoad({ coords, road_id: data.road_id, lat, lon });
    } finally {
      setIsFetchingRoad(false);
    }
  };

  const zoom = map.getZoom();
  const googleUrl = menu
    ? `http://maps.google.com/maps?z=${zoom}&t=m&q=loc:${menu.lat}+${menu.lon}`
    : '';

  // Label icon anchored to the right-click position
  const labelIcon = thisRoad
    ? L.divIcon({
        className: '',
        html: `<div class="this-road-label"><a href="https://www.openstreetmap.org/way/${thisRoad.road_id}" target="_blank" rel="noreferrer">road_id: ${thisRoad.road_id}</a></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      })
    : null;

  return (
    <>
      {/* Blue dotted blinking road highlight */}
      {thisRoad && (
        <>
          <Polyline
            positions={thisRoad.coords}
            pathOptions={{ color: '#2563eb', weight: 4, dashArray: '10 6', className: 'this-road-line' }}
          />
          {labelIcon && (
            <Marker position={[thisRoad.lat, thisRoad.lon]} icon={labelIcon} />
          )}
        </>
      )}

      {/* Context menu portal */}
      {menu && ReactDOM.createPortal(
        <div
          className="intersection-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctx-menu-item" onClick={handleThisRoad}>
            This road
          </div>
          <hr className="ctx-menu-divider" />
          <div
            className="ctx-menu-item"
            onClick={() => { window.open(googleUrl, '_blank'); setMenu(null); }}
          >
            Google Maps
          </div>
        </div>,
        map.getContainer(),
      )}
    </>
  );
};

export default MapContextMenu;
