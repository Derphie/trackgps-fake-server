'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'vehicles.json');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Seeds from the VEHICLES env var on first boot only (format:
// "vehicleId:scenario,vehicleId:scenario"), so existing deploys keep working
// without any dashboard interaction if you don't touch it.
function seedFromEnv() {
  const raw = process.env.VEHICLES || '12345:daily-rest';
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, scenario] = entry.split(':').map((s) => s.trim());
      return {
        vehicleId: Number(id),
        scenario: scenario || 'driving-normal',
        customSegments: null,
        startedAt: Date.now(),
      };
    });
}

function load() {
  ensureDataDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse vehicles.json, reseeding from env:', e.message);
    }
  }
  const seeded = seedFromEnv();
  save(seeded);
  return seeded;
}

function save(vehicles) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(vehicles, null, 2));
}

let vehicles = load();

module.exports = {
  getAll: () => vehicles,

  getById: (id) => vehicles.find((v) => v.vehicleId === Number(id)),

  add: ({ vehicleId, scenario, customSegments }) => {
    vehicleId = Number(vehicleId);
    if (!vehicleId) throw new Error('vehicleId is required');
    if (vehicles.some((v) => v.vehicleId === vehicleId)) {
      throw new Error(`Vehicle ${vehicleId} already exists`);
    }
    vehicles.push({
      vehicleId,
      scenario: scenario || 'driving-normal',
      customSegments: customSegments || null,
      startedAt: Date.now(),
    });
    save(vehicles);
  },

  update: (id, updates) => {
    const v = vehicles.find((v) => v.vehicleId === Number(id));
    if (!v) throw new Error(`Vehicle ${id} not found`);
    if (updates.scenario !== undefined) v.scenario = updates.scenario;
    if (updates.customSegments !== undefined) v.customSegments = updates.customSegments;
    // Restart the vehicle's clock so the new scenario/segments begin cleanly
    // from segment 1 instead of picking up mid-cycle.
    v.startedAt = Date.now();
    save(vehicles);
  },

  remove: (id) => {
    const before = vehicles.length;
    vehicles = vehicles.filter((v) => v.vehicleId !== Number(id));
    if (vehicles.length === before) throw new Error(`Vehicle ${id} not found`);
    save(vehicles);
  },
};
