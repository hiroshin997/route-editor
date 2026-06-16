import { BBox, RoadObject, RouteDoc, RoutePolyline } from '../types/route';

// ── BBox from GeoJSON ─────────────────────────────────────────────────────────

function extractAllLonLat(geometry: any): [number, number][] {
  if (!geometry) return [];
  const result: [number, number][] = [];

  const addRing = (ring: number[][]) => {
    for (const coord of ring) result.push([coord[0], coord[1]]);
  };

  if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates)
      for (const ring of polygon) addRing(ring);
  } else if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) addRing(ring);
  }
  return result;
}

export function computeBboxFromGeoJSON(geoJson: any): BBox | null {
  if (!geoJson?.geometry) return null;
  const coords = extractAllLonLat(geoJson.geometry);
  if (!coords.length) return null;

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// ── Polyline construction ─────────────────────────────────────────────────────

/**
 * Build a [lat, lon] coordinate array from an ordered list of RoadObjects.
 * Respects the direction field, deduplicates consecutive identical points.
 */
function buildPolylineCoords(roadObjects: RoadObject[]): [number, number][] {
  const coords: [number, number][] = [];
  let prevLat = NaN, prevLon = NaN;

  const push = (lat: number, lon: number) => {
    if (Math.abs(lat - prevLat) < 1e-7 && Math.abs(lon - prevLon) < 1e-7) return;
    coords.push([lat, lon]);
    prevLat = lat; prevLon = lon;
  };

  for (const road of roadObjects) {
    if (!road.road_sectors) continue;
    for (const s of road.road_sectors) {
      if (s.direction === 'ascend') {
        push(s.lat0, s.lon0);
        push(s.lat1, s.lon1);
      } else {
        push(s.lat1, s.lon1);
        push(s.lat0, s.lon0);
      }
    }
  }
  return coords;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeRoutePolylines(docs: RouteDoc[], _bbox: BBox): RoutePolyline[] {
  const result: RoutePolyline[] = [];
  let index = 1;
  for (const doc of docs) {
    for (const routeArray of doc.routes) {
      const coords = buildPolylineCoords(routeArray);
      if (coords.length === 0) continue;
      result.push({ index, name: doc.name, coords });
      index++;
    }
  }
  return result;
}
