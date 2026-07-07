'use strict';

/**
 * Scenario engine.
 *
 * Each vehicle follows a looped timeline of segments. A segment is:
 *   { type: 'driving' | 'rest' | 'break' | 'gap', durationMin: number, speedKmh?: number }
 *
 * Position is simulated by moving along a simple back-and-forth route between
 * two waypoints (a straight line is enough to exercise distance/speed logic;
 * swap ROUTE for a real polyline if you want prettier maps).
 *
 * EngineEvent convention (guessed from context, verify against your ingester):
 *   1 = ignition on / moving, 0 = ignition off / stationary.
 */

const ROUTE = [
  { lat: 44.4268, lon: 26.1025 }, // Bucharest
  { lat: 45.6427, lon: 25.5887 }, // Brasov-ish, ~150km north
];

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ROUTE_LEN_KM = haversineKm(ROUTE[0], ROUTE[1]);

function interpolate(fracOfLeg) {
  const f = Math.max(0, Math.min(1, fracOfLeg));
  return {
    lat: ROUTE[0].lat + (ROUTE[1].lat - ROUTE[0].lat) * f,
    lon: ROUTE[0].lon + (ROUTE[1].lon - ROUTE[0].lon) * f,
  };
}

function bearingDeg(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---- Named scenarios (EU 561/2006-flavored) --------------------------------

const SCENARIOS = {
  // 4.5h driving block, 45min break, repeat. No daily/weekly rest — good for
  // quickly triggering the "continuous driving" / break-required alert.
  'break-45': [
    { type: 'driving', durationMin: 270, speedKmh: 75 },
    { type: 'break', durationMin: 45, speedKmh: 0 },
  ],

  // Realistic single working day: two driving blocks split by a break, then
  // a full 11h daily rest. Loops daily.
  'daily-rest': [
    { type: 'driving', durationMin: 240, speedKmh: 80 },
    { type: 'break', durationMin: 45, speedKmh: 0 },
    { type: 'driving', durationMin: 240, speedKmh: 80 },
    { type: 'rest', durationMin: 660, speedKmh: 0 }, // 11h
  ],

  // 6 working days then a 45h weekly rest — the multi-day-rest edge case.
  'multiday-rest': [
    ...Array(6).fill([
      { type: 'driving', durationMin: 240, speedKmh: 80 },
      { type: 'break', durationMin: 45, speedKmh: 0 },
      { type: 'driving', durationMin: 240, speedKmh: 80 },
      { type: 'rest', durationMin: 660, speedKmh: 0 },
    ]).flat(),
    { type: 'rest', durationMin: 2700, speedKmh: 0 }, // 45h weekly rest
  ],

  // Vehicle vanishes from the payload for a stretch, then comes back —
  // exercises circuit-breaker / stale-position handling. Non-gap time it
  // just drives normally.
  'gps-gap': [
    { type: 'driving', durationMin: 60, speedKmh: 70 },
    { type: 'gap', durationMin: 20 },
    { type: 'driving', durationMin: 60, speedKmh: 70 },
  ],

  // Plain continuous driving, no breaks — useful as a smoke test / baseline.
  'driving-normal': [{ type: 'driving', durationMin: 1440, speedKmh: 70 }],
};

function totalDuration(segments) {
  return segments.reduce((s, seg) => s + seg.durationMin, 0);
}

/**
 * Returns { lat, lon, speedKmh, course, engineEvent, isGap } for a vehicle
 * at `nowMs`, given it started the scenario at `startedAtMs`.
 */
function computeState(scenarioName, startedAtMs, nowMs) {
  const segments = SCENARIOS[scenarioName] || SCENARIOS['driving-normal'];
  const totalMin = totalDuration(segments);
  const elapsedMin = ((nowMs - startedAtMs) / 60000) % totalMin;

  let cursor = 0;
  let seg = segments[0];
  let segElapsedMin = 0;
  for (const s of segments) {
    if (elapsedMin < cursor + s.durationMin) {
      seg = s;
      segElapsedMin = elapsedMin - cursor;
      break;
    }
    cursor += s.durationMin;
  }

  if (seg.type === 'gap') {
    return { isGap: true };
  }

  // Distance covered so far along the whole loop (driving segments only),
  // used to pick a position along the route and wrap it back and forth.
  let drivenKmTotal = 0;
  let acc = 0;
  for (const s of segments) {
    if (s === seg) {
      if (s.type === 'driving') {
        drivenKmTotal += (s.speedKmh * segElapsedMin) / 60;
      }
      break;
    }
    if (s.type === 'driving') {
      drivenKmTotal += (s.speedKmh * s.durationMin) / 60;
    }
    acc += s.durationMin;
  }

  const legFrac = (drivenKmTotal % (2 * ROUTE_LEN_KM)) / ROUTE_LEN_KM;
  let fracOfLeg, from, to;
  if (legFrac <= 1) {
    fracOfLeg = legFrac;
    from = ROUTE[0];
    to = ROUTE[1];
  } else {
    fracOfLeg = legFrac - 1;
    from = ROUTE[1];
    to = ROUTE[0];
  }

  const pos = interpolate(fracOfLeg);
  const course = bearingDeg(from, to);
  const moving = seg.type === 'driving';

  return {
    isGap: false,
    lat: pos.lat,
    lon: pos.lon,
    speedKmh: moving ? seg.speedKmh : 0,
    course: Math.round(course),
    engineEvent: moving ? 1 : 0,
    segmentType: seg.type,
  };
}

module.exports = { SCENARIOS, computeState };
