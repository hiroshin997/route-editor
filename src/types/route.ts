export interface RoadSector {
  coord_index: number;
  lon0: number;
  lat0: number;
  lon1: number;
  lat1: number;
  heading: number;
  direction: 'ascend' | 'descend';
  length_m: number;
  node_id: string;
}

export interface RoadObject {
  road_id: string;
  oneway: boolean;
  width_m: number;
  road_sectors: RoadSector[];
  min_side_road_id: string;
  max_side_road_id: string;
}

/** One document from jproad_routes collection. */
export interface RouteDoc {
  relation_id: number;
  name: string;
  /** routes[i] = ordered array of RoadObjects that form one continuous polyline */
  routes: RoadObject[][];
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
}
