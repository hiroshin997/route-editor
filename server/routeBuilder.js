'use strict';

// ── Math helpers ───────────────────────────────────────────────────────────────

function bearingDegreesInt(lon1, lat1, lon2, lat2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLam = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return Math.floor(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

function hubenyJapanM(lat1, lon1, lat2, lon2) {
  const A = 6378137.0;
  const E2 = 0.006694379990197;
  const MN_NUM = 6335439.327292;
  const r1 = (lat1 * Math.PI) / 180;
  const r2 = (lat2 * Math.PI) / 180;
  const dLat = r1 - r2;
  const dLon = ((lon1 - lon2) * Math.PI) / 180;
  const p = (r1 + r2) / 2;
  const sinP = Math.sin(p);
  const w = Math.sqrt(1 - E2 * sinP * sinP);
  const m = MN_NUM / w ** 3;
  const n = A / w;
  return Math.sqrt((dLat * m) ** 2 + (dLon * n * Math.cos(p)) ** 2);
}

function buildPrefixLengthsM(verts) {
  if (!verts || !verts.length) return [0];
  const out = [0];
  let total = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const [lon1, lat1] = verts[i];
    const [lon2, lat2] = verts[i + 1];
    total += hubenyJapanM(lat1, lon1, lat2, lon2);
    out.push(total);
  }
  return out;
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function isForwardOnlyRoad(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['yes', '1', 'true', 'yes @ (06:00-17:00)', 'yes @ 7:30-8:30'].includes(s);
}

function nodeToInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && '$numberLong' in v) {
    const n = parseInt(v['$numberLong'], 10);
    return isNaN(n) ? null : n;
  }
  // Handle BSON Long objects from the MongoDB driver
  if (typeof v === 'object' && typeof v.toNumber === 'function') {
    return v.toNumber();
  }
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// ── RoadInfo builder ───────────────────────────────────────────────────────────

const ROAD_PROJECTION = {
  _id: 0, id: 1, name: 1, width_m: 1, oneway: 1,
  from_node: 1, to_node: 1, node_ref: 1, centerline: 1, highway: 1,
};

function buildRoadInfo(doc) {
  if (!doc) return null;
  const roadId = nodeToInt(doc.id);
  if (roadId === null) return null;

  const coords = doc?.centerline?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const verts = coords
    .filter((pt) => Array.isArray(pt) && pt.length >= 2)
    .map((pt) => [parseFloat(pt[0]), parseFloat(pt[1])]);
  if (verts.length < 2) return null;

  let widthM = null;
  if (doc.width_m != null) {
    const w = parseFloat(doc.width_m);
    if (!isNaN(w)) widthM = w;
  }

  const nodeRefs = (doc.node_ref || []).map((v) => {
    const n = nodeToInt(v);
    return n !== null ? n : -1;
  });

  const prefixM = buildPrefixLengthsM(verts);
  return {
    roadId,
    name: String(doc.name || ''),
    widthM,
    isForwardOnly: isForwardOnlyRoad(doc.oneway),
    fromNode: nodeToInt(doc.from_node),
    toNode: nodeToInt(doc.to_node),
    nodeRefs,
    verts,
    prefixM,
    totalM: prefixM[prefixM.length - 1],
    highway: doc.highway != null ? String(doc.highway) : null,
  };
}

// ── Road sector builders ───────────────────────────────────────────────────────

function buildRoadSectorsAscend(road) {
  const sectors = [];
  for (let i = 0; i < road.verts.length - 1; i++) {
    const [lon0, lat0] = road.verts[i];
    const [lon1, lat1] = road.verts[i + 1];
    sectors.push({
      coord_index: i,
      lon0, lat0, lon1, lat1,
      heading: bearingDegreesInt(lon0, lat0, lon1, lat1),
      direction: 'ascend',
      length_m: Math.round(hubenyJapanM(lat0, lon0, lat1, lon1)),
      min_node_id: i     < road.nodeRefs.length ? road.nodeRefs[i]     : -1,
      max_node_id: i + 1 < road.nodeRefs.length ? road.nodeRefs[i + 1] : -1,
    });
  }
  return sectors;
}

function cloneSectorsDescend(ascendSectors) {
  return [...ascendSectors].reverse().map((s) => ({
    ...s,
    heading: (s.heading + 180) % 360,
    direction: 'descend',
  }));
}

// ── Default widths ─────────────────────────────────────────────────────────────

const DEFAULT_WIDTH_M_PER_HIGHWAY = {
  motorway: 12, primary: 9, secondary: 7, residential: 5, service: 3.5,
};
const DEFAULT_WIDTH_M = 7;

// ── MiniRoute helpers ──────────────────────────────────────────────────────────

function setsIntersect(a, b) {
  for (const v of a) { if (b.has(v)) return true; }
  return false;
}

function canAppend(a, b) {
  if (a.toNode === null || a.toNode === a.fromNode) return false;
  if (b.fromNode !== a.toNode) return false;
  return !setsIntersect(a.roadIdSet, b.roadIdSet);
}

function canPrepend(a, b) {
  if (a.fromNode === null || a.fromNode === a.toNode) return false;
  if (b.toNode !== a.fromNode) return false;
  return !setsIntersect(a.roadIdSet, b.roadIdSet);
}

function concatMR(a, b) {
  return {
    roads: [...a.roads, ...b.roads],
    fromNode: a.fromNode,
    toNode: b.toNode,
    totalM: a.totalM + b.totalM,
    roadIdSet: new Set([...a.roadIdSet, ...b.roadIdSet]),
  };
}

// ── Step 1: build initial mini-routes ─────────────────────────────────────────

function buildInitialMiniRoutes(roadIds, roadInfoMap) {
  const miniRoutes = [];
  const seen = new Set();
  for (const roadId of roadIds) {
    if (seen.has(roadId)) continue;
    seen.add(roadId);
    const road = roadInfoMap.get(roadId);
    if (!road) continue;

    const widthM = road.widthM ||
      (road.highway ? DEFAULT_WIDTH_M_PER_HIGHWAY[road.highway] || DEFAULT_WIDTH_M : DEFAULT_WIDTH_M);

    const ascendSectors = buildRoadSectorsAscend(road);
    miniRoutes.push({
      roads: [{ road_id: roadId, oneway: road.isForwardOnly, width_m: widthM, road_sectors: ascendSectors, highway: road.highway }],
      fromNode: road.fromNode,
      toNode: road.toNode,
      totalM: road.totalM,
      roadIdSet: new Set([roadId]),
    });

    if (!road.isForwardOnly) {
      miniRoutes.push({
        roads: [{ road_id: roadId, oneway: road.isForwardOnly, width_m: widthM, road_sectors: cloneSectorsDescend(ascendSectors), highway: road.highway }],
        fromNode: road.toNode,
        toNode: road.fromNode,
        totalM: road.totalM,
        roadIdSet: new Set([roadId]),
      });
    }
  }
  return miniRoutes;
}

// ── Step 2: chain when exactly 1 candidate ────────────────────────────────────

function step2Chain(miniRoutes) {
  while (true) {
    let changed = false;
    const n = miniRoutes.length;
    outer: for (let i = 0; i < n; i++) {
      const a = miniRoutes[i];

      const toCands = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && canAppend(a, miniRoutes[j])) toCands.push(j);
      }
      if (toCands.length === 1) {
        const j = toCands[0];
        const newMR = concatMR(a, miniRoutes[j]);
        [i, j].sort((x, y) => y - x).forEach((idx) => miniRoutes.splice(idx, 1));
        miniRoutes.push(newMR);
        changed = true;
        break outer;
      }

      const fromCands = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && canPrepend(a, miniRoutes[j])) fromCands.push(j);
      }
      if (fromCands.length === 1) {
        const j = fromCands[0];
        const newMR = concatMR(miniRoutes[j], a);
        [i, j].sort((x, y) => y - x).forEach((idx) => miniRoutes.splice(idx, 1));
        miniRoutes.push(newMR);
        changed = true;
        break outer;
      }
    }
    if (!changed) break;
  }
  return miniRoutes;
}

