import React from 'react';
import { Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { SectorTrimModeState } from '../types/route';

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

function totalSectorCount(roads: any[]): number {
  return roads.reduce((sum, r) => sum + (r.road_sectors?.length ?? 0), 0);
}

function getSectorMidpoint(sector: any): [number, number] {
  return [(sector.lat0 + sector.lat1) / 2, (sector.lon0 + sector.lon1) / 2];
}

interface SectorTrimOverlayProps {
  sectorTrimMode: SectorTrimModeState | null;
  onTrimStart: () => void;
  onTrimEnd: () => void;
}

const SectorTrimOverlay: React.FC<SectorTrimOverlayProps> = ({
  sectorTrimMode,
  onTrimStart,
  onTrimEnd,
}) => {
  if (!sectorTrimMode) return null;

  const { currentRoads } = sectorTrimMode;
  if (!currentRoads.length) return null;

  const coords = buildAllCoords(currentRoads);
  const showScissors = totalSectorCount(currentRoads) > 1;

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

      {/* Start scissors marker */}
      {showScissors && firstSector && (
        <Marker
          position={getSectorMidpoint(firstSector)}
          icon={miniIcon}
          eventHandlers={{ click: onTrimStart }}
        />
      )}

      {/* End scissors marker */}
      {showScissors && lastSector && (
        <Marker
          position={getSectorMidpoint(lastSector)}
          icon={miniIcon}
          eventHandlers={{ click: onTrimEnd }}
        />
      )}
    </>
  );
};

export default SectorTrimOverlay;
