'use strict';

const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const { buildRoutePreview, saveRoute } = require('./routeBuilder');

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

    await osmDb.collection(ROUTES_COLLECTION).updateOne(
      { relation_id },
      { $set: { names } }
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