// ── Step 3: chain with 2+ candidates (greedy longest) ─────────────────────────

function step3Chain(miniRoutes) {
  while (miniRoutes.length > 1) {
    const longestIdx = miniRoutes.reduce(
      (best, mr, i) => (mr.totalM > miniRoutes[best].totalM ? i : best), 0
    );
    const longest = miniRoutes[longestIdx];
    const cands = new Map();
    for (let j = 0; j < miniRoutes.length; j++) {
      if (j === longestIdx) continue;
      const b = miniRoutes[j];
      if (canAppend(longest, b)) cands.set(j, 'append');
      else if (canPrepend(longest, b)) cands.set(j, 'prepend');
    }
    if (cands.size < 2) break;

    let bestJ = -1, bestLen = -1;
    for (const [j] of cands) {
      if (miniRoutes[j].totalM > bestLen) { bestLen = miniRoutes[j].totalM; bestJ = j; }
    }
    const pos = cands.get(bestJ);
    const bestB = miniRoutes[bestJ];
    const newMR = pos === 'append' ? concatMR(longest, bestB) : concatMR(bestB, longest);
    [longestIdx, bestJ].sort((a, b) => b - a).forEach((idx) => miniRoutes.splice(idx, 1));
    miniRoutes.push(newMR);
  }
  return miniRoutes;
}

// ── Step 3.5: filter mini-routes with no bbox intersection ────────────────────

