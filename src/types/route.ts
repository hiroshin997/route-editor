export interface RoadSector {
  coord_index: number;
  lon0: number;
  lat0: number;
  lon1: number;
  lat1: number;
  heading: number;
  direction: 'ascend' | 'descend';
  length_m: number;
  /** Node at the min (from_node) end of this sector */
  min_node_id: number;
  /** Node at the max (to_node) end of this sector */
  max_node_id: number;
}

export interface RoadObject {
  road_id: number;
  oneway: boolean;
  width_m: number;
  road_sectors: RoadSector[];
  /** Integer road_id of the preceding road, -1 if none */
  min_side_road_id: number;
  /** Integer road_id of the following road, -1 if none */
  max_side_road_id: number;
}

/** One path within a route document (routes[i]). */
export interface RoutePath {
  roads: RoadObject[];
  intersection_group_key?: string;
}

/** One document from jproad_routes collection. */
export interface RouteDoc {
  relation_id: number;
  name: string;
  /** Route names: primary name first, then NFKC/variation equivalents */
  names: string[];
  /** routes[i] = one path object containing an ordered array of RoadObjects */
  routes: RoutePath[];
}

// ── Intersection types ────────────────────────────────────────────────────────

export interface Intersection {
  intersection_id: number;
  /** Intersection names: primary first, then NFKC/variation equivalents */
  names: string[];
  road_id: number;
  coord_index: number;
  lat: number;
  lon: number;
}

export interface IntersectionModeState {
  relation_id: number;
  path_idx: number;
  groups_key: string | null;         // null = new path, key created on save
  originalIntersections: Intersection[];
  currentIntersections: Intersection[];
  roadItems: any[];                  // for snapping
  originalGroups: Record<string, Intersection[]>;  // full intersection_groups for save
  allRoutesKeys: (string | null)[];  // routes[i].intersection_group_key
  nextId: number;                    // next id to assign (>= 999000000001)
}

export interface DisplayIntersectionState {
  relation_id: number;
  path_idx: number;
  groups_key: string | null;
  intersections: Intersection[];
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Computed, ready-to-render polyline. */
export interface RoutePolyline {
  /** 1-based sequential index across all polylines */
  index: number;
  name: string;
  /** [lat, lon] pairs for Leaflet */
  coords: [number, number][];
  /** Original relation_id from jproad_routes (undefined for preview routes) */
  relation_id?: number;
  /** Index in doc.routes[] for this path */
  path_idx?: number;
  /** Number of road_items in this path (for disabling trim button) */
  road_count?: number;
}

// ── From-scratch route creation ───────────────────────────────────────────────

/** Road returned by /api/roads/nearest, used in from-scratch mode. */
export interface FromScratchRoad {
  road_id: number;
  name: string;
  oneway: boolean;
  /** [[lon, lat], ...] from MongoDB centerline */
  coords: [number, number][];
}

/** Overall from-scratch mode state managed in App.tsx. */
export interface FromScratchState {
  query: string;
  /** null = no road selected yet; non-null = road clicked */
  road: FromScratchRoad | null;
}

// ── Route extension types ─────────────────────────────────────────────────────

export interface TrimModeState {
  relation_id: number;
  path_idx: number;
  originalRoads: any[];     // unchanged – for isDirty check
  currentRoads: any[];      // roads still in the route
  trimmedFromStart: any[];  // removed from front (gray display)
  trimmedFromEnd: any[];    // removed from back  (gray display)
}

export interface EndpointInfo {
  path_idx: number;
  endpoint: 'start' | 'end';
  lat: number;
  lon: number;
  node_id: number;
  road_id: number;
}

export interface RoadArrow {
  road_id: number;
  name: string;
  bearing: number;       // 0–360 travel bearing from junction
  enter_from_start: boolean;
  direction: 'ascend' | 'descend';
  oneway: boolean;
  new_node_id: number;
  new_lat: number;
  new_lon: number;
  coords: [number, number][]; // [lat, lon] in travel direction
  width_m: number;
  highway: string | null;
}

export interface PendingRoadItem {
  road_id: number;
  direction: 'ascend' | 'descend';
  coords: [number, number][];
  new_node_id: number;
  new_lat: number;
  new_lon: number;
}

export interface ExtendModalState {
  position: [number, number]; // [lat, lon]
  node_id: number;
  path_idx: number;
  endpoint_type: 'start' | 'end';
  /** null = loading */
  arrows: RoadArrow[] | null;
  selected_road_id: number | null;
  excluded_road_ids: number[];
}

export interface TrimModeState {
  relation_id: number;
  path_idx: number;
  originalRoads: any[];      // unchanged – for isDirty check
  currentRoads: any[];       // roads still in the route
  trimmedFromStart: any[];   // removed from front (gray display)
  trimmedFromEnd: any[];     // removed from back (gray display)
}

export interface ExtendModeState {
  relation_id: number;
  endpoints: EndpointInfo[];
  modal: ExtendModalState | null;
  pending_roads: PendingRoadItem[];
}
