import React from 'react';
import { Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { SectorTrimModeState } from '../types/route';
import { flattenRoadSectors, sectorCount } from '../utils/routeUtils';

// ContentCut SVG at 75% of TrimRouteOverlay's scissors (39×39, fill=#f87171)
const MINI_SCISSORS_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="39" height="39" viewBox="0 0 24 24" fill="#f87171">
  <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/>
</svg>`;

function makeMiniScissorsIcon(): L.DivIcon {
  return L.divIcon({
    className: 'sector-scissors-icon',
    html: MINI_SCISSORS_HTML,
    iconSize: [39, 39],
    iconAnchor: [19, 19],
  });
}

function buildRoadCoords(road: any): [number, number][] {
  const coords: [number, number][] = [];
  let prevLat = NaN, prevLon = NaN;
  for (const s of (road.road_sectors || [])) {
    const [sLat, sLon, eLat, eLon] =
      s.direction === 'ascend'
        ? [s.lat0, s.lon0, s.lat1, s.lon1]
        : [s.lat1, s.lon1, s.lat0, s.lon0];
    if (isNaN(prevLat) || Math.abs(sLat - prevLat) > 1e-7 || Math.abs(sLon - prevLon) > 1e-7) {
      coords.push([sLat, sLon]);
    }
    coords.push([eLat, eLon]);
    prevLat = eLat; prevLon = eLon;
  }
  return coords;
}

function buildAllCoords(roads: any[]): [number, number][] {
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

function getSectorMidpoint(sector: any): [number, number] {
  return [(sector.lat0 + sector.lat1) / 2, (sector.lon0 + sector.lon1) / 2];
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

/** Find which sector within flat[lo..hi] (inclusive) the point (lat, lon) is closest to. */
function findClosestSectorIndexInRange(
  lat: number, lon: number,
  flat: { roadIdx: number; sector: any }[],
  lo: number, hi: number,
): number {
  let minDist = Infinity;
  let idx = lo;
  for (let i = lo; i <= hi; i++) {
    const s = flat[i].sector;
    const dist = closestDistToSegment(lat, lon, s.lat0, s.lon0, s.lat1, s.lon1);
    if (dist < minDist) {
      minDist = dist;
      idx = i;
    }
  }
  return idx;
}

interface SectorTrimOverlayProps {
  sectorTrimMode: SectorTrimModeState | null;
  onTrimStart: (targetSectorIndex: number) => void;
  onTrimEnd: (targetSectorIndex: number) => void;
}

const SectorTrimOverlay: React.FC<SectorTrimOverlayProps> = ({
  sectorTrimMode,
  onTrimStart,
  onTrimEnd,
}) => {
  if (!sectorTrimMode) return null;

  const { originalRoads, currentRoads, trimmedFromStart, trimmedFromEnd } = sectorTrimMode;
  if (!currentRoads.length) return null;

  const coords = buildAllCoords(currentRoads);
  const showScissors = sectorCount(currentRoads) > 1;
  const allTrimmed = [...trimmedFromStart, ...trimmedFromEnd];

  // Flattened original sectors, used to resolve a drop position to a global sector
  // index and to bound each scissors' reach to its own side of the route.
  const flat = flattenRoadSectors(originalRoads);
  const n = flat.length;
  const startRangeHi = n - sectorCount(trimmedFromEnd) - 1;
  const endRangeLo = sectorCount(trimmedFromStart);

  const firstSector = currentRoads[0]?.road_sectors?.[0];
  const lastRoad = currentRoads[currentRoads.length - 1];
  const lastSectors = lastRoad?.road_sectors ?? [];
  const lastSector = lastSectors[lastSectors.length - 1];

  const miniIcon = makeMiniScissorsIcon();

  return (
    <>
      {/* Current road_sectors as blue polyline */}
      {coords.length > 0 && (
        <Polyline
          positions={coords}
          pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.9 }}
        />
      )}

      {/* Gray dotted polylines for trimmed sectors */}
      {allTrimmed.map((road, i) => (
        <Polyline
          key={`sector-trim-gray-${i}`}
          positions={buildRoadCoords(road)}
          pathOptions={{ color: '#888', weight: 3, dashArray: '6 5', opacity: 0.8 }}
        />
      ))}

      {/* Start scissors marker */}
      {showScissors && firstSector && (
        <Marker
          position={getSectorMidpoint(firstSector)}
          icon={miniIcon}
          draggable
          eventHandlers={{
            dragstart: (e) => L.DomEvent.stopPropagation(e),
            dragend: (e) => {
              const pos = e.target.getLatLng();
              const idx = findClosestSectorIndexInRange(pos.lat, pos.lng, flat, 0, startRangeHi);
              e.target.setLatLng(getSectorMidpoint(flat[idx].sector));
              onTrimStart(idx);
            },
          }}
        />
      )}

      {/* End scissors marker */}
      {showScissors && lastSector && (
        <Marker
          position={getSectorMidpoint(lastSector)}
          icon={miniIcon}
          draggable
          eventHandlers={{
            dragstart: (e) => L.DomEvent.stopPropagation(e),
            dragend: (e) => {
              const pos = e.target.getLatLng();
              const idx = findClosestSectorIndexInRange(pos.lat, pos.lng, flat, endRangeLo, n - 1);
              e.target.setLatLng(getSectorMidpoint(flat[idx].sector));
              onTrimEnd(idx);
            },
          }}
        />
      )}
    </>
  );
};

export default SectorTrimOverlay;
