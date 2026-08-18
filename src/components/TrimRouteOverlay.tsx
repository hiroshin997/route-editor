import React from 'react';
import { Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { TrimModeState } from '../types/route';

// ContentCut SVG path (scissors icon)
const SCISSORS_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="#dc2626">
  <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/>
</svg>`;

const scissorsIcon = L.divIcon({
  className: 'scissors-marker-icon',
  html: SCISSORS_HTML,
  iconSize: [52, 52],
  iconAnchor: [26, 26],
});

function buildRoadCoords(roadItem: any): [number, number][] {
  const sectors: any[] = roadItem.road_sectors || [];
  const coords: [number, number][] = [];
  let prevLat = NaN, prevLon = NaN;

  for (const s of sectors) {
    const [sLat, sLon, eLat, eLon] =
      s.direction === 'ascend'
        ? [s.lat0, s.lon0, s.lat1, s.lon1]
        : [s.lat1, s.lon1, s.lat0, s.lon0];

    if (isNaN(prevLat) || Math.abs(sLat - prevLat) > 1e-7 || Math.abs(sLon - prevLon) > 1e-7) {
      coords.push([sLat, sLon]);
    }
    coords.push([eLat, eLon]);
    prevLat = eLat;
    prevLon = eLon;
  }
  return coords;
}

function getRoadMidpoint(roadItem: any): [number, number] {
  const coords = buildRoadCoords(roadItem);
  if (!coords.length) return [0, 0];
  return coords[Math.floor(coords.length / 2)];
}

function closestDistToSegment(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const dx = bLon - aLon, dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return Math.hypot(pLat - aLat, pLon - aLon);
  const t = Math.max(0, Math.min(1, ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq));
  const cLat = aLat + t * dy, cLon = aLon + t * dx;
  return Math.hypot(pLat - cLat, pLon - cLon);
}

/** Find which road in `roads` the point (lat, lon) is closest to. */
function findClosestRoadIndex(lat: number, lon: number, roads: any[]): number {
  let minDist = Infinity;
  let idx = 0;
  roads.forEach((road, i) => {
    for (const s of (road.road_sectors || [])) {
      const dist = closestDistToSegment(lat, lon, s.lat0, s.lon0, s.lat1, s.lon1);
      if (dist < minDist) {
        minDist = dist;
        idx = i;
      }
    }
  });
  return idx;
}

function buildAllRoadsCoords(roads: any[]): [number, number][] {
  const all: [number, number][] = [];
  let prevLat = NaN, prevLon = NaN;
  for (const road of roads) {
    for (const [lat, lon] of buildRoadCoords(road)) {
      if (isNaN(prevLat) || Math.abs(lat - prevLat) > 1e-7 || Math.abs(lon - prevLon) > 1e-7) {
        all.push([lat, lon]);
      }
      prevLat = lat; prevLon = lon;
    }
  }
  return all;
}

interface TrimRouteOverlayProps {
  trimMode: TrimModeState | null;
  onTrimStart: (targetIndex: number) => void;
  onTrimEnd: (targetIndex: number) => void;
}

const TrimRouteOverlay: React.FC<TrimRouteOverlayProps> = ({
  trimMode,
  onTrimStart,
  onTrimEnd,
}) => {
  if (!trimMode) return null;

  const { currentRoads, trimmedFromStart, trimmedFromEnd } = trimMode;
  const showScissors = currentRoads.length > 1;
  const allTrimmed = [...trimmedFromStart, ...trimmedFromEnd];
  const currentCoords = buildAllRoadsCoords(currentRoads);

  return (
    <>
      {/* Active roads rendered as red polyline (replaces hidden RouteLine in trim mode) */}
      {currentCoords.length > 0 && (
        <Polyline
          positions={currentCoords}
          pathOptions={{ color: 'red', weight: 4, opacity: 0.8 }}
        />
      )}
      {/* Gray dotted polylines for trimmed roads */}
      {allTrimmed.map((road, i) => (
        <Polyline
          key={`trim-gray-${i}`}
          positions={buildRoadCoords(road)}
          pathOptions={{ color: '#888', weight: 3, dashArray: '6 5', opacity: 0.8 }}
        />
      ))}

      {/* Scissors markers at midpoints of the current endpoint roads */}
      {showScissors && (
        <>
          <Marker
            position={getRoadMidpoint(currentRoads[0])}
            icon={scissorsIcon}
            draggable
            eventHandlers={{
              dragstart: (e) => L.DomEvent.stopPropagation(e),
              dragend: (e) => {
                const pos = e.target.getLatLng();
                const idx = findClosestRoadIndex(pos.lat, pos.lng, currentRoads);
                e.target.setLatLng(getRoadMidpoint(currentRoads[idx]));
                onTrimStart(idx);
              },
            }}
          />
          <Marker
            position={getRoadMidpoint(currentRoads[currentRoads.length - 1])}
            icon={scissorsIcon}
            draggable
            eventHandlers={{
              dragstart: (e) => L.DomEvent.stopPropagation(e),
              dragend: (e) => {
                const pos = e.target.getLatLng();
                const idx = findClosestRoadIndex(pos.lat, pos.lng, currentRoads);
                e.target.setLatLng(getRoadMidpoint(currentRoads[idx]));
                onTrimEnd(idx);
              },
            }}
          />
        </>
      )}
    </>
  );
};

export default TrimRouteOverlay;