function segmentIntersectsBboxRB(lon0, lat0, lon1, lat1, bbox) {
  if (
    (lon0 >= bbox.minLon && lon0 <= bbox.maxLon && lat0 >= bbox.minLat && lat0 <= bbox.maxLat) ||
    (lon1 >= bbox.minLon && lon1 <= bbox.maxLon && lat1 >= bbox.minLat && lat1 <= bbox.maxLat)
  ) return true;
  const dx = lon1 - lon0, dy = lat1 - lat0;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, lon0 - bbox.minLon) && clip(dx, bbox.maxLon - lon0) &&
    clip(-dy, lat0 - bbox.minLat) && clip(dy, bbox.maxLat - lat0) && t0 <= t1;
}

function step35Filter(miniRoutes, bbox) {
  return miniRoutes.filter((mr) => {
    for (const entry of mr.roads) {
      for (const s of (entry.road_sectors || [])) {
        if (segmentIntersectsBboxRB(s.lon0, s.lat0, s.lon1, s.lat1, bbox)) return true;
      }
    }
    return false;
  });
}

// ── Step 4: select top 1–2 mini-routes ────────────────────────────────────────

const SECOND_ROUTE_LENGTH_THRESHOLD_RATIO = 0.0;

function step4Select(miniRoutes) {
  if (!miniRoutes.length) return [];
  const sorted = [...miniRoutes].sort((a, b) => b.totalM - a.totalM);
  const result = [sorted[0]];
  if (sorted.length >= 2 && sorted[1].totalM >= sorted[0].totalM * SECOND_ROUTE_LENGTH_THRESHOLD_RATIO) {
    result.push(sorted[1]);
  }
  return result;
}

// ── Output builders ────────────────────────────────────────────────────────────

function buildPathItems(miniRoute) {
  const { roads } = miniRoute;
  const n = roads.length;
  const items = [];
  for (let i = 0; i < n; i++) {
    const entry = roads[i];
    const sectors = entry.road_sectors || [];
    if (!sectors.length) continue;
    const prevId = i > 0     ? (parseInt(roads[i - 1].road_id, 10) || -1) : -1;
    const nextId = i < n - 1 ? (parseInt(roads[i + 1].road_id, 10) || -1) : -1;
    const dir = sectors[0]?.direction;
    items.push({
      road_id: parseInt(entry.road_id, 10) || entry.road_id,
      oneway: entry.oneway,
      width_m: entry.width_m,
      road_sectors: sectors,
      min_side_road_id: dir === 'ascend' ? prevId : nextId,
      max_side_road_id: dir === 'ascend' ? nextId : prevId,
    });
  }
  return items;
}

function buildBbox(routes) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const path of routes) {
    for (const item of path) {
      for (const s of (item.road_sectors || [])) {
        if (s.lat0 < minLat) minLat = s.lat0; if (s.lat0 > maxLat) maxLat = s.lat0;
        if (s.lat1 < minLat) minLat = s.lat1; if (s.lat1 > maxLat) maxLat = s.lat1;
        if (s.lon0 < minLon) minLon = s.lon0; if (s.lon0 > maxLon) maxLon = s.lon0;
        if (s.lon1 < minLon) minLon = s.lon1; if (s.lon1 > maxLon) maxLon = s.lon1;
      }
    }
  }
  return isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
}

function buildHighwayStat(selected) {
  const stat = {};
  for (const mr of selected) {
    for (const entry of mr.roads) {
      const hw = entry.highway;
      if (!hw) continue;
      const lengthM = (entry.road_sectors || []).reduce((s, r) => s + (r.length_m || 0), 0);
      if (!stat[hw]) stat[hw] = { count: 0, length_m: 0 };
      stat[hw].count += 1;
      stat[hw].length_m += lengthM;
    }
  }
  return stat;
}

// ── Names builder (port of _build_names from refine_osm_jproad_routes_in_db.py) ─

const VARIATIONS = {
  GA: ['ヶ', 'ケ', 'が', 'ガ'],
  NO: ['の', 'ノ', '之', '乃'],
  TSU: ['つ', 'ツ', 'ッ'],
};
const KANJI = '[一-龠]';
const VARIATION_PATTERNS = Object.fromEntries(
  Object.entries(VARIATIONS).map(([key, vars]) => [
    key,
    new RegExp(`^(.*${KANJI})(${vars.join('|')})(${KANJI}.*)$`),
  ])
);

function buildNames(name) {
  if (!name) return [];
  const names = [{ value: name, is_global: true, locations: [] }];
  for (const [key, pattern] of Object.entries(VARIATION_PATTERNS)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const [, prefix, , suffix] = match;
    for (const v of VARIATIONS[key]) {
      const newName = `${prefix}${v}${suffix}`;
      if (newName !== name) names.push({ value: newName, is_global: true, locations: [] });
    }
  }
  return names;
}

