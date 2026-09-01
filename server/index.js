'use strict';

const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const { buildRoutePreview, saveRoute, buildRouteFromRoadIds, buildRoadItemsForDirections, applyIntersectionGroupKeys, applyIsLoopFlags, nodeToInt, isForwardOnlyRoad, bearingDegreesInt, hubenyJapanM, ROAD_PROJECTION } = require('./routeBuilder');
const { getNameVariations } = require('../src/utils/nameUtils');

const app = express();
const PORT = 5000;
const MONGO_URL = 'mongodb://192.168.1.3:27017';
const DB_NAME = 'estat';
const COLLECTION = 'boundaries';
const ROUTES_COLLECTION = 'jproad_routes';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '20mb' }));

let estatDb;
let osmDb;

async function connectDB() {
  const client = await MongoClient.connect(MONGO_URL);
  estatDb = client.db(DB_NAME);
  osmDb   = client.db('osm');
  console.log('Connected to MongoDB (estat + osm)');
}

/**
 * Build the MongoDB query for fetching dropdown options at a given level.
 * Level is 1-based.
 * parents: array of selected names for levels 1..(level-1)
 */
function buildOptionsQuery(level, parents) {
  if (level === 1) {
    return { 'properties.admin_level': 4 };
  }

  const size = level;
  const andConditions = [
    { 'properties.address_layers': { $size: size } },
    ...parents.map((p) => ({ 'properties.address_layers': p })),
  ];

  if (level === 2) {
    return { 'properties.admin_level': { $gte: 7, $lte: 8 }, $and: andConditions };
  } else if (level === 3) {
    return { 'properties.admin_level': { $gte: 8 }, $and: andConditions };
  } else {
    return { $and: andConditions };
  }
}

/**
 * GET /api/locations/options?level=N&parents=name1,name2,...
 * Returns [{id, name}] sorted by properties.id
 */
