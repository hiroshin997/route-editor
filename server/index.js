'use strict';

const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

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
      .find(query, { projection: { name: 1, relation_id: 1, routes: 1, _id: 0 } })
      .toArray();

    console.log(`/api/routes/in-bbox: ${docs.length} routes found`);
    res.json(docs);
  } catch (err) {
    console.error('/api/routes/in-bbox error:', err);
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
