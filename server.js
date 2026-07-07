'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { computeState } = require('./scenarios');

const upload = multer();
const app = express();

const PORT = process.env.PORT || 8080;
const FAKE_TOKEN = process.env.FAKE_TOKEN || 'fake-token';
// Optional: lock down login to a specific username/password. Leave unset to
// accept anything (matches "any onboarded org can hit this" test posture).
const EXPECT_USERNAME = process.env.TRACKGPS_EXPECT_USERNAME || null;
const EXPECT_PASSWORD = process.env.TRACKGPS_EXPECT_PASSWORD || null;

// VEHICLES env format: "vehicleId:scenario,vehicleId:scenario,..."
// e.g. "12345:daily-rest,67890:gps-gap"
// Falls back to a single demo vehicle if unset.
function parseVehiclesEnv() {
  const raw = process.env.VEHICLES || '12345:daily-rest';
  return raw.split(',').map((entry) => {
    const [id, scenario] = entry.split(':').map((s) => s.trim());
    return { vehicleId: Number(id), scenario: scenario || 'driving-normal' };
  });
}

const VEHICLES = parseVehiclesEnv();
const SERVER_STARTED_AT = Date.now();

console.log('Fake TrackGPS server starting with vehicles:', VEHICLES);

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

// ---- Endpoints --------------------------------------------------------------

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

  for (const v of VEHICLES) {
    const state = computeState(v.scenario, SERVER_STARTED_AT, now.getTime());
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

// Basic health check for VPS/uptime monitoring, not part of the contract.
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`Fake TrackGPS server listening on :${PORT}`);
  console.log(`Token: ${FAKE_TOKEN}`);
});