app.get('/api/locations/options', async (req, res) => {
  try {
    const level = parseInt(req.query.level, 10);
    if (isNaN(level) || level < 1) {
      return res.status(400).json({ error: 'Invalid level' });
    }

    const parents =
      req.query.parents && req.query.parents.trim()
        ? req.query.parents.split(',').map((s) => s.trim())
        : [];

    const query = buildOptionsQuery(level, parents);

    const docs = await estatDb
      .collection(COLLECTION)
      .find(query, {
        projection: { 'properties.id': 1, 'properties.name': 1, _id: 0 },
      })
      .sort({ 'properties.id': 1 })
      .toArray();

    res.json(
      docs.map((d) => ({
        id: d.properties.id,
        name: d.properties.name,
      }))
    );
  } catch (err) {
    console.error('/api/locations/options error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/locations/polygon?addresses=name1,name2,...
 * Returns the GeoJSON Feature document for the specified address path.
 * addresses is an ordered list from level 1 to selected level.
 */
app.get('/api/locations/polygon', async (req, res) => {
  try {
    const addresses =
      req.query.addresses && req.query.addresses.trim()
        ? req.query.addresses.split(',').map((s) => s.trim())
        : [];

    if (!addresses.length) {
      return res.status(400).json({ error: 'addresses required' });
    }

    const query = {
      $and: [
        { 'properties.address_layers': { $size: addresses.length } },
        { 'properties.address_layers': { $all: addresses } },
      ],
    };

    const doc = await estatDb.collection(COLLECTION).findOne(query, {
      projection: { geometry: 1, properties: 1, type: 1, _id: 0 },
    });

    if (!doc) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(doc);
  } catch (err) {
    console.error('/api/locations/polygon error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────

// ── Intersection helpers ──────────────────────────────────────────────────────

// An intersection may only be attached to a road_sector that is at most this far
// (in metres) from the intersection's own coordinate. Beyond it we treat the
// intersection as "not on the saved geometry" and drop it.
const INTERSECTION_SNAP_MAX_M = 40;

/** Closest point (in lon/lat degrees) on segment A→B to point P. */
function closestPointOnSegmentDeg(pLat, pLon, aLat, aLon, bLat, bLon) {
  const dx = bLon - aLon, dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-14
    ? 0
    : Math.max(0, Math.min(1, ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq));
  return [aLat + t * dy, aLon + t * dx];
}

/**
 * Snap (lat, lon) onto the nearest road_sector and return its identity.
 * @param {{road_id:number, coord_index:number, lon0,lat0,lon1,lat1:number}[]} sectors
 * @returns {{road_id:number, coord_index:number, lat:number, lon:number, distM:number}|null}
 */
function snapPointToSectors(lat, lon, sectors) {
  let best = null;
  for (const s of sectors) {
    const [cLat, cLon] = closestPointOnSegmentDeg(lat, lon, s.lat0, s.lon0, s.lat1, s.lon1);
    const distM = hubenyJapanM(lat, lon, cLat, cLon);
    if (!best || distM < best.distM) {
      best = { road_id: s.road_id, coord_index: s.coord_index, lat: cLat, lon: cLon, distM };
    }
  }
  return best;
}

/**
 * buildIntersectionGroup
 * Given intersection documents from jpintersections, returns the list of
 * intersection items to add to a route's intersection_groups entry.
 *
 * The road_id / coord_index carried by jpintersections.refined_roads are indexed
 * against the *full* road centreline (a vertex index), which does not line up
 * with routes[].roads[].road_sectors[].coord_index (a segment index) and can
 * point past the last sector. We therefore ignore those two fields and snap the
 * intersection's coordinate onto the actual saved road_sectors instead.
 *
 * @param {object[]} intersectionDocs - docs from jpintersections collection
 * @param {object[]} pathSectors      - {road_id, coord_index, lon0,lat0,lon1,lat1} of the new roads in this group
 * @param {number[]} roadIds          - road IDs being added (new/extended roads)
 * @param {string[]} usedNames        - NFKC-normalised names already in the route
 */
function buildIntersectionGroup(intersectionDocs, pathSectors, roadIds, usedNames = []) {
  if (!Array.isArray(roadIds) || roadIds.length === 0) return [];
  if (!Array.isArray(pathSectors) || pathSectors.length === 0) return [];

  const roadIdsSet   = new Set(roadIds.map(Number));
  const usedNamesSet = new Set(usedNames);

  const seenRoads = {}; // name → refinedRoad[]
  const seenId    = {}; // name → intersection id

  for (const doc of intersectionDocs) {
    for (const refinedRoad of (doc?.refined_roads || [])) {
      if (!refinedRoad) continue;
      const name = String(doc?.name || '').normalize('NFKC').trim();
      if (!name || usedNamesSet.has(name)) continue;
      if (!seenRoads[name]) {
        seenRoads[name] = [];
        seenId[name]    = doc?.id;
      }
      if (roadIdsSet.has(Number(refinedRoad.road_id))) {
        seenRoads[name].push(refinedRoad);
      }
    }
  }

  const group = [];
  for (const [name, candidates] of Object.entries(seenRoads)) {
    if (!candidates.length) continue;
    let pick = null;
    if (candidates.length === 1) {
      pick = candidates[0];
    } else {
      const lats = candidates.map((r) => r.lat);
      const lons = candidates.map((r) => r.lon);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const latDistM = hubenyJapanM(minLat, minLon, maxLat, minLon);
      const lonDistM = hubenyJapanM(minLat, minLon, minLat, maxLon);
      const sorted = [...candidates].sort(
        latDistM < lonDistM ? (a, b) => a.lon - b.lon : (a, b) => a.lat - b.lat
      );
      pick = sorted[Math.floor(sorted.length / 2)];
    }
    if (!pick) continue;

    // Ignore refined_roads' own road_id / coord_index (see doc comment) and
    // resolve them from the real saved geometry instead.
    const snap = snapPointToSectors(pick.lat, pick.lon, pathSectors);
    if (!snap || snap.distM > INTERSECTION_SNAP_MAX_M) continue;

    group.push({
      intersection_id: seenId[name],
      names:           getNameVariations(name),
      road_id:         snap.road_id,
      coord_index:     snap.coord_index,
      lat:             pick.lat,
      lon:             pick.lon,
      highway_tag:     pick.highway_tag,
    });
  }
  return group;
}

/**
 * buildUpdatedIntersectionGroups
 * For the given routes array and the set of *newly added* road IDs, queries
 * jpintersections and appends new intersection items to the relevant groups.
 * Returns the updated groups object, or null if nothing changed.
 *
 * @param {object[]} routes        - route paths (after save/extend, keys already applied)
 * @param {number[]} newRoadIds    - road IDs that were added in this operation
 * @param {object}   existingGroups- current doc.intersection_groups (may be {})
 */
async function buildUpdatedIntersectionGroups(routes, newRoadIds, existingGroups) {
  const newSet = new Set(newRoadIds.map(Number));

  // Determine which road IDs belong to which group key
  const keyToNewRoads = {}; // key → Set<number>
  for (const path of (routes || [])) {
    const key = path.intersection_group_key;
    if (!key) continue;
    for (const r of (path.roads || [])) {
      const id = Number(r.road_id);
      if (newSet.has(id)) {
        if (!keyToNewRoads[key]) keyToNewRoads[key] = new Set();
        keyToNewRoads[key].add(id);
      }
    }
  }

  if (Object.keys(keyToNewRoads).length === 0) return null;

  const updated = { ...(existingGroups || {}) };
  let changed = false;

  for (const [key, roadIdsSet] of Object.entries(keyToNewRoads)) {
    const roadIds = [...roadIdsSet];
    const docs = await osmDb.collection('jpintersections')
      .find({ 'refined_roads.road_id': { $in: roadIds } })
      .toArray();

    // road_sectors of the newly added roads under this group key – the geometry
    // an intersection coordinate is snapped onto to derive road_id/coord_index.
    const pathSectors = [];
    for (const path of (routes || [])) {
      if (path.intersection_group_key !== key) continue;
      for (const r of (path.roads || [])) {
        if (!roadIdsSet.has(Number(r.road_id))) continue;
        for (const s of (r.road_sectors || [])) {
          pathSectors.push({
            road_id: Number(r.road_id),
            coord_index: s.coord_index,
            lon0: s.lon0, lat0: s.lat0, lon1: s.lon1, lat1: s.lat1,
          });
        }
      }
    }

    // Use only names already in THIS group to avoid false deduplication across
    // groups that share the same physical roads (e.g. key "0" vs key "1").
    const usedNamesForKey = new Set(
      ((existingGroups || {})[key] || [])
        .flatMap((i) => (Array.isArray(i.names) ? i.names : []))
    );

    const newItems = buildIntersectionGroup(docs, pathSectors, roadIds, [...usedNamesForKey]);
    if (newItems.length > 0) {
      updated[key] = [...(updated[key] || []), ...newItems];
      changed = true;
    }
  }

  return changed ? updated : null;
}

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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBboxQuery(req) {
  const minLon = parseFloat(req.query.minLon);
  const minLat = parseFloat(req.query.minLat);
  const maxLon = parseFloat(req.query.maxLon);
  const maxLat = parseFloat(req.query.maxLat);
  if ([minLon, minLat, maxLon, maxLat].some(isNaN)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function pointInBbox(lon, lat, bbox) {
  return (
    lon >= bbox.minLon && lon <= bbox.maxLon &&
    lat >= bbox.minLat && lat <= bbox.maxLat
  );
}

/**
 * Liang-Barsky line clipping test.
 * Returns true if the segment intersects or lies inside the bbox.
 */
function segmentIntersectsBbox(lon0, lat0, lon1, lat1, bbox) {
  if (pointInBbox(lon0, lat0, bbox) || pointInBbox(lon1, lat1, bbox)) {
    return true;
  }

  const dx = lon1 - lon0;
  const dy = lat1 - lat0;
  let t0 = 0;
  let t1 = 1;

  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  return (
    clip(-dx, lon0 - bbox.minLon) &&
    clip(dx, bbox.maxLon - lon0) &&
    clip(-dy, lat0 - bbox.minLat) &&
    clip(dy, bbox.maxLat - lat0) &&
    t0 <= t1
  );
}

function subRouteIntersectsBbox(routeObj, bbox) {
  const roads = Array.isArray(routeObj) ? routeObj : (routeObj?.roads || []);
  for (const road of roads) {
    if (!Array.isArray(road.road_sectors)) continue;
    for (const s of road.road_sectors) {
      if (segmentIntersectsBbox(s.lon0, s.lat0, s.lon1, s.lat1, bbox)) {
        return true;
      }
    }
  }
  return false;
}

function getPrimaryRouteName(doc) {
  const names = Array.isArray(doc.names) ? doc.names : [];
  if (names.length === 0) return '';
  const primary = names[0];
  // Support both string[] (new schema) and {value}[] (old schema)
  if (typeof primary === 'string') return primary;
  if (primary && typeof primary.value === 'string') return primary.value;
  return '';
}

/**
 * GET /api/routes/in-bbox?minLon=&minLat=&maxLon=&maxLat=&motorwaysOnly=
 * Returns [{name, relation_id, routes}] for routes whose bbox overlaps the query bbox.
 * Uses the bbox_idx compound index for fast filtering.
 * When motorwaysOnly=true, only docs with a highway_stat.motorway entry are returned
 * (used when the selected location's boundary doc has properties.motorways_only === true).
 */
app.get('/api/routes/in-bbox', async (req, res) => {
  try {
    const minLon = parseFloat(req.query.minLon);
    const minLat = parseFloat(req.query.minLat);
    const maxLon = parseFloat(req.query.maxLon);
    const maxLat = parseFloat(req.query.maxLat);
    const motorwaysOnly = req.query.motorwaysOnly === 'true';

    if ([minLon, minLat, maxLon, maxLat].some(isNaN)) {
      return res.status(400).json({ error: 'Invalid bbox parameters' });
    }

    // bbox overlap: route.bbox must intersect the query bbox
    const query = {
      'bbox.minLon': { $lte: maxLon },
      'bbox.maxLon': { $gte: minLon },
      'bbox.minLat': { $lte: maxLat },
      'bbox.maxLat': { $gte: minLat },
      is_deleted: { $ne: true },
    };

    if (motorwaysOnly) {
      query['highway_stat.motorway'] = { $exists: true };
    }

    const docs = await osmDb
      .collection(ROUTES_COLLECTION)
      .find(query, { projection: { names: 1, relation_id: 1, routes: 1, _id: 0 } })
      .toArray();

    const bbox = { minLon, minLat, maxLon, maxLat };
    const filteredDocs = [];
    for (const doc of docs) {
      const matchingSubRoutes = (doc.routes || []).filter((subRoute) =>
        subRouteIntersectsBbox(subRoute, bbox)
      );
      if (matchingSubRoutes.length > 0) {
        filteredDocs.push({
          relation_id: doc.relation_id,
          name: getPrimaryRouteName(doc),
          routes: matchingSubRoutes,
        });
      }
    }

    console.log(
      `/api/routes/in-bbox: coarse=${docs.length}, precise=${filteredDocs.length}`
    );
    res.json(filteredDocs);
  } catch (err) {
    console.error('/api/routes/in-bbox error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Intersection endpoints ────────────────────────────────────────────────────

/**
 * GET /api/routes/:relation_id/intersections
 * Returns { routes_keys, intersection_groups } for the specified route doc.
 */
app.get('/api/routes/:relation_id/intersections', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const doc = await osmDb.collection(ROUTES_COLLECTION).findOne(
      { relation_id },
      { projection: { routes: 1, intersection_groups: 1, _id: 0 } }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const routes_keys = (doc.routes || []).map((r) => r.intersection_group_key ?? null);
    res.json({
      routes_keys,
      intersection_groups: doc.intersection_groups || {},
    });
  } catch (err) {
    console.error('/api/routes/:id/intersections GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/routes/:relation_id/intersections
 * Body: { intersection_groups, routes_key_updates: [{path_idx, key}] }
 * Updates intersection_groups, sets any new routes[i].intersection_group_key, updates updated_at.
 */
app.put('/api/routes/:relation_id/intersections', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { intersection_groups, routes_key_updates = [] } = req.body;
    if (!intersection_groups) return res.status(400).json({ error: 'intersection_groups required' });

    const col = osmDb.collection(ROUTES_COLLECTION);
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    const $set = { intersection_groups, updated_at };

    // Apply any new intersection_group_key values to routes
    for (const { path_idx, key } of routes_key_updates) {
      $set[`routes.${path_idx}.intersection_group_key`] = parseInt(key);
    }

    await col.updateOne({ relation_id }, { $set });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/intersections PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route trim endpoints ───────────────────────────────────────────────────────

function computeBboxFromPaths(routes) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const path of (routes || [])) {
    for (const item of (path?.roads || [])) {
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

// ── Path traversal / reversal helpers ────────────────────────────────────────

/**
 * Flatten an ordered roads[] list into one sequence of road_sectors, each
 * annotated with its two endpoint nodes and their coords.
 * Convention (holds regardless of `direction`): coord0 (lat0/lon0) ↔ min_node_id,
 * coord1 (lat1/lon1) ↔ max_node_id.
 */
function flattenPathSectors(roads) {
  const out = [];
  for (const road of roads || []) {
    for (const s of road.road_sectors || []) {
      // node ids may arrive as BSON Long / {$numberLong} – normalise so === works
      out.push({
        a: nodeToInt(s.min_node_id), aLat: s.lat0, aLon: s.lon0,
        b: nodeToInt(s.max_node_id), bLat: s.lat1, bLon: s.lon1,
        direction: s.direction,
      });
    }
  }
  return out;
}

/**
 * True traversal endpoints of a path, derived from sector-to-sector node
 * connectivity (min_node_id / max_node_id) rather than a single sector's
 * `direction` flag. After edits (extend/link) `direction` can disagree with the
 * road ordering — e.g. a junction node ends up labelled as the path end — but
 * the min/max_node_id adjacency stays intact. `direction` is only used as a
 * fallback for single-sector paths or where connectivity is broken.
 *
 * Returns { start: {node, lat, lon}, end: {node, lat, lon}, isLoop, broken } or null.
 */
function pathEndpoints(roads) {
  const flat = flattenPathSectors(roads);
  if (!flat.length) return null;

  const nodeEnd = (s, id) => (id === s.a
    ? { node: s.a, lat: s.aLat, lon: s.aLon }
    : { node: s.b, lat: s.bLat, lon: s.bLon });

  if (flat.length === 1) {
    const s = flat[0];
    const asc = s.direction === 'ascend';
    return {
      start: asc ? nodeEnd(s, s.a) : nodeEnd(s, s.b),
      end:   asc ? nodeEnd(s, s.b) : nodeEnd(s, s.a),
      isLoop: false,
      broken: false,
    };
  }

  // Orient the first sector by its shared node with the second.
  const s0 = flat[0];
  const s1 = flat[1];
  const shared = [s0.a, s0.b].find((n) => n === s1.a || n === s1.b);
  let broken = shared === undefined;

  const startId = broken
    ? (s0.direction === 'ascend' ? s0.a : s0.b)
    : (shared === s0.a ? s0.b : s0.a);
  const start = nodeEnd(s0, startId);

  // Walk sector by sector, carrying the running "far" node forward.
  let cur = broken ? (startId === s0.a ? s0.b : s0.a) : shared;
  for (let i = 1; i < flat.length; i++) {
    const s = flat[i];
    if (cur === s.a) cur = s.b;
    else if (cur === s.b) cur = s.a;
    else { broken = true; cur = s.direction === 'ascend' ? s.b : s.a; }
  }
  const end = nodeEnd(flat[flat.length - 1], cur);

  return { start, end, isLoop: start.node === end.node, broken };
}

/** Traversal-start node of an ordered roads[] list. */
function pathStartNode(roads) {
  return pathEndpoints(roads)?.start.node ?? null;
}

/** Traversal-end node of an ordered roads[] list. */
function pathEndNode(roads) {
  return pathEndpoints(roads)?.end.node ?? null;
}

/**
 * Reverse an ordered roads[] list:
 *   (1) reverse roads order
 *   (2) reverse road_sectors within each road
 *   (3) flip each sector's direction ascend↔descend
 * min/max_side_road_id are unchanged (they refer to road endpoint nodes, not path order).
 */
function reverseRoadsArr(roads) {
  return [...roads].reverse().map((road) => ({
    ...road,
    road_sectors: [...(road.road_sectors || [])].reverse().map((s) => ({
      ...s,
      direction: s.direction === 'ascend' ? 'descend' : 'ascend',
    })),
  }));
}

/**
 * True when an ordered roads[] list can be legally reversed: every one-way road
 * must end up traversed in its legal ('ascend') direction after the flip, i.e.
 * every one-way road is currently traversed 'descend'. In normal data one-way
 * roads are always stored 'ascend', so any one-way road makes this false.
 */
function canReversePath(roads) {
  return (roads || []).every((r) =>
    !r.oneway || (r.road_sectors || []).every((s) => s.direction === 'descend'));
}

/**
 * Filter intersection_groups[trimKey] down to items that still sit on a surviving
 * road_sector (matched by road_id + coord_index) somewhere in `routes` under `trimKey`.
 * Used after a trim so intersections on removed roads/road_sectors are dropped too.
 */
function filterIntersectionGroupForTrim(existingGroups, trimKey, routes) {
  if (!trimKey || !existingGroups[trimKey]) return existingGroups;
  const validCoordIndexesByRoad = new Map();
  for (const path of routes) {
    if (path.intersection_group_key !== trimKey) continue;
    for (const r of (path.roads || [])) {
      const roadId = Number(r.road_id);
      let set = validCoordIndexesByRoad.get(roadId);
      if (!set) { set = new Set(); validCoordIndexesByRoad.set(roadId, set); }
      for (const s of (r.road_sectors || [])) set.add(s.coord_index);
    }
  }
  const filtered = (existingGroups[trimKey] || []).filter((item) => {
    const set = validCoordIndexesByRoad.get(Number(item.road_id));
    return !!set && set.has(item.coord_index);
  });
  return { ...existingGroups, [trimKey]: filtered };
}

/**
 * GET /api/routes/:relation_id/roads?path_idx=N
 * Returns the road_items array for routes[N] of the specified route doc.
 */
app.get('/api/routes/:relation_id/roads', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const path_idx = parseInt(req.query.path_idx, 10);
    if (isNaN(relation_id) || isNaN(path_idx)) {
      return res.status(400).json({ error: 'Invalid relation_id or path_idx' });
    }

    const doc = await osmDb.collection(ROUTES_COLLECTION).findOne(
      { relation_id },
      { projection: { routes: 1, _id: 0 } }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const path = (doc.routes || [])[path_idx];
    if (!path) return res.status(404).json({ error: 'Path not found' });

    res.json(path.roads || []);
  } catch (err) {
    console.error('/api/routes/:id/roads error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/routes/:relation_id/trim
 * Body: { path_idx, new_roads }
 * Replaces routes[path_idx] with new_roads, updates min/max_side_road_id on
 * the new endpoints, recomputes bbox, and sets updated_at.
 */
app.put('/api/routes/:relation_id/trim', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { path_idx, new_roads } = req.body;
    if (!Array.isArray(new_roads) || new_roads.length === 0) {
      return res.status(400).json({ error: 'new_roads array required' });
    }

    const col = osmDb.collection(ROUTES_COLLECTION);
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, intersection_groups: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Enforce -1 on new endpoint side-road IDs
    const updated = new_roads.map((r, i) => {
      let road = { ...r };
      if (i === 0) road = { ...road, min_side_road_id: -1 };
      if (i === new_roads.length - 1) road = { ...road, max_side_road_id: -1 };
      return road;
    });

    const routes = applyIsLoopFlags((doc.routes || []).map((p, i) => (i === path_idx ? { ...p, roads: updated } : p)));
    const bbox = computeBboxFromPaths(routes);

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    // Remove intersections that sat on roads/road_sectors trimmed away from this path
    const trimKey = doc.routes[path_idx]?.intersection_group_key;
    const existingGroups = doc.intersection_groups || {};
    const $set = { routes, bbox, updated_at };
    if (trimKey && existingGroups[trimKey]) {
      $set.intersection_groups = filterIntersectionGroupForTrim(existingGroups, trimKey, routes);
    }

    await col.updateOne({ relation_id }, { $set });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/trim error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route link endpoints ──────────────────────────────────────────────────────

/**
 * POST /api/routes/:relation_id/find-linkable
 * Body: { node_id, endpoint_type: 'start'|'end' }
 * Returns candidate routes whose endpoint node matches, suitable for linking.
 */
app.post('/api/routes/:relation_id/find-linkable', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { node_id, endpoint_type } = req.body;
    if (!node_id || !endpoint_type) return res.status(400).json({ error: 'node_id and endpoint_type required' });

    const col = osmDb.collection(ROUTES_COLLECTION);
    // Step 3.1: find all routes that contain this node_id anywhere in their road_sectors
    const [byMin, byMax] = await Promise.all([
      col.find({ 'routes.roads.road_sectors.min_node_id': node_id, is_deleted: { $ne: true } },
               { projection: { relation_id: 1, names: 1, routes: 1, _id: 0 } }).toArray(),
      col.find({ 'routes.roads.road_sectors.max_node_id': node_id, is_deleted: { $ne: true } },
               { projection: { relation_id: 1, names: 1, routes: 1, _id: 0 } }).toArray(),
    ]);

    // Merge, deduplicate, exclude self
    const seen = new Set();
    const allDocs = [];
    for (const doc of [...byMin, ...byMax]) {
      if (doc.relation_id === relation_id) continue;
      if (!seen.has(doc.relation_id)) { seen.add(doc.relation_id); allDocs.push(doc); }
    }

    // Build a [lat,lon] polyline for an ordered roads[] list (respects direction).
    const buildCoords = (roads) => {
      const coords = [];
      let prev = null;
      for (const road of roads) {
        for (const s of (road.road_sectors || [])) {
          const [sLat, sLon, eLat, eLon] = s.direction === 'ascend'
            ? [s.lat0, s.lon0, s.lat1, s.lon1]
            : [s.lat1, s.lon1, s.lat0, s.lon0];
          if (!prev || Math.abs(sLat - prev[0]) > 1e-7 || Math.abs(sLon - prev[1]) > 1e-7)
            coords.push([sLat, sLon]);
          coords.push([eLat, eLon]);
          prev = [eLat, eLon];
        }
      }
      return coords;
    };

    // Steps 3.2 + 3.3: filter to routes whose endpoint node matches.
    //   direct  : our END ↔ their START, or our START ↔ their END (head-to-tail)
    //   reverse : our END ↔ their END,   or our START ↔ their START (reverse route_b first)
    // A same-type (reverse) match is only offered when route_b can be legally
    // reversed. When a doc yields a direct match, its reverse matches are dropped.
    const results = [];
    for (const doc of allDocs) {
      const perDoc = [];
      let hasDirect = false;
      for (let pi = 0; pi < (doc.routes || []).length; pi++) {
        const roads = doc.routes[pi]?.roads || [];
        if (!roads.length) continue;

        const startNode = pathStartNode(roads);
        const endNode = pathEndNode(roads);
        const nearNode = endpoint_type === 'end' ? startNode : endNode; // direct
        const farNode = endpoint_type === 'end' ? endNode : startNode;  // reverse

        let reverse = null;
        if (nearNode === node_id) reverse = false;
        else if (farNode === node_id && canReversePath(roads)) reverse = true;
        if (reverse === null) continue;

        if (reverse === false) hasDirect = true;
        const roadsForCoords = reverse ? reverseRoadsArr(roads) : roads;
        perDoc.push({
          relation_id: doc.relation_id,
          name: getPrimaryRouteName(doc),
          path_idx: pi,
          reverse,
          coords: buildCoords(roadsForCoords),
        });
      }
      for (const c of perDoc) {
        if (hasDirect && c.reverse) continue;
        results.push(c);
      }
    }
    res.json(results);
  } catch (err) {
    console.error('/api/routes/:id/find-linkable error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routes/:relation_id/link
 * Body: { path_idx, endpoint_type, candidate_relation_id, candidate_path_idx, reverse }
 * Appends/prepends candidate path's roads to the original route's path.
 * When `reverse` is true the candidate path is reversed first (start–start / end–end join).
 */
app.post('/api/routes/:relation_id/link', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { path_idx, endpoint_type, candidate_relation_id, candidate_path_idx, reverse } = req.body;

    const col = osmDb.collection(ROUTES_COLLECTION);
    const [origDoc, candDoc] = await Promise.all([
      col.findOne({ relation_id }, { projection: { routes: 1, roads: 1, _id: 0 } }),
      col.findOne({ relation_id: candidate_relation_id }, { projection: { routes: 1, _id: 0 } }),
    ]);
    if (!origDoc || !candDoc) return res.status(404).json({ error: 'Route not found' });

    const origRoads = [...((origDoc.routes[path_idx]?.roads) || [])];
    let candRoads = [...((candDoc.routes[candidate_path_idx]?.roads) || [])];
    if (!origRoads.length || !candRoads.length) return res.status(400).json({ error: 'Empty roads' });
    if (reverse) {
      if (!canReversePath(candRoads)) return res.status(400).json({ error: 'Candidate path cannot be reversed' });
      candRoads = reverseRoadsArr(candRoads);
    }

    let newRoads;
    if (endpoint_type === 'end') {
      // Append candidate roads after original
      const lastOrig = { ...origRoads[origRoads.length - 1] };
      const firstCand = { ...candRoads[0] };
      const d1 = lastOrig.road_sectors?.[0]?.direction;
      if (d1 === 'ascend') lastOrig.max_side_road_id = firstCand.road_id;
      else lastOrig.min_side_road_id = firstCand.road_id;
      const d2 = firstCand.road_sectors?.[0]?.direction;
      if (d2 === 'ascend') firstCand.min_side_road_id = lastOrig.road_id;
      else firstCand.max_side_road_id = lastOrig.road_id;
      origRoads[origRoads.length - 1] = lastOrig;
      candRoads[0] = firstCand;
      newRoads = [...origRoads, ...candRoads];
    } else { // 'start'
      // Prepend candidate roads before original
      const firstOrig = { ...origRoads[0] };
      const lastCand = { ...candRoads[candRoads.length - 1] };
      const d1 = firstOrig.road_sectors?.[0]?.direction;
      if (d1 === 'ascend') firstOrig.min_side_road_id = lastCand.road_id;
      else firstOrig.max_side_road_id = lastCand.road_id;
      const lastCandSectors = lastCand.road_sectors || [];
      const d2 = lastCandSectors[lastCandSectors.length - 1]?.direction;
      if (d2 === 'ascend') lastCand.max_side_road_id = firstOrig.road_id;
      else lastCand.min_side_road_id = firstOrig.road_id;
      origRoads[0] = firstOrig;
      candRoads[candRoads.length - 1] = lastCand;
      newRoads = [...candRoads, ...origRoads];
    }

    const newRoutes = applyIsLoopFlags(origDoc.routes.map((p, i) => i === path_idx ? { ...p, roads: newRoads } : p));
    const bbox = computeBboxFromPaths(newRoutes);

    // Merge top-level roads[] with new road_ids from candidate
    const existingIds = new Set((origDoc.roads || []).map(r => Number(r.road_id)));
    const newTopRoads = [
      ...(origDoc.roads || []),
      ...candRoads.filter(r => !existingIds.has(Number(r.road_id))).map(r => ({ road_id: r.road_id, role: '' })),
    ];

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    await col.updateOne({ relation_id }, { $set: { routes: newRoutes, roads: newTopRoads, bbox, updated_at } });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route extension endpoints ─────────────────────────────────────────────────

/**
 * PUT /api/routes/:relation_id/sector-trim
 * Body: { path_idx, new_roads }
 * Same as /trim but designed for road-sector–level changes.
 * Replaces routes[path_idx].roads with new_roads, recomputes bbox, updates timestamps.
 */
app.put('/api/routes/:relation_id/sector-trim', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { path_idx, new_roads } = req.body;
    if (!Array.isArray(new_roads) || new_roads.length === 0) {
      return res.status(400).json({ error: 'new_roads array required' });
    }

    const col = osmDb.collection(ROUTES_COLLECTION);
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, intersection_groups: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Enforce -1 on the path-endpoint side-road IDs
    const updated = new_roads.map((r, i) => {
      let road = { ...r };
      if (i === 0) road = { ...road, min_side_road_id: -1 };
      if (i === new_roads.length - 1) road = { ...road, max_side_road_id: -1 };
      return road;
    });

    const routes = applyIsLoopFlags((doc.routes || []).map((p, i) => (i === path_idx ? { ...p, roads: updated } : p)));
    const bbox = computeBboxFromPaths(routes);

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    // Remove intersections that sat on road_sectors trimmed away from this path
    const trimKey = doc.routes[path_idx]?.intersection_group_key;
    const existingGroups = doc.intersection_groups || {};
    const $set = { routes, bbox, updated_at };
    if (trimKey && existingGroups[trimKey]) {
      $set.intersection_groups = filterIntersectionGroupForTrim(existingGroups, trimKey, routes);
    }

    await col.updateOne({ relation_id }, { $set });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/sector-trim error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/routes/:relation_id/endpoints
 * Returns start/end endpoint info (lat, lon, node_id, road_id) for each path.
 */
app.get('/api/routes/:relation_id/endpoints', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const doc = await osmDb.collection(ROUTES_COLLECTION).findOne(
      { relation_id },
      { projection: { routes: 1, _id: 0 } }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const endpoints = [];

    for (let i = 0; i < (doc.routes || []).length; i++) {
      const path = doc.routes[i];
      if (!path) continue;

      const pathRoads = path?.roads || [];
      if (!pathRoads.length) continue;

      const firstRoad = pathRoads[0];
      const lastRoad = pathRoads[pathRoads.length - 1];
      if (!(firstRoad.road_sectors || []).length || !(lastRoad.road_sectors || []).length) continue;

      // Derive endpoints from sector node-connectivity, not a single sector's
      // `direction` (which can be stale after extend/link – see pathEndpoints).
      const ep = pathEndpoints(pathRoads);
      if (!ep) continue;
      if (ep.broken) {
        console.warn(`/endpoints: relation ${relation_id} path ${i} has broken sector connectivity; endpoints may be approximate`);
      }

      const hasOneway = pathRoads.some((r) => r.oneway);
      const hasSubOneway = (doc.routes || []).filter((_, j) => j !== i).some((p) => (p.roads || []).some((r) => r.oneway));

      endpoints.push({ path_idx: i, endpoint: 'start', lat: ep.start.lat, lon: ep.start.lon, node_id: ep.start.node, road_id: parseInt(firstRoad.road_id, 10), has_oneway: hasOneway, has_sub_oneway: hasSubOneway });
      endpoints.push({ path_idx: i, endpoint: 'end',   lat: ep.end.lat,   lon: ep.end.lon,   node_id: ep.end.node,   road_id: parseInt(lastRoad.road_id, 10),  has_oneway: hasOneway, has_sub_oneway: hasSubOneway });
    }

    res.json(endpoints);
  } catch (err) {
    console.error('/api/routes/:id/endpoints error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/roads/at-node?nodeId=&excludeRoadIds=
 * Returns roads connected to nodeId with bearing and travel-direction info.
 * One-way roads where the junction is at to_node are omitted.
 */
app.get('/api/roads/at-node', async (req, res) => {
  try {
    const nodeId = parseInt(req.query.nodeId, 10);
    if (isNaN(nodeId)) return res.status(400).json({ error: 'Invalid nodeId' });

    const excludeIds = (req.query.excludeRoadIds || '')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));

    const jpRoads = osmDb.collection('jproads');
    const query = { node_ref: nodeId };
    if (excludeIds.length) query.id = { $nin: excludeIds };

    const docs = await jpRoads.find(query, { projection: ROAD_PROJECTION }).toArray();

    const WIDTH_BY_HW = { motorway: 12, primary: 9, secondary: 7, residential: 5, service: 3.5 };
    const results = [];

    for (const doc of docs) {
      const coords = doc?.centerline?.coordinates;
      if (!coords || coords.length < 2) continue;

      const fromNode = nodeToInt(doc.from_node);
      const toNode   = nodeToInt(doc.to_node);
      const nodeRefs = (doc.node_ref || []).map((v) => nodeToInt(v));
      const oneway   = isForwardOnlyRoad(doc.oneway);
      const roadId   = nodeToInt(doc.id);
      if (roadId === null) continue;

      const widthM = doc.width_m != null
        ? parseFloat(doc.width_m)
        : (WIDTH_BY_HW[doc.highway] || 7);

      const isAtStart = fromNode === nodeId || (nodeRefs.length > 0 && nodeRefs[0] === nodeId);
      const isAtEnd   = toNode   === nodeId || (nodeRefs.length > 0 && nodeRefs[nodeRefs.length - 1] === nodeId);

      if (!isAtStart && !isAtEnd) continue; // intermediate node – skip

      // Entry from start → ascending travel
      if (isAtStart) {
        results.push({
          road_id: roadId,
          name: doc.name || '',
          bearing: bearingDegreesInt(coords[0][0], coords[0][1], coords[1][0], coords[1][1]),
          enter_from_start: true,
          direction: 'ascend',
          oneway,
          new_node_id: toNode,
          new_lat: coords[coords.length - 1][1],
          new_lon: coords[coords.length - 1][0],
          coords: coords.map((c) => [c[1], c[0]]),        // [lat, lon]
          width_m: widthM,
          highway: doc.highway || null,
        });
      }

      // Entry from end → descending travel.
      // One-way roads whose junction is at to_node are still returned here (as a
      // 'descend' arrow); the extend/link logic then drops them for the endpoint
      // types where that would mean traversing the road against its arrow.
      if (isAtEnd && !isAtStart) {
        const n = coords.length;
        results.push({
          road_id: roadId,
          name: doc.name || '',
          bearing: bearingDegreesInt(coords[n-1][0], coords[n-1][1], coords[n-2][0], coords[n-2][1]),
          enter_from_start: false,
          direction: 'descend',
          oneway,
          new_node_id: fromNode,
          new_lat: coords[0][1],
          new_lon: coords[0][0],
          coords: [...coords].reverse().map((c) => [c[1], c[0]]),  // reversed [lat, lon]
          width_m: widthM,
          highway: doc.highway || null,
        });
      }
    }

    res.json(results);
  } catch (err) {
    console.error('/api/roads/at-node error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routes/:relation_id/extend
 * Body: { new_road_ids, path_idx, endpoint_type, pending_roads, city_bbox }
 *
 * When path_idx + endpoint_type + pending_roads (with direction) are supplied,
 * directly appends/prepends road items to the specified path and its reverse path
 * by processing pending_roads sequentially.
 * Handles the special case where a one-way road forces the route to be reversed.
 * Falls back to rebuild-from-scratch when those fields are absent.
 */
app.post('/api/routes/:relation_id/extend', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { city_bbox, new_road_ids, path_idx, endpoint_type, pending_roads: pendingRoadsInput } = req.body;
    if (!Array.isArray(new_road_ids) || !new_road_ids.length) {
      return res.status(400).json({ error: 'new_road_ids required' });
    }

    const col = osmDb.collection(ROUTES_COLLECTION);
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, intersection_groups: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    // ── Direct extension (preferred path) ─────────────────────────────────────
    if (Array.isArray(pendingRoadsInput) && pendingRoadsInput.length &&
        path_idx != null && endpoint_type) {

      const newRoadIds = pendingRoadsInput.map((pr) => Number(pr.road_id));
      const newRoadDocs = await osmDb.collection('jproads')
        .find({ id: { $in: newRoadIds } }, { projection: ROAD_PROJECTION })
        .toArray();

      const roadDocMap = new Map();
      for (const rdoc of newRoadDocs) {
        const id = nodeToInt(rdoc.id);
        if (id !== null) roadDocMap.set(id, rdoc);
      }

      // ── Local helpers ────────────────────────────────────────────────────────

      /** Traversal-start node of a path (connectivity-based, see pathEndpoints). */
      const getStartNode = (path) => pathEndpoints(path.roads)?.start.node ?? -1;

      /** Traversal-end node of a path (connectivity-based, see pathEndpoints). */
      const getEndNode = (path) => pathEndpoints(path.roads)?.end.node ?? -1;

      const flipDir = (dir) => (dir === 'ascend' ? 'descend' : 'ascend');

      /** Build a single road item for the given traversal direction. */
      const makeItem = (rdoc, direction) => {
        const items = buildRoadItemsForDirections([rdoc], [{ road_id: nodeToInt(rdoc.id), direction }]);
        return items[0] ?? null;
      };

      /** Attach min/max_side_road_id to a road item. */
      const withSide = (item, prevId, nextId) => {
        const dir = item.road_sectors?.[0]?.direction;
        return {
          ...item,
          min_side_road_id: dir === 'ascend' ? prevId : nextId,
          max_side_road_id: dir === 'ascend' ? nextId : prevId,
        };
      };

      // ── Sequential processing ────────────────────────────────────────────────

      const curEpType = endpoint_type; // 'start' | 'end' – never changes (route_a is not reversed)
      const routes = doc.routes.map((p) => ({ ...p, roads: [...(p.roads || [])] }));
      const revIdx = routes.length === 2 ? (path_idx === 0 ? 1 : 0) : -1;

      for (const pr of pendingRoadsInput) {
        const roadId = Number(pr.road_id);
        const rdoc = roadDocMap.get(roadId);
        if (!rdoc) continue;

        const primPath = routes[path_idx];
        const node_id = curEpType === 'end' ? getEndNode(primPath) : getStartNode(primPath);
        const roadOneway = isForwardOnlyRoad(rdoc.oneway);

        // route_a (the existing route) is NEVER reversed to fit a candidate.
        // A one-way road that would have to be traversed against its arrow to
        // attach here is therefore simply un-connectable and is skipped:
        //   'end'   + one-way + descend  (to_node=node_id  – can't depart backward)
        //   'start' + one-way + ascend   (from_node=node_id – can't arrive backward)
        // One-way roads elsewhere in route_a / the reverse path do NOT matter –
        // only this join's directional consistency does.
        if (roadOneway && (
          (curEpType === 'end'   && pr.direction === 'descend') ||
          (curEpType === 'start' && pr.direction === 'ascend')
        )) continue;

        // Build road item for primary path.
        // 'end' (append)  → use direction as-is (road departs from node_id)
        // 'start' (prepend) → flip direction (road must arrive at node_id)
        const primDir = curEpType === 'start' ? flipDir(pr.direction) : pr.direction;
        const primItem = makeItem(rdoc, primDir);
        if (!primItem) continue;

        // Apply to primary path
        {
          const roads = [...routes[path_idx].roads];
          if (curEpType === 'end') {
            if (roads.length > 0) {
              const last = { ...roads[roads.length - 1] };
              const d = last.road_sectors?.[0]?.direction;
              if (d === 'ascend') last.max_side_road_id = primItem.road_id;
              else                last.min_side_road_id = primItem.road_id;
              roads[roads.length - 1] = last;
            }
            const prevId = roads.length > 0 ? roads[roads.length - 1].road_id : -1;
            roads.push(withSide(primItem, prevId, -1));
          } else { // 'start'
            if (roads.length > 0) {
              const first = { ...roads[0] };
              const d = first.road_sectors?.[0]?.direction;
              if (d === 'ascend') first.min_side_road_id = primItem.road_id;
              else                first.max_side_road_id = primItem.road_id;
              roads[0] = first;
            }
            const nextId = roads.length > 0 ? roads[0].road_id : -1;
            roads.unshift(withSide(primItem, -1, nextId));
          }
          routes[path_idx] = { ...routes[path_idx], roads };
        }

        // Apply to reverse path (bidirectional roads only – a one-way road has no
        // legal traversal in the opposite direction, so it stays on route_a only).
        if (revIdx >= 0 && !roadOneway) {
          const revDir = flipDir(primDir);
          const revItem = makeItem(rdoc, revDir);
          if (revItem) {
            const revPath = routes[revIdx];
            const roads = [...revPath.roads];
            if (curEpType === 'end') {
              // Prepend to revIdx if its start node matches node_id
              if (getStartNode(revPath) === node_id) {
                if (roads.length > 0) {
                  const first = { ...roads[0] };
                  const d = first.road_sectors?.[0]?.direction;
                  if (d === 'ascend') first.min_side_road_id = revItem.road_id;
                  else                first.max_side_road_id = revItem.road_id;
                  roads[0] = first;
                }
                const nextId = roads.length > 0 ? roads[0].road_id : -1;
                roads.unshift(withSide(revItem, -1, nextId));
                routes[revIdx] = { ...routes[revIdx], roads };
              }
            } else { // 'start'
              // Append to revIdx if its end node matches node_id
              if (getEndNode(revPath) === node_id) {
                if (roads.length > 0) {
                  const last = { ...roads[roads.length - 1] };
                  const d = last.road_sectors?.[0]?.direction;
                  if (d === 'ascend') last.max_side_road_id = revItem.road_id;
                  else                last.min_side_road_id = revItem.road_id;
                  roads[roads.length - 1] = last;
                }
                const prevId = roads.length > 0 ? roads[roads.length - 1].road_id : -1;
                roads.push(withSide(revItem, prevId, -1));
                routes[revIdx] = { ...routes[revIdx], roads };
              }
            }
          }
        }
      } // end sequential loop

      // ── Compute top-level roads list and save ────────────────────────────────
      const existingTopIds = new Set(
        (doc.routes || []).flatMap((p) => (p.roads || []).map((r) => Number(r.road_id)))
      );
      const allRoadsTop = [
        ...Array.from(existingTopIds).map((id) => ({ road_id: id, role: '' })),
        ...newRoadIds.filter((id) => !existingTopIds.has(id)).map((id) => ({ road_id: id, role: '' })),
      ];

      const routesWithLoop = applyIsLoopFlags(routes);
      const bbox = computeBboxFromPaths(routesWithLoop);
      const existingGroups = doc.intersection_groups || {};
      const updatedGroups = await buildUpdatedIntersectionGroups(routesWithLoop, newRoadIds, existingGroups);

      const $set = { routes: routesWithLoop, bbox, roads: allRoadsTop, updated_at };
      if (updatedGroups) $set.intersection_groups = updatedGroups;
      await col.updateOne({ relation_id }, { $set });
      return res.json({ ok: true, endpoint_type_changed: false });
    }

    // ── Fallback: rebuild from scratch (for backward compatibility) ───────────
    const existingIds = new Set();
    for (const path of (doc.routes || [])) {
      for (const item of (path.roads || [])) {
        const id = parseInt(item.road_id, 10);
        if (!isNaN(id)) existingIds.add(id);
      }
    }
    const allIds = [...existingIds, ...new_road_ids.map(Number)];
    // Pass null for cityBbox to skip step35Filter (geographic filter causes roads to be lost)
    const rebuilt = await buildRouteFromRoadIds(allIds, null, osmDb);
    const routesWithKeys = applyIsLoopFlags(applyIntersectionGroupKeys(rebuilt.routes));

    const existingGroupsFb = doc.intersection_groups || {};
    const updatedGroupsFb = await buildUpdatedIntersectionGroups(
      routesWithKeys, new_road_ids.map(Number), existingGroupsFb
    );

    const $setPayload = {
      routes: routesWithKeys,
      bbox: rebuilt.bbox,
      highway_stat: rebuilt.highway_stat,
      roads: allIds.map((id) => ({ road_id: id, role: '' })),
      updated_at,
    };
    if (updatedGroupsFb) $setPayload.intersection_groups = updatedGroupsFb;

    await col.updateOne({ relation_id }, { $set: $setPayload });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/extend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route names GET / PUT ─────────────────────────────────────────────────────

/**
 * GET /api/routes/:relation_id/names
 * Returns the names array for a specific route.
 */
app.get('/api/routes/:relation_id/names', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    if (isNaN(relation_id)) return res.status(400).json({ error: 'Invalid relation_id' });

    const doc = await osmDb.collection(ROUTES_COLLECTION).findOne(
      { relation_id },
      { projection: { names: 1, _id: 0 } }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc.names || []);
  } catch (err) {
    console.error('/api/routes/:relation_id/names GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/routes/:relation_id/names
 * Body: { names: string[] }
 * Replaces the names array of the specified route.
 */
app.put('/api/routes/:relation_id/names', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    if (isNaN(relation_id)) return res.status(400).json({ error: 'Invalid relation_id' });

    const { names } = req.body;
    if (!Array.isArray(names)) return res.status(400).json({ error: 'names array required' });

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    await osmDb.collection(ROUTES_COLLECTION).updateOne(
      { relation_id },
      { $set: { names, updated_at } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:relation_id/names PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── New-route registration endpoints ─────────────────────────────────────────

/**
 * GET /api/roads/search-names?q=text&minLon=&minLat=&maxLon=&maxLat=
 * Distinct jproads names that intersect the bbox and partially match the query.
 */
app.get('/api/roads/search-names', async (req, res) => {
  try {
    const bbox = parseBboxQuery(req);
    if (!bbox) return res.status(400).json({ error: 'Invalid bbox' });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const names = await osmDb.collection('jproads').distinct('name', {
      name: { $regex: escapeRegex(q), $options: 'i' },
      centerline: { $geoIntersects: { $geometry: bboxToGeoJsonPolygon(bbox) } },
    });
    res.json(names.filter(Boolean).sort());
  } catch (err) {
    console.error('/api/roads/search-names error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/routes/search-by-name?q=text&minLon=&minLat=&maxLon=&maxLat=
 * Existing jproad_routes whose bbox overlaps and any names[].value partially matches.
 */
app.get('/api/routes/search-by-name', async (req, res) => {
  try {
    const bbox = parseBboxQuery(req);
    if (!bbox) return res.status(400).json({ error: 'Invalid bbox' });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const docs = await osmDb
      .collection(ROUTES_COLLECTION)
      .find(
        {
          'bbox.minLon': { $lte: bbox.maxLon },
          'bbox.maxLon': { $gte: bbox.minLon },
          'bbox.minLat': { $lte: bbox.maxLat },
          'bbox.maxLat': { $gte: bbox.minLat },
          $or: [
            // new schema: names is string[]
            { names: { $regex: escapeRegex(q), $options: 'i' } },
            // old schema: names is [{value, ...}]
            { 'names.value': { $regex: escapeRegex(q), $options: 'i' } },
          ],
          is_deleted: { $ne: true },
        },
        { projection: { relation_id: 1, names: 1, _id: 0 } }
      )
      .toArray();

    res.json(
      docs.map((d) => ({
        relation_id: d.relation_id,
        name: Array.isArray(d.names) && d.names.length > 0
          ? (typeof d.names[0] === 'string' ? d.names[0] : (d.names[0].value ?? ''))
          : '',
      }))
    );
  } catch (err) {
    console.error('/api/routes/search-by-name error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routes/preview
 * Body: { roadName, cityBbox }
 * Build a new route doc from jproads without saving.
 */
app.post('/api/routes/preview', async (req, res) => {
  try {
    const { roadName, cityBbox } = req.body;
    if (!roadName || !cityBbox) {
      return res.status(400).json({ error: 'roadName and cityBbox required' });
    }
    const data = await buildRoutePreview(roadName, cityBbox, osmDb);
    res.json(data);
  } catch (err) {
    console.error('/api/routes/preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routes/save
 * Body: { routes, bbox, highway_stat, names }
 * Insert a new route document into jproad_routes.
 */
app.post('/api/routes/save', async (req, res) => {
  try {
    const { routes, bbox, highway_stat, names } = req.body;
    if (!routes || !bbox || !names) {
      return res.status(400).json({ error: 'routes, bbox, names required' });
    }
    const result = await saveRoute({ routes, bbox, highway_stat: highway_stat || {}, names }, osmDb);
    // Add intersections for all roads in the saved route
    const routesWithKeys = applyIntersectionGroupKeys(routes);
    const allRoadIds = routesWithKeys.flatMap(
      (p) => (p.roads || []).map((r) => Number(r.road_id))
    );
    const updatedGroups = await buildUpdatedIntersectionGroups(routesWithKeys, allRoadIds, {});
    // Build default intersection_groups: one empty entry per path (key = path index)
    const defaultGroups = Object.fromEntries(routesWithKeys.map((_, i) => [String(i), []]));
    // Merge: ensure all keys are present even when some paths have no intersections
    await osmDb.collection(ROUTES_COLLECTION).updateOne(
      { relation_id: result.relation_id },
      { $set: { intersection_groups: { ...defaultGroups, ...(updatedGroups || {}) } } }
    );
    res.json(result);
  } catch (err) {
    console.error('/api/routes/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/roads/nearest?lat=&lon=&minLon=&minLat=&maxLon=&maxLat=
 * Finds the road whose centerline is closest to (lat, lon) within the viewport bbox.
 * Returns { road_id, name, oneway, coords: [[lon, lat], ...] } or null.
 */
app.get('/api/roads/nearest', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const bbox = parseBboxQuery(req);
    if (isNaN(lat) || isNaN(lon) || !bbox) {
      return res.status(400).json({ error: 'lat, lon and bbox params required' });
    }

    const bboxPoly = {
      type: 'Polygon',
      coordinates: [[
        [bbox.minLon, bbox.minLat],
        [bbox.maxLon, bbox.minLat],
        [bbox.maxLon, bbox.maxLat],
        [bbox.minLon, bbox.maxLat],
        [bbox.minLon, bbox.minLat],
      ]],
    };

    const docs = await osmDb.collection('jproads').find(
      { centerline: { $geoIntersects: { $geometry: bboxPoly } } },
      { projection: { _id: 0, id: 1, name: 1, oneway: 1, centerline: 1 } }
    ).toArray();

    let bestRoadId = null, bestName = '', bestOneway = false, bestCoords = null;
    let bestDist = Infinity;

    for (const doc of docs) {
      const roadId = nodeToInt(doc.id);
      if (roadId === null) continue;
      const coords = doc?.centerline?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;

      for (let i = 0; i < coords.length - 1; i++) {
        const [lon0, lat0] = coords[i];
        const [lon1, lat1] = coords[i + 1];
        const dx = lon1 - lon0, dy = lat1 - lat0;
        const lenSq = dx * dx + dy * dy;
        let dist;
        if (lenSq < 1e-14) {
          dist = Math.hypot(lat - lat0, lon - lon0);
        } else {
          const t = Math.max(0, Math.min(1, ((lon - lon0) * dx + (lat - lat0) * dy) / lenSq));
          dist = Math.hypot(lat - (lat0 + t * dy), lon - (lon0 + t * dx));
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestRoadId = roadId;
          bestName = String(doc.name || '');
          bestOneway = isForwardOnlyRoad(doc.oneway);
          bestCoords = coords;
        }
      }
    }

    if (bestRoadId === null) return res.json(null);
    res.json({ road_id: bestRoadId, name: bestName, oneway: bestOneway, coords: bestCoords });
  } catch (err) {
    console.error('/api/roads/nearest error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routes/from-scratch
 * Body: { road_id, names, viewBbox }
 * Builds routes from a single road_id (using buildRouteFromRoadIds) and saves to DB.
 */
app.post('/api/routes/from-scratch', async (req, res) => {
  try {
    const { road_id, names, viewBbox } = req.body;
    if (!road_id || !Array.isArray(names) || names.length === 0 || !viewBbox) {
      return res.status(400).json({ error: 'road_id, names, viewBbox required' });
    }
    // Pass null as cityBbox to skip step35Filter – the road is already known (user selected it)
    const routeData = await buildRouteFromRoadIds([road_id], null, osmDb);
    if (routeData.routes.length === 0) {
      return res.status(404).json({ error: 'No routes could be built for this road' });
    }
    const result = await saveRoute({ ...routeData, names }, osmDb);
    // Add intersections for the selected road
    const routesWithKeys = applyIntersectionGroupKeys(routeData.routes);
    const updatedGroups = await buildUpdatedIntersectionGroups(routesWithKeys, [Number(road_id)], {});
    // Build default intersection_groups: one empty entry per path (key = path index)
    const defaultGroups = Object.fromEntries(routesWithKeys.map((_, i) => [String(i), []]));
    // Merge: ensure all keys are present even when some paths have no intersections
    await osmDb.collection(ROUTES_COLLECTION).updateOne(
      { relation_id: result.relation_id },
      { $set: { intersection_groups: { ...defaultGroups, ...(updatedGroups || {}) } } }
    );
    res.json(result);
  } catch (err) {
    console.error('/api/routes/from-scratch error:', err);
    res.status(500).json({ error: err.message });
  }
});

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Route-editor API server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
