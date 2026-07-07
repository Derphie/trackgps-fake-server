# Fake TrackGPS server

Standalone Node/Express server implementing the 2-endpoint TrackGPS contract,
for end-to-end testing of the real ingestion path (auth → fetch → normalise →
`vehicle_positions` → compliance → alerts).

## What it does

- `POST /api/authentication/login` — accepts `Username`/`Password` as
  multipart form fields, returns `{ access_token, expires_in, token_type }`.
- `GET /api/carriers/company-vehicles` — requires `Authorization: Bearer <token>`,
  returns the whole fleet with realistic EU-driving-time scenarios per vehicle.
- Timestamps (`GpsDate`, `ServerDate`) are emitted as **Europe/Bucharest local
  naive datetimes** (e.g. `2026-07-06T15:39:00`), matching what
  `trackgps-datetime.ts` expects — not UTC.

## Scenarios (`scenarios.js`)

| Scenario         | What it exercises                                              |
|------------------|------------------------------------------------------------------|
| `driving-normal` | Baseline smoke test — continuous driving, no breaks             |
| `break-45`       | 4.5h driving / 45min break loop — triggers break-required alerts |
| `daily-rest`     | Full working day + 11h daily rest, loops daily                   |
| `multiday-rest`  | 6 working days + 45h weekly rest — the deferred multi-day edge case |
| `gps-gap`        | Vehicle vanishes from the payload for a stretch, then returns    |

Each vehicle gets its own scenario and its own clock (starts counting from
server boot), so you can mix e.g. one vehicle on `daily-rest` and another on
`gps-gap` in the same run.

**Assumption to verify**: `EngineEvent: 1` = moving/ignition-on, `0` =
stationary. The message thread didn't specify the mapping — check
`RulesEngine.applyGpsEvent` and adjust `scenarios.js` if it's inverted.

## Setup

```bash
npm install
```

## Run locally

```bash
VEHICLES="12345:daily-rest,67890:gps-gap" PORT=8080 node server.js
```

- `VEHICLES` — comma-separated `vehicleId:scenario` pairs. **`vehicleId` must
  match the org's real `provider_vehicle_uid`** for the ingester to resolve a
  driver and actually process the position (per Alex's checklist — also make
  sure there's an active monitored driver↔vehicle assignment, and the org +
  its `gps_providers` row for `arobs` are both `active=true`).
- `FAKE_TOKEN` — override the bearer token if you want (default `fake-token`).
- `TRACKGPS_EXPECT_USERNAME` / `TRACKGPS_EXPECT_PASSWORD` — optionally lock
  login down to specific credentials; unset = accept anything.

## Deploy to Fly.io (recommended — free TLS, no reverse proxy needed)

A `Dockerfile` and `fly.toml` are included.

```bash
# 1. install flyctl if you haven't: https://fly.io/docs/flyctl/install/
fly auth login

cd trackgps-fake-server

# 2. launch — it detects the Dockerfile, asks for an app name/region.
#    Say NO to "would you like to set up a Postgres/Redis database" etc,
#    and NO to overwriting fly.toml (or just confirm the app name it picks).
fly launch --no-deploy

# 3. set your real vehicle IDs + scenarios as a secret (safer than committing
#    them to fly.toml, since these map to real org data)
fly secrets set VEHICLES="12345:daily-rest,67890:gps-gap"

# 4. deploy
fly deploy

# 5. grab the URL
fly status
# -> https://trackgps-fake-server.fly.dev (or whatever name you picked)
```

That URL is what goes into `TRACKGPS_BASE_URL` on your staging backend.
Fly gives you HTTPS out of the box, so no separate Caddy/nginx step needed.

Useful while iterating:
```bash
fly logs                          # tail server output, see [login]/[poll] lines live
fly secrets set VEHICLES="..."    # change vehicles/scenarios, triggers a redeploy
fly deploy                        # after editing scenarios.js locally
```

### Alternative: plain VPS

```bash
# on the VPS
git clone <this>  # or scp the folder over
cd trackgps-fake-server
npm install --production
VEHICLES="12345:daily-rest" PORT=8080 nohup node server.js > server.log 2>&1 &
```

Put it behind Caddy/nginx with a real TLS cert if your backend's HTTP client
insists on HTTPS (many GPS-provider SDKs do). A one-line Caddyfile:

```
your-fake-domain.example.com {
    reverse_proxy localhost:8080
}
```

## Wiring it into the backend (Option A — env override)

This is the small code change Alex flagged as the only blocker. In
`trackgps.config.ts`:

```diff
-export const TRACKGPS_DEFAULT_BASE_URL = 'https://api.trackgps.ro';
+export const TRACKGPS_DEFAULT_BASE_URL =
+  process.env.TRACKGPS_BASE_URL || 'https://api.trackgps.ro';
```

Then wherever `fetchVehiclePositions` (and `authenticate`) build the request
URL, make sure they read `TRACKGPS_DEFAULT_BASE_URL` rather than a
re-hardcoded literal — from the thread, `PollOrganisationService` currently
constructs credentials with `baseUrl: null` and falls back to the default, so
if the default itself now respects the env var, no further schema/DB changes
are needed.

On your **staging** backend instance only, set:

```
TRACKGPS_BASE_URL=https://your-fake-domain.example.com
```

Production stays untouched since it doesn't have this env var set.

## Testing cadence

The real poller runs every 35s, compliance every 5s — this fake doesn't need
to push anything; it just computes "where would this vehicle be right now"
on each incoming poll, so whatever cadence the real `PollScheduler` uses is
exactly what drives it.

## Smoke test

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/authentication/login \
  -F "Username=testorg" -F "Password=whatever" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s http://localhost:8080/api/carriers/company-vehicles \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
