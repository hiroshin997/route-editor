'use strict';

const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const { buildRoutePreview, saveRoute, buildRouteFromRoadIds, nodeToInt, isForwardOnlyRoad, bearingDegreesInt, ROAD_PROJECTION } = require('./routeBuilder');

const app = express();
const PORT = 5000;
const MONGO_URL = 'mongodb://192.168.1.3:27017';
const DB_NAME = 'estat';
const COLLECTION = 'boundaries';
const ROUTES_COLLECTION = 'jproad_routes';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

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
    return { 'properties.admin_level': 8, $and: andConditions };
  } else if (level === 3) {
    return { 'properties.admin_level': { $gte: 8 }, $and: andConditions };
  } else {
    return { 'properties.admin_level': 10, $and: andConditions };
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

function subRouteIntersectsBbox(routeArray, bbox) {
  if (!Array.isArray(routeArray)) return false;
  for (const road of routeArray) {
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
  if (!primary || typeof primary.value !== 'string') return '';
  return primary.value;
}

/**
 * GET /api/routes/in-bbox?minLon=&minLat=&maxLon=&maxLat=
 * Returns [{name, relation_id, routes}] for routes whose bbox overlaps the query bbox.
 * Uses the bbox_idx compound index for fast filtering.
 */
app.get('/api/routes/in-bbox', async (req, res) => {
  try {
    const minLon = parseFloat(req.query.minLon);
    const minLat = parseFloat(req.query.minLat);
    const maxLon = parseFloat(req.query.maxLon);
    const maxLat = parseFloat(req.query.maxLat);

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

// ── Route trim endpoints ───────────────────────────────────────────────────────

function computeBboxFromPaths(routes) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const path of (routes || [])) {
    for (const item of (path || [])) {
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

    res.json(path);
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
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Enforce -1 on new endpoint side-road IDs
    const updated = new_roads.map((r, i) => {
      let road = { ...r };
      if (i === 0) road = { ...road, min_side_road_id: '-1' };
      if (i === new_roads.length - 1) road = { ...road, max_side_road_id: '-1' };
      return road;
    });

    const routes = (doc.routes || []).map((p, i) => (i === path_idx ? updated : p));
    const bbox = computeBboxFromPaths(routes);

    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    await col.updateOne({ relation_id }, { $set: { routes, bbox, updated_at } });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/routes/:id/trim error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route extension endpoints ─────────────────────────────────────────────────

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

    const jpRoads = osmDb.collection('jproads');
    const endpoints = [];

    for (let i = 0; i < (doc.routes || []).length; i++) {
      const path = doc.routes[i];
      if (!path || !path.length) continue;

      const firstRoad = path[0];
      const lastRoad = path[path.length - 1];
      const firstSectors = firstRoad.road_sectors || [];
      const lastSectors = lastRoad.road_sectors || [];
      if (!firstSectors.length || !lastSectors.length) continue;

      const firstDir = firstSectors[0].direction;
      const lastDir = lastSectors[0].direction;

      // Start endpoint: lookup from_node/to_node from jproads
      const firstRoadDoc = await jpRoads.findOne(
        { id: parseInt(firstRoad.road_id, 10) },
        { projection: { from_node: 1, to_node: 1, _id: 0 } }
      );
      const startNodeId = firstDir === 'ascend'
        ? nodeToInt(firstRoadDoc?.from_node) : nodeToInt(firstRoadDoc?.to_node);
      const startLat = firstDir === 'ascend' ? firstSectors[0].lat0 : firstSectors[0].lat1;
      const startLon = firstDir === 'ascend' ? firstSectors[0].lon0 : firstSectors[0].lon1;

      // End endpoint
      const lastRoadDoc = await jpRoads.findOne(
        { id: parseInt(lastRoad.road_id, 10) },
        { projection: { from_node: 1, to_node: 1, _id: 0 } }
      );
      const lastSector = lastSectors[lastSectors.length - 1];
      const endNodeId = lastDir === 'ascend'
        ? nodeToInt(lastRoadDoc?.to_node) : nodeToInt(lastRoadDoc?.from_node);
      const endLat = lastDir === 'ascend' ? lastSector.lat1 : lastSector.lat0;
      const endLon = lastDir === 'ascend' ? lastSector.lon1 : lastSector.lon0;

      endpoints.push({ path_idx: i, endpoint: 'start', lat: startLat, lon: startLon, node_id: startNodeId, road_id: parseInt(firstRoad.road_id, 10) });
      endpoints.push({ path_idx: i, endpoint: 'end',   lat: endLat,   lon: endLon,   node_id: endNodeId,   road_id: parseInt(lastRoad.road_id, 10)  });
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

      // Entry from end → descending travel (bidirectional only)
      if (isAtEnd && !oneway && !isAtStart) {
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
 * Body: { city_bbox, new_road_ids }
 * Appends new roads to the route, rebuilds doc.routes via Step1–Step4, saves.
 */
app.post('/api/routes/:relation_id/extend', async (req, res) => {
  try {
    const relation_id = parseInt(req.params.relation_id, 10);
    const { city_bbox, new_road_ids } = req.body;
    if (!Array.isArray(new_road_ids) || !new_road_ids.length) {
      return res.status(400).json({ error: 'new_road_ids required' });
    }

    const col = osmDb.collection(ROUTES_COLLECTION);
    const doc = await col.findOne({ relation_id }, { projection: { routes: 1, _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Collect existing road IDs from current doc.routes
    const existingIds = new Set();
    for (const path of (doc.routes || [])) {
      for (const item of path) {
        const id = parseInt(item.road_id, 10);
        if (!isNaN(id)) existingIds.add(id);
      }
    }

    const allIds = [...existingIds, ...new_road_ids.map(Number)];
    const rebuilt = await buildRouteFromRoadIds(allIds, city_bbox || null, osmDb);

    // ISO datetime in JST
    const pad = (n) => String(n).padStart(2, '0');
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const updated_at = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    await col.updateOne(
      { relation_id },
      { $set: {
        routes: rebuilt.routes,
        bbox: rebuilt.bbox,
        highway_stat: rebuilt.highway_stat,
        roads: allIds.map((id) => ({ road_id: id, role: '' })),
        updated_at,
      }}
    );

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
 * Body: { names: [{value, is_global, locations}] }
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
          'names.value': { $regex: escapeRegex(q), $options: 'i' },
          is_deleted: { $ne: true },
        },
        { projection: { relation_id: 1, names: 1, _id: 0 } }
      )
      .toArray();

    res.json(
      docs.map((d) => ({
        relation_id: d.relation_id,
        name: Array.isArray(d.names) && d.names.length > 0 ? d.names[0].value : '',
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
    res.json(result);
  } catch (err) {
    console.error('/api/routes/save error:', err);
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
