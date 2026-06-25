import React, { useState } from 'react';
import { Polyline, useMap, useMapEvents } from 'react-leaflet';
import { FromScratchRoad } from '../types/route';

interface FromScratchOverlayProps {
  selectedRoad: FromScratchRoad | null;
  onRoadSelected: (road: FromScratchRoad) => void;
}

const FromScratchOverlay: React.FC<FromScratchOverlayProps> = ({
  selectedRoad,
  onRoadSelected,
}) => {
  const map = useMap();
  const [isFetching, setIsFetching] = useState(false);

  useMapEvents({
    click: async (e) => {
      if (isFetching) return;
      setIsFetching(true);
      try {
        const bounds = map.getBounds();
        const params = new URLSearchParams({
          lat: String(e.latlng.lat),
          lon: String(e.latlng.lng),
          minLon: String(bounds.getWest()),
          minLat: String(bounds.getSouth()),
          maxLon: String(bounds.getEast()),
          maxLat: String(bounds.getNorth()),
        });
        const res = await fetch(`/api/roads/nearest?${params}`);
        if (!res.ok) return;
        const road: FromScratchRoad | null = await res.json();
        if (road) onRoadSelected(road);
      } catch (err) {
        console.error('[FromScratchOverlay] nearest road fetch error:', err);
      } finally {
        setIsFetching(false);
      }
    },
  });

  if (!selectedRoad) return null;

  // centerline coords are [lon, lat]; Leaflet needs [lat, lon]
  const positions: [number, number][] = selectedRoad.coords.map(([lon, lat]) => [lat, lon]);

  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: 'red',
        weight: 4,
        dashArray: '10 6',
        className: 'from-scratch-road',
      }}
    />
  );
};

export default FromScratchOverlay;
