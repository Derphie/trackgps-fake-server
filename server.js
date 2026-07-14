'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { computeState, SCENARIOS } = require('./scenarios');
const vehicleStore = require('./vehicleStore');

const upload = multer();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const FAKE_TOKEN = process.env.FAKE_TOKEN || 'fake-token';
// Optional: lock down login to a specific username/password. Leave unset to
// accept anything (matches "any onboarded org can hit this" test posture).
const EXPECT_USERNAME = process.env.TRACKGPS_EXPECT_USERNAME || null;
const EXPECT_PASSWORD = process.env.TRACKGPS_EXPECT_PASSWORD || null;
// Optional: protect the dashboard/admin API. Leave unset for local/dev use.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

console.log('Fake TrackGPS server starting with vehicles:', vehicleStore.getAll());
if (!ADMIN_TOKEN) {
  console.log('ADMIN_TOKEN not set — dashboard/admin API is UNPROTECTED. Set ADMIN_TOKEN in production.');
}

// ---- Timestamp formatting: Europe/Bucharest LOCAL naive datetime ----------
// The real ingester parses GpsDate as Europe/Bucharest local time (see
// trackgps-datetime.ts), so we must emit local-looking strings, not UTC/ISO.

function formatBucharestLocal(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get(
    'minute'
  )}:${get('second')}`;
}

// ---- Auth middleware --------------------------------------------------------

function requireBearer(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== FAKE_TOKEN) {
    return res.status(401).json({ IsSuccess: false, Error: 'Unauthorized' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // open when not configured (local/dev)
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — missing/invalid X-Admin-Token' });
  }
  next();
}

// Convenience: visiting the root URL goes straight to the dashboard.
app.get('/', (req, res) => res.redirect('/admin'));

// ---- TrackGPS contract endpoints (unchanged from the real API's POV) ------

app.post(
  '/api/authentication/login',
  upload.none(), // multipart/form-data, no files, just fields
  (req, res) => {
    const { Username, Password } = req.body;

    if (!Username || !Password) {
      return res
        .status(400)
        .json({ IsSuccess: false, Error: 'Missing Username/Password' });
    }
    if (EXPECT_USERNAME && Username !== EXPECT_USERNAME) {
      return res
        .status(401)
        .json({ IsSuccess: false, Error: 'Invalid credentials' });
    }
    if (EXPECT_PASSWORD && Password !== EXPECT_PASSWORD) {
      return res
        .status(401)
        .json({ IsSuccess: false, Error: 'Invalid credentials' });
    }

    console.log(`[login] Username=${Username} -> issuing token`);
    res.json({
      access_token: FAKE_TOKEN,
      expires_in: 28800,
      token_type: 'Bearer',
    });
  }
);

app.get('/api/carriers/company-vehicles', requireBearer, (req, res) => {
  const now = new Date();
  const payload = [];

  for (const v of vehicleStore.getAll()) {
    const state = computeState(v, now.getTime());
    if (state.isGap) {
      console.log(`[poll] vehicle=${v.vehicleId} scenario=${v.scenario} -> GAP (omitted)`);
      continue; // simulate a real GPS blackout: vehicle just isn't in the payload
    }

    const gpsDate = formatBucharestLocal(now);
    const serverDate = formatBucharestLocal(new Date(now.getTime() + 1000));

    payload.push({
      VehicleId: v.vehicleId,
      Latitude: Number(state.lat.toFixed(6)),
      Longitude: Number(state.lon.toFixed(6)),
      Speed: state.speedKmh,
      Course: state.course,
      GpsDate: gpsDate,
      ServerDate: serverDate,
      EngineEvent: state.engineEvent,
    });

    console.log(
      `[poll] vehicle=${v.vehicleId} scenario=${v.scenario} segment=${state.segmentType} ` +
        `speed=${state.speedKmh} pos=(${state.lat.toFixed(4)},${state.lon.toFixed(4)})`
    );
  }

  res.json({ IsSuccess: true, Payload: payload });
});

// Basic health check for uptime monitoring, not part of the contract.
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---- Admin API (dashboard backend) -----------------------------------------

app.get('/admin/api/scenarios', requireAdmin, (req, res) => {
  res.json(Object.keys(SCENARIOS));
});

app.get('/admin/api/vehicles', requireAdmin, (req, res) => {
  const now = Date.now();
  const list = vehicleStore.getAll().map((v) => ({
    ...v,
    liveState: computeState(v, now),
  }));
  res.json(list);
});

app.post('/admin/api/vehicles', requireAdmin, (req, res) => {
  try {
    vehicleStore.add(req.body);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/admin/api/vehicles/:id', requireAdmin, (req, res) => {
  try {
    vehicleStore.update(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.delete('/admin/api/vehicles/:id', requireAdmin, (req, res) => {
  try {
    vehicleStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Dashboard static UI
app.use('/admin', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Fake TrackGPS server listening on :${PORT}`);
  console.log(`Token: ${FAKE_TOKEN}`);
  console.log(`Dashboard: http://localhost:${PORT}/admin`);
});
