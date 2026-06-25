import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

/**
 * Global map context-menu that appears on every right-click not consumed
 * by a more specific handler (e.g. IntersectionOverlay).
 * Shows a single "Google Maps" item that opens the clicked position in a new tab.
 */
const MapContextMenu: React.FC = () => {
  const map = useMap();
  const [menu, setMenu] = useState<{
    x: number; y: number; lat: number; lon: number;
  } | null>(null);

  useMapEvents({
    contextmenu: (e) => {
      e.originalEvent.preventDefault();
      const pt = map.latLngToContainerPoint(e.latlng);
      setMenu({ x: pt.x, y: pt.y, lat: e.latlng.lat, lon: e.latlng.lng });
    },
    click: () => setMenu(null),
  });

  if (!menu) return null;

  const zoom = map.getZoom();
  const url = `http://maps.google.com/maps?z=${zoom}&t=m&q=loc:${menu.lat}+${menu.lon}`;

  return ReactDOM.createPortal(
    <div
      className="intersection-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="ctx-menu-item"
        onClick={() => { window.open(url, '_blank'); setMenu(null); }}
      >
        Google Maps
      </div>
    </div>,
    map.getContainer(),
  );
};

export default MapContextMenu;