// ── BBox ↔ GeoJSON ────────────────────────────────────────────────────────────

function bboxToGeoJsonPolygon(bbox) {
  return {
    type: 'Polygon',
    coordinates: [[
      [bbox.minLon, bbox.minLat],
      [bbox.maxLon, bbox.minLat],
      [bbox.maxLon, bbox.maxLat],
      [bbox.minLon, bbox.maxLat],
      [bbox.minLon, bbox.minLat],
    ]],
  };
}

// ── Main: build route preview ──────────────────────────────────────────────────

/**
 * Build routes from an explicit list of road IDs (used when extending a route).
 * Runs Steps 1–4 + 3.5 from the route-building algorithm.
 */
async function buildRouteFromRoadIds(roadIds, cityBbox, osmDb) {
  const jpRoads = osmDb.collection('jproads');
  const roadDocs = await jpRoads
    .find({ id: { $in: roadIds.map(Number) } }, { projection: ROAD_PROJECTION })
    .toArray();

  const roadInfoMap = new Map();
  for (const doc of roadDocs) {
    const info = buildRoadInfo(doc);
    if (info) roadInfoMap.set(info.roadId, info);
  }

  const validIds = [...roadInfoMap.keys()];
  if (!validIds.length) {
    return { routes: [], bbox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }, highway_stat: {} };
  }

  let miniRoutes = buildInitialMiniRoutes(validIds, roadInfoMap);
  miniRoutes = step2Chain(miniRoutes);
  miniRoutes = step3Chain(miniRoutes);
  if (cityBbox) miniRoutes = step35Filter(miniRoutes, cityBbox);
  const selected = step4Select(miniRoutes);

  const routes = selected.map((mr) => buildPathItems(mr)).filter((p) => p.length > 0);
  return { routes, bbox: buildBbox(routes), highway_stat: buildHighwayStat(selected) };
}

async function buildRoutePreview(roadName, cityBbox, osmDb) {
  const jpRoads = osmDb.collection('jproads');
  const bboxPolygon = bboxToGeoJsonPolygon(cityBbox);

  const roadDocs = await jpRoads
    .find(
      { name: roadName, centerline: { $geoIntersects: { $geometry: bboxPolygon } } },
      { projection: ROAD_PROJECTION }
    )
    .toArray();

  if (!roadDocs.length) {
    return { routes: [], bbox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }, highway_stat: {}, names: buildNames(roadName) };
  }

  const roadInfoMap = new Map();
  for (const doc of roadDocs) {
    const info = buildRoadInfo(doc);
    if (info) roadInfoMap.set(info.roadId, info);
  }

  const roadIds = [...roadInfoMap.keys()];
  let miniRoutes = buildInitialMiniRoutes(roadIds, roadInfoMap);
  miniRoutes = step2Chain(miniRoutes);
  miniRoutes = step3Chain(miniRoutes);
  miniRoutes = step35Filter(miniRoutes, cityBbox);
  const selected = step4Select(miniRoutes);

  const routes = selected.map((mr) => buildPathItems(mr)).filter((p) => p.length > 0);
  return {
    routes,
    bbox: buildBbox(routes),
    highway_stat: buildHighwayStat(selected),
    names: buildNames(roadName),
  };
}

// ── Main: save route to jproad_routes ─────────────────────────────────────────

async function saveRoute(previewData, osmDb) {
  const col = osmDb.collection('jproad_routes');

  const maxDoc = await col
    .find({ relation_id: { $gte: 9999000001 } })
    .sort({ relation_id: -1 })
    .limit(1)
    .toArray();

  const nextRelationId = maxDoc.length > 0 ? maxDoc[0].relation_id + 1 : 9999000001;

  const allRoadIds = new Set();
  for (const path of previewData.routes) {
    for (const item of path) allRoadIds.add(String(item.road_id));
  }
  const roads = [...allRoadIds].map((rid) => ({ road_id: parseInt(rid, 10) || rid, role: '' }));

  const doc = {
    relation_id: nextRelationId,
    roads,
    is_deleted: false,
    bbox: previewData.bbox,
    highway_stat: previewData.highway_stat || {},
    names: previewData.names,
    routes: previewData.routes,
    ref: '',
    network: '',
    updated_at: (() => {
      const pad = (n) => String(n).padStart(2, '0');
      const jst = new Date(Date.now() + 9 * 3600 * 1000);
      return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;
    })(),
  };

  const result = await col.insertOne(doc);
  return { relation_id: nextRelationId, _id: result.insertedId };
}

module.exports = {
  buildRoutePreview,
  saveRoute,
  buildRouteFromRoadIds,
  // Exported utilities for use in index.js
  nodeToInt,
  isForwardOnlyRoad,
  bearingDegreesInt,
  ROAD_PROJECTION,
};
