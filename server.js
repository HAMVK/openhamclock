/**
 * OpenHamClock Server
 * 
 * Express server that:
 * 1. Serves the static web application
 * 2. Proxies API requests to avoid CORS issues
 * 3. Provides hybrid HF propagation predictions (ITURHFProp + real-time ionosonde)
 * 4. Provides WebSocket support for future real-time features
 * 
 * Configuration:
 * - Copy .env.example to .env and customize
 * - Environment variables override .env file
 * 
 * Usage:
 *   node server.js
 *   PORT=8080 node server.js
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fetch = require('node-fetch');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

// Read version from package.json as single source of truth
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// Auto-create .env from .env.example on first run
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  console.log('[Config] Created .env from .env.example');
  console.log('[Config] ⚠️  Please edit .env with your callsign and locator, then restart');
}

// Load .env file if it exists
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      if (key && value !== undefined && !process.env[key]) {
        process.env[key] = value;
      }
    }
  });
  console.log('[Config] Loaded configuration from .env file');
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ============================================
// CONFIGURATION FROM ENVIRONMENT
// ============================================

// Convert Maidenhead grid locator to lat/lon
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  
  grid = grid.toUpperCase();
  const lon = (grid.charCodeAt(0) - 65) * 20 - 180;
  const lat = (grid.charCodeAt(1) - 65) * 10 - 90;
  const lon2 = parseInt(grid[2]) * 2;
  const lat2 = parseInt(grid[3]);
  
  let longitude = lon + lon2 + 1; // Center of grid
  let latitude = lat + lat2 + 0.5;
  
  // 6-character grid for more precision
  if (grid.length >= 6) {
    const lon3 = (grid.charCodeAt(4) - 65) * (2/24);
    const lat3 = (grid.charCodeAt(5) - 65) * (1/24);
    longitude = lon + lon2 + lon3 + (1/24);
    latitude = lat + lat2 + lat3 + (0.5/24);
  }
  
  return { latitude, longitude };
}

// Get locator from env (support both LOCATOR and GRID_SQUARE)
const locator = process.env.LOCATOR || process.env.GRID_SQUARE || '';

// Also load config.json if it exists (for user preferences)
let jsonConfig = {};
const configJsonPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configJsonPath)) {
  try {
    jsonConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    console.log('[Config] Loaded user preferences from config.json');
  } catch (e) {
    console.error('[Config] Error parsing config.json:', e.message);
  }
}

// Calculate lat/lon from locator if not explicitly set
let stationLat = parseFloat(process.env.LATITUDE);
let stationLon = parseFloat(process.env.LONGITUDE);

if ((!stationLat || !stationLon) && locator) {
  const coords = gridToLatLon(locator);
  if (coords) {
    stationLat = stationLat || coords.latitude;
    stationLon = stationLon || coords.longitude;
  }
}

// Fallback to config.json location if no env
if (!stationLat && jsonConfig.location?.lat) stationLat = jsonConfig.location.lat;
if (!stationLon && jsonConfig.location?.lon) stationLon = jsonConfig.location.lon;

const CONFIG = {
  // Station info (env takes precedence over config.json)
  callsign: process.env.CALLSIGN || jsonConfig.callsign || 'N0CALL',
  gridSquare: locator || jsonConfig.locator || '',
  latitude: stationLat || 40.7128,
  longitude: stationLon || -74.0060,
  
  // Display preferences
  units: process.env.UNITS || jsonConfig.units || 'imperial',
  timeFormat: process.env.TIME_FORMAT || jsonConfig.timeFormat || '12',
  theme: process.env.THEME || jsonConfig.theme || 'dark',
  layout: process.env.LAYOUT || jsonConfig.layout || 'modern',
  
  // DX target
  dxLatitude: parseFloat(process.env.DX_LATITUDE) || jsonConfig.defaultDX?.lat || 51.5074,
  dxLongitude: parseFloat(process.env.DX_LONGITUDE) || jsonConfig.defaultDX?.lon || -0.1278,
  
  // Feature toggles
  showSatellites: process.env.SHOW_SATELLITES !== 'false' && jsonConfig.features?.showSatellites !== false,
  showPota: process.env.SHOW_POTA !== 'false' && jsonConfig.features?.showPOTA !== false,
  showDxPaths: process.env.SHOW_DX_PATHS !== 'false' && jsonConfig.features?.showDXPaths !== false,
  showDxWeather: process.env.SHOW_DX_WEATHER !== 'false' && jsonConfig.features?.showDXWeather !== false,
  classicAnalogClock: process.env.CLASSIC_ANALOG_CLOCK === 'true' || jsonConfig.features?.classicAnalogClock === true,
  showContests: jsonConfig.features?.showContests !== false,
  showDXpeditions: jsonConfig.features?.showDXpeditions !== false,
  
  // DX Cluster settings
  spotRetentionMinutes: parseInt(process.env.SPOT_RETENTION_MINUTES) || jsonConfig.dxCluster?.spotRetentionMinutes || 30,
  dxClusterSource: process.env.DX_CLUSTER_SOURCE || jsonConfig.dxCluster?.source || 'auto',
  
  // API keys (don't expose to frontend)
  _openWeatherApiKey: process.env.OPENWEATHER_API_KEY || '',
  _qrzUsername: process.env.QRZ_USERNAME || '',
  _qrzPassword: process.env.QRZ_PASSWORD || ''
};

// Check if required config is missing
const configMissing = CONFIG.callsign === 'N0CALL' || !CONFIG.gridSquare;
if (configMissing) {
  console.log('[Config] ⚠️  Station configuration incomplete!');
  console.log('[Config] Copy .env.example to .env OR config.example.json to config.json');
  console.log('[Config] Set your CALLSIGN and LOCATOR/grid square');
  console.log('[Config] Settings popup will appear in browser');
}

// ITURHFProp service URL (optional - enables hybrid mode)
// Must be a full URL like https://iturhfprop.example.com
const ITURHFPROP_URL = process.env.ITURHFPROP_URL && process.env.ITURHFPROP_URL.trim().startsWith('http') 
  ? process.env.ITURHFPROP_URL.trim() 
  : null;

// Log configuration
console.log(`[Config] Station: ${CONFIG.callsign} @ ${CONFIG.gridSquare || 'No grid'}`);
console.log(`[Config] Location: ${CONFIG.latitude.toFixed(4)}, ${CONFIG.longitude.toFixed(4)}`);
console.log(`[Config] Units: ${CONFIG.units}, Time: ${CONFIG.timeFormat}h`);
if (ITURHFPROP_URL) {
  console.log(`[Propagation] Hybrid mode enabled - ITURHFProp service: ${ITURHFPROP_URL}`);
} else {
  console.log('[Propagation] Standalone mode - using built-in calculations');
}

// Middleware
app.use(cors());
app.use(express.json());

// GZIP compression - reduces response sizes by 70-90%
// This is critical for reducing bandwidth/egress costs
app.use(compression({
  level: 6, // Balanced compression level (1-9)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Compress everything except already-compressed formats
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// API response caching middleware
// Sets Cache-Control headers based on endpoint to reduce client polling
app.use('/api', (req, res, next) => {
  // Determine cache duration based on endpoint
  let cacheDuration = 30; // Default: 30 seconds
  
  const path = req.path.toLowerCase();
  
  if (path.includes('/satellites/tle')) {
    cacheDuration = 3600; // 1 hour (TLE data is static)
  } else if (path.includes('/contests') || path.includes('/dxpeditions')) {
    cacheDuration = 1800; // 30 minutes (contests/expeditions change slowly)
  } else if (path.includes('/solar-indices') || path.includes('/noaa')) {
    cacheDuration = 300; // 5 minutes (space weather updates every 5 min)
  } else if (path.includes('/propagation')) {
    cacheDuration = 600; // 10 minutes
  } else if (path.includes('/pota') || path.includes('/sota')) {
    cacheDuration = 120; // 2 minutes
  } else if (path.includes('/pskreporter')) {
    cacheDuration = 300; // 5 minutes (PSKReporter rate limits aggressively)
  } else if (path.includes('/dxcluster') || path.includes('/myspots')) {
    cacheDuration = 30; // 30 seconds (DX spots need to be relatively fresh)
  } else if (path.includes('/config')) {
    cacheDuration = 3600; // 1 hour (config rarely changes)
  }
  
  res.setHeader('Cache-Control', `public, max-age=${cacheDuration}`);
  res.setHeader('Vary', 'Accept-Encoding');
  next();
});

// ============================================
// LOGGING SYSTEM
// ============================================
// LOG_LEVEL: 'debug' = verbose, 'info' = normal, 'warn' = warnings+errors, 'error' = errors only
const LOG_LEVEL = (process.env.LOG_LEVEL || 'warn').toLowerCase();
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.warn;

function logDebug(...args) {
  if (currentLogLevel <= LOG_LEVELS.debug) console.log(...args);
}
function logInfo(...args) {
  if (currentLogLevel <= LOG_LEVELS.info) console.log(...args);
}
function logWarn(...args) {
  if (currentLogLevel <= LOG_LEVELS.warn) console.warn(...args);
}

// Rate-limited error logging - prevents log spam when services are down
const errorLogState = {};
const ERROR_LOG_INTERVAL = 5 * 60 * 1000; // Only log same error once per 5 minutes

function logErrorOnce(category, message) {
  const key = `${category}:${message}`;
  const now = Date.now();
  const lastLogged = errorLogState[key] || 0;
  
  if (now - lastLogged >= ERROR_LOG_INTERVAL) {
    errorLogState[key] = now;
    console.error(`[${category}] ${message}`);
    return true;
  }
  return false;
}

// ============================================
// VISITOR TRACKING
// ============================================
// Lightweight in-memory visitor counter — tracks unique IPs per day
// No cookies, no external analytics, no persistent storage
// Resets on server restart; logs daily summary

const visitorStats = {
  today: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
  uniqueIPs: new Set(),
  totalRequests: 0,
  allTimeVisitors: 0,    // Cumulative unique visitors since server start
  allTimeRequests: 0,    // Cumulative requests since server start
  serverStarted: new Date().toISOString(),
  history: []  // Last 30 days of { date, uniqueVisitors, totalRequests }
};

function rolloverVisitorStats() {
  const now = new Date().toISOString().slice(0, 10);
  if (now !== visitorStats.today) {
    // Save yesterday's stats to history
    visitorStats.history.push({
      date: visitorStats.today,
      uniqueVisitors: visitorStats.uniqueIPs.size,
      totalRequests: visitorStats.totalRequests
    });
    // Keep only last 30 days
    if (visitorStats.history.length > 30) {
      visitorStats.history = visitorStats.history.slice(-30);
    }
    const avg = visitorStats.history.length > 0
      ? Math.round(visitorStats.history.reduce((sum, d) => sum + d.uniqueVisitors, 0) / visitorStats.history.length)
      : 0;
    console.log(`[Visitors] Daily summary for ${visitorStats.today}: ${visitorStats.uniqueIPs.size} unique visitors, ${visitorStats.totalRequests} requests | All-time: ${visitorStats.allTimeVisitors} visitors, ${visitorStats.allTimeRequests} requests | ${visitorStats.history.length}-day avg: ${avg}/day`);
    // Reset daily counters for new day
    visitorStats.today = now;
    visitorStats.uniqueIPs = new Set();
    visitorStats.totalRequests = 0;
  }
}

// Visitor tracking middleware — only counts page loads and API config fetches
// (not every API poll, which would inflate the count)
app.use((req, res, next) => {
  rolloverVisitorStats();
  
  // Only count meaningful "visits" — initial page load or config fetch
  // This avoids counting every 5-second DX cluster poll as a "visit"
  const countableRoutes = ['/', '/index.html', '/api/config'];
  if (countableRoutes.includes(req.path)) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
    const isNew = !visitorStats.uniqueIPs.has(ip);
    visitorStats.uniqueIPs.add(ip);
    visitorStats.totalRequests++;
    visitorStats.allTimeRequests++;
    
    if (isNew) {
      visitorStats.allTimeVisitors++;
      logInfo(`[Visitors] New visitor today (#${visitorStats.uniqueIPs.size}, #${visitorStats.allTimeVisitors} all-time) from ${ip.replace(/\d+$/, 'x')}`);
    }
  }
  
  next();
});

// Log visitor count every hour
setInterval(() => {
  rolloverVisitorStats();
  if (visitorStats.uniqueIPs.size > 0 || visitorStats.allTimeVisitors > 0) {
    const avg = visitorStats.history.length > 0
      ? Math.round(visitorStats.history.reduce((sum, d) => sum + d.uniqueVisitors, 0) / visitorStats.history.length)
      : visitorStats.uniqueIPs.size;
    console.log(`[Visitors] Today so far: ${visitorStats.uniqueIPs.size} unique, ${visitorStats.totalRequests} requests | All-time: ${visitorStats.allTimeVisitors} visitors | Avg: ${avg}/day`);
  }
}, 60 * 60 * 1000);

// ============================================
// AUTO UPDATE (GIT)
// ============================================
const AUTO_UPDATE_ENABLED = process.env.AUTO_UPDATE_ENABLED === 'true';
const AUTO_UPDATE_INTERVAL_MINUTES = parseInt(process.env.AUTO_UPDATE_INTERVAL_MINUTES || '60');
const AUTO_UPDATE_ON_START = process.env.AUTO_UPDATE_ON_START === 'true';
const AUTO_UPDATE_EXIT_AFTER = process.env.AUTO_UPDATE_EXIT_AFTER !== 'false';

const autoUpdateState = {
  inProgress: false,
  lastCheck: 0,
  lastResult: ''
};

function execFilePromise(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function hasGitUpdates() {
  await execFilePromise('git', ['fetch', 'origin'], { cwd: __dirname });
  const local = (await execFilePromise('git', ['rev-parse', 'HEAD'], { cwd: __dirname })).stdout.trim();
  let remote = '';
  try {
    remote = (await execFilePromise('git', ['rev-parse', 'origin/main'], { cwd: __dirname })).stdout.trim();
  } catch {
    remote = (await execFilePromise('git', ['rev-parse', 'origin/master'], { cwd: __dirname })).stdout.trim();
  }
  return { updateAvailable: local !== remote, local, remote };
}

async function hasDirtyWorkingTree() {
  const status = await execFilePromise('git', ['status', '--porcelain'], { cwd: __dirname });
  return status.stdout.trim().length > 0;
}

function runUpdateScript() {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', 'update.sh');
    const child = spawn('bash', [scriptPath, '--auto'], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`update.sh exited with code ${code}`));
    });
  });
}

async function autoUpdateTick(trigger = 'interval', force = false) {
  if ((!AUTO_UPDATE_ENABLED && !force) || autoUpdateState.inProgress) return;
  autoUpdateState.inProgress = true;
  autoUpdateState.lastCheck = Date.now();

  try {
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      autoUpdateState.lastResult = 'not-git';
      logWarn('[Auto Update] Skipped - not a git repository');
      return;
    }

    try {
      await execFilePromise('git', ['--version']);
    } catch {
      autoUpdateState.lastResult = 'no-git';
      logWarn('[Auto Update] Skipped - git not installed');
      return;
    }

    if (await hasDirtyWorkingTree()) {
      autoUpdateState.lastResult = 'dirty';
      logWarn('[Auto Update] Skipped - local changes detected');
      return;
    }

    const { updateAvailable } = await hasGitUpdates();
    if (!updateAvailable) {
      autoUpdateState.lastResult = 'up-to-date';
      logInfo(`[Auto Update] Up to date (${trigger})`);
      return;
    }

    autoUpdateState.lastResult = 'updating';
    logInfo('[Auto Update] Updates available - running update script');
    await runUpdateScript();
    autoUpdateState.lastResult = 'updated';
    logInfo('[Auto Update] Update complete');

    if (AUTO_UPDATE_EXIT_AFTER) {
      logInfo('[Auto Update] Exiting to allow restart');
      process.exit(0);
    }
  } catch (err) {
    autoUpdateState.lastResult = 'error';
    logErrorOnce('Auto Update', err.message);
  } finally {
    autoUpdateState.inProgress = false;
  }
}

function startAutoUpdateScheduler() {
  if (!AUTO_UPDATE_ENABLED) return;
  const intervalMinutes = Number.isFinite(AUTO_UPDATE_INTERVAL_MINUTES) && AUTO_UPDATE_INTERVAL_MINUTES > 0
    ? AUTO_UPDATE_INTERVAL_MINUTES
    : 60;
  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;

  logInfo(`[Auto Update] Enabled - every ${intervalMinutes} minutes`);

  if (AUTO_UPDATE_ON_START) {
    setTimeout(() => autoUpdateTick('startup'), 30000);
  }

  setInterval(() => autoUpdateTick('interval'), intervalMs);
}

// Serve static files
// dist/ contains the built React app (from npm run build)
// public/ contains the fallback page if build hasn't run
const distDir = path.join(__dirname, 'dist');
const publicDir = path.join(__dirname, 'public');

// Check if dist/ exists (has index.html from build)
const distExists = fs.existsSync(path.join(distDir, 'index.html'));

// Static file caching options
const staticOptions = {
  maxAge: '1d', // Cache static files for 1 day
  etag: true,
  lastModified: true
};

// Long-term caching for hashed assets (Vite adds hash to filenames)
const assetOptions = {
  maxAge: '1y', // Cache hashed assets for 1 year
  immutable: true
};

if (distExists) {
  // Serve built React app from dist/
  // Hashed assets (with content hash in filename) can be cached forever
  app.use('/assets', express.static(path.join(distDir, 'assets'), assetOptions));
  app.use(express.static(distDir, staticOptions));
  console.log('[Server] Serving React app from dist/');
} else {
  // No build found - serve placeholder from public/
  console.log('[Server] ⚠️  No build found! Run: npm run build');
}

// Always serve public folder (for fallback and assets)
app.use(express.static(publicDir, staticOptions));

// ============================================
// API PROXY ENDPOINTS
// ============================================

// Centralized cache for NOAA data (5-minute cache)
const noaaCache = {
  flux: { data: null, timestamp: 0 },
  kindex: { data: null, timestamp: 0 },
  sunspots: { data: null, timestamp: 0 },
  xray: { data: null, timestamp: 0 },
  aurora: { data: null, timestamp: 0 },
  solarIndices: { data: null, timestamp: 0 }
};
const NOAA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// NOAA Space Weather - Solar Flux
app.get('/api/noaa/flux', async (req, res) => {
  try {
    if (noaaCache.flux.data && (Date.now() - noaaCache.flux.timestamp) < NOAA_CACHE_TTL) {
      return res.json(noaaCache.flux.data);
    }
    const response = await fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json');
    const data = await response.json();
    noaaCache.flux = { data, timestamp: Date.now() };
    res.json(data);
  } catch (error) {
    logErrorOnce('NOAA Flux', error.message);
    if (noaaCache.flux.data) return res.json(noaaCache.flux.data);
    res.status(500).json({ error: 'Failed to fetch solar flux data' });
  }
});

// NOAA Space Weather - K-Index
app.get('/api/noaa/kindex', async (req, res) => {
  try {
    if (noaaCache.kindex.data && (Date.now() - noaaCache.kindex.timestamp) < NOAA_CACHE_TTL) {
      return res.json(noaaCache.kindex.data);
    }
    const response = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    const data = await response.json();
    noaaCache.kindex = { data, timestamp: Date.now() };
    res.json(data);
  } catch (error) {
    logErrorOnce('NOAA K-Index', error.message);
    if (noaaCache.kindex.data) return res.json(noaaCache.kindex.data);
    res.status(500).json({ error: 'Failed to fetch K-index data' });
  }
});

// NOAA Space Weather - Sunspots
app.get('/api/noaa/sunspots', async (req, res) => {
  try {
    if (noaaCache.sunspots.data && (Date.now() - noaaCache.sunspots.timestamp) < NOAA_CACHE_TTL) {
      return res.json(noaaCache.sunspots.data);
    }
    const response = await fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json');
    const data = await response.json();
    noaaCache.sunspots = { data, timestamp: Date.now() };
    res.json(data);
  } catch (error) {
    logErrorOnce('NOAA Sunspots', error.message);
    if (noaaCache.sunspots.data) return res.json(noaaCache.sunspots.data);
    res.status(500).json({ error: 'Failed to fetch sunspot data' });
  }
});

// Solar Indices with History and Kp Forecast
app.get('/api/solar-indices', async (req, res) => {
  try {
    // Check cache first
    if (noaaCache.solarIndices.data && (Date.now() - noaaCache.solarIndices.timestamp) < NOAA_CACHE_TTL) {
      return res.json(noaaCache.solarIndices.data);
    }
    
    const [fluxRes, kIndexRes, kForecastRes, sunspotRes] = await Promise.allSettled([
      fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json')
    ]);

    const result = {
      sfi: { current: null, history: [] },
      kp: { current: null, history: [], forecast: [] },
      ssn: { current: null, history: [] },
      timestamp: new Date().toISOString()
    };

    // Process SFI data (last 30 days)
    if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
      const data = await fluxRes.value.json();
      if (data?.length) {
        // Get last 30 entries
        const recent = data.slice(-30);
        result.sfi.history = recent.map(d => ({
          date: d.time_tag || d.date,
          value: Math.round(d.flux || d.value || 0)
        }));
        result.sfi.current = result.sfi.history[result.sfi.history.length - 1]?.value || null;
      }
    }

    // Process Kp history (last 3 days, data comes in 3-hour intervals)
    if (kIndexRes.status === 'fulfilled' && kIndexRes.value.ok) {
      const data = await kIndexRes.value.json();
      if (data?.length > 1) {
        // Skip header row, get last 24 entries (3 days)
        const recent = data.slice(1).slice(-24);
        result.kp.history = recent.map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
        result.kp.current = result.kp.history[result.kp.history.length - 1]?.value || null;
      }
    }

    // Process Kp forecast
    if (kForecastRes.status === 'fulfilled' && kForecastRes.value.ok) {
      const data = await kForecastRes.value.json();
      if (data?.length > 1) {
        // Skip header row
        result.kp.forecast = data.slice(1).map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
      }
    }

    // Process Sunspot data (last 12 months)
    if (sunspotRes.status === 'fulfilled' && sunspotRes.value.ok) {
      const data = await sunspotRes.value.json();
      if (data?.length) {
        // Get last 12 entries (monthly data)
        const recent = data.slice(-12);
        result.ssn.history = recent.map(d => ({
          date: `${d['time-tag'] || d.time_tag || ''}`,
          value: Math.round(d.ssn || 0)
        }));
        result.ssn.current = result.ssn.history[result.ssn.history.length - 1]?.value || null;
      }
    }

    // Cache the result
    noaaCache.solarIndices = { data: result, timestamp: Date.now() };
    
    res.json(result);
  } catch (error) {
    logErrorOnce('Solar Indices', error.message);
    // Return stale cache on error
    if (noaaCache.solarIndices.data) return res.json(noaaCache.solarIndices.data);
    res.status(500).json({ error: 'Failed to fetch solar indices' });
  }
});

// DXpedition Calendar - fetches from NG3K ADXO plain text version
let dxpeditionCache = { data: null, timestamp: 0, maxAge: 30 * 60 * 1000 }; // 30 min cache

app.get('/api/dxpeditions', async (req, res) => {
  try {
    const now = Date.now();
    logDebug('[DXpeditions] API called');
    
    // Return cached data if fresh
    if (dxpeditionCache.data && (now - dxpeditionCache.timestamp) < dxpeditionCache.maxAge) {
      logDebug('[DXpeditions] Returning cached data:', dxpeditionCache.data.dxpeditions?.length, 'entries');
      return res.json(dxpeditionCache.data);
    }
    
    // Fetch NG3K ADXO plain text version
    logDebug('[DXpeditions] Fetching from NG3K...');
    const response = await fetch('https://www.ng3k.com/Misc/adxoplain.html');
    if (!response.ok) {
      logDebug('[DXpeditions] NG3K fetch failed:', response.status);
      throw new Error('Failed to fetch NG3K: ' + response.status);
    }
    
    let text = await response.text();
    logDebug('[DXpeditions] Received', text.length, 'bytes raw');
    
    // Strip HTML tags and decode entities - the "plain" page is actually HTML!
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles  
      .replace(/<br\s*\/?>/gi, '\n') // Convert br to newlines
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    logDebug('[DXpeditions] Cleaned text length:', text.length);
    logDebug('[DXpeditions] First 500 chars:', text.substring(0, 500));
    
    const dxpeditions = [];
    
    // Each entry starts with a date pattern like "Jan 1-Feb 16, 2026 DXCC:"
    // Split on date patterns that are followed by DXCC
    const entryPattern = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}[^D]*?DXCC:[^·]+?)(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|$)/gi;
    const entries = text.match(entryPattern) || [];
    
    logDebug('[DXpeditions] Found', entries.length, 'potential entries');
    
    // Log first 3 entries for debugging
    entries.slice(0, 3).forEach((e, i) => {
      logDebug(`[DXpeditions] Entry ${i}:`, e.substring(0, 150));
    });
    
    for (const entry of entries) {
      if (!entry.trim()) continue;
      
      // Skip header/footer/legend content
      if (entry.includes('ADXB=') || entry.includes('OPDX=') || entry.includes('425DX=') ||
          entry.includes('Last updated') || entry.includes('Copyright') || 
          entry.includes('Expired Announcements') || entry.includes('Table Version') ||
          entry.includes('About ADXO') || entry.includes('Search ADXO') ||
          entry.includes('GazDX=') || entry.includes('LNDX=') || entry.includes('TDDX=') ||
          entry.includes('DXW.Net=') || entry.includes('DXMB=')) continue;
      
      // Try multiple parsing strategies
      let callsign = null;
      let entity = null;
      let qsl = null;
      let info = null;
      let dateStr = null;
      
      // Strategy 1: "DXCC: xxx Callsign: xxx" format
      const dxccMatch = entry.match(/DXCC:\s*([^C\n]+?)(?=Callsign:|QSL:|Source:|Info:|$)/i);
      const callMatch = entry.match(/Callsign:\s*([A-Z0-9\/]+)/i);
      
      if (callMatch && dxccMatch) {
        callsign = callMatch[1].trim().toUpperCase();
        entity = dxccMatch[1].trim();
      }
      
      // Strategy 2: Look for callsign patterns directly (like "3Y0K" or "VP8/G3ABC")
      if (!callsign) {
        const directCallMatch = entry.match(/\b([A-Z]{1,2}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]+)?)\b/);
        if (directCallMatch) {
          callsign = directCallMatch[1];
        }
      }
      
      // Strategy 3: Parse "Entity - Callsign" or similar patterns
      if (!callsign) {
        const altMatch = entry.match(/([A-Za-z\s&]+?)\s*[-–:]\s*([A-Z]{1,2}\d[A-Z0-9]*)/);
        if (altMatch) {
          entity = altMatch[1].trim();
          callsign = altMatch[2].trim();
        }
      }
      
      // Extract other fields
      const qslMatch = entry.match(/QSL:\s*([A-Za-z0-9]+)/i);
      const infoMatch = entry.match(/Info:\s*(.+)/i);
      // Date is at the start of entry: "Jan 1-Feb 16, 2026"
      const dateMatch = entry.match(/^([A-Za-z]{3}\s+\d{1,2}[^D]*?)(?=DXCC:)/i);
      
      qsl = qslMatch ? qslMatch[1].trim() : '';
      info = infoMatch ? infoMatch[1].trim() : '';
      dateStr = dateMatch ? dateMatch[1].trim() : '';
      
      // Skip if we couldn't find a callsign
      if (!callsign || callsign.length < 3) continue;
      
      // Skip obviously wrong matches
      if (/^(DXCC|QSL|INFO|SOURCE|THE|AND|FOR)$/i.test(callsign)) continue;
      
      // Log first few successful parses
      if (dxpeditions.length < 3) {
        logDebug(`[DXpeditions] Parsed: ${callsign} - ${entity} - ${dateStr}`);
      }
      
      // Try to extract entity from context if not found
      if (!entity && info) {
        // Look for "from Entity" or "fm Entity" patterns
        const fromMatch = info.match(/(?:from|fm)\s+([A-Za-z\s]+?)(?:;|,|$)/i);
        if (fromMatch) entity = fromMatch[1].trim();
      }
      
      // Parse dates
      let startDate = null;
      let endDate = null;
      let isActive = false;
      let isUpcoming = false;
      
      if (dateStr) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const datePattern = /([A-Za-z]{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\s*[-–]\s*([A-Za-z]{3})?\s*(\d{1,2})(?:,?\s*(\d{4}))?)?/i;
        const dateParsed = dateStr.match(datePattern);
        
        if (dateParsed) {
          const currentYear = new Date().getFullYear();
          const startMonth = monthNames.indexOf(dateParsed[1].toLowerCase());
          const startDay = parseInt(dateParsed[2]);
          const startYear = dateParsed[3] ? parseInt(dateParsed[3]) : currentYear;
          
          const endMonthStr = dateParsed[4] || dateParsed[1];
          const endMonth = monthNames.indexOf(endMonthStr.toLowerCase());
          const endDay = parseInt(dateParsed[5]) || startDay + 14;
          const endYear = dateParsed[6] ? parseInt(dateParsed[6]) : startYear;
          
          if (startMonth >= 0) {
            startDate = new Date(startYear, startMonth, startDay);
            endDate = new Date(endYear, endMonth >= 0 ? endMonth : startMonth, endDay);
            
            if (endDate < startDate && !dateParsed[6]) {
              endDate.setFullYear(endYear + 1);
            }
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            isActive = startDate <= today && endDate >= today;
            isUpcoming = startDate > today;
          }
        }
      }
      
      // Extract bands and modes
      const bandsMatch = entry.match(/(\d+(?:-\d+)?m)/g);
      const bands = bandsMatch ? [...new Set(bandsMatch)].join(' ') : '';
      
      const modesMatch = entry.match(/\b(CW|SSB|FT8|FT4|RTTY|PSK|FM|AM|DIGI)\b/gi);
      const modes = modesMatch ? [...new Set(modesMatch.map(m => m.toUpperCase()))].join(' ') : '';
      
      dxpeditions.push({
        callsign,
        entity: entity || 'Unknown',
        dates: dateStr,
        qsl,
        info: (info || '').substring(0, 100),
        bands,
        modes,
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
        isActive,
        isUpcoming
      });
    }
    
    // Remove duplicates by callsign
    const seen = new Set();
    const uniqueDxpeditions = dxpeditions.filter(d => {
      if (seen.has(d.callsign)) return false;
      seen.add(d.callsign);
      return true;
    });
    
    // Sort: active first, then upcoming by start date
    uniqueDxpeditions.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isUpcoming && !b.isUpcoming) return -1;
      if (!a.isUpcoming && b.isUpcoming) return 1;
      if (a.startDate && b.startDate) return new Date(a.startDate) - new Date(b.startDate);
      return 0;
    });
    
    logDebug('[DXpeditions] Parsed', uniqueDxpeditions.length, 'unique entries');
    if (uniqueDxpeditions.length > 0) {
      logDebug('[DXpeditions] First entry:', JSON.stringify(uniqueDxpeditions[0]));
    }
    
    const result = {
      dxpeditions: uniqueDxpeditions.slice(0, 50),
      active: uniqueDxpeditions.filter(d => d.isActive).length,
      upcoming: uniqueDxpeditions.filter(d => d.isUpcoming).length,
      source: 'NG3K ADXO',
      timestamp: new Date().toISOString()
    };
    
    logDebug('[DXpeditions] Result:', result.active, 'active,', result.upcoming, 'upcoming');
    
    dxpeditionCache.data = result;
    dxpeditionCache.timestamp = now;
    
    res.json(result);
  } catch (error) {
    logErrorOnce('DXpeditions', error.message);
    
    if (dxpeditionCache.data) {
      logDebug('[DXpeditions] Returning stale cache');
      return res.json({ ...dxpeditionCache.data, stale: true });
    }
    
    res.status(500).json({ error: 'Failed to fetch DXpedition data' });
  }
});

// NOAA Space Weather - X-Ray Flux
app.get('/api/noaa/xray', async (req, res) => {
  try {
    if (noaaCache.xray.data && (Date.now() - noaaCache.xray.timestamp) < NOAA_CACHE_TTL) {
      return res.json(noaaCache.xray.data);
    }
    const response = await fetch('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json');
    const data = await response.json();
    noaaCache.xray = { data, timestamp: Date.now() };
    res.json(data);
  } catch (error) {
    logErrorOnce('NOAA X-Ray', error.message);
    if (noaaCache.xray.data) return res.json(noaaCache.xray.data);
    res.status(500).json({ error: 'Failed to fetch X-ray data' });
  }
});

// NOAA OVATION Aurora Forecast
const AURORA_CACHE_TTL = 10 * 60 * 1000; // 10 minutes (NOAA updates every ~30 min)
app.get('/api/noaa/aurora', async (req, res) => {
  try {
    if (noaaCache.aurora.data && (Date.now() - noaaCache.aurora.timestamp) < AURORA_CACHE_TTL) {
      return res.json(noaaCache.aurora.data);
    }
    const response = await fetch('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json');
    const data = await response.json();
    noaaCache.aurora = { data, timestamp: Date.now() };
    res.json(data);
  } catch (error) {
    logErrorOnce('NOAA Aurora', error.message);
    if (noaaCache.aurora.data) return res.json(noaaCache.aurora.data);
    res.status(500).json({ error: 'Failed to fetch aurora data' });
  }
});

// DX News from dxnews.com
let dxNewsCache = { data: null, timestamp: 0 };
const DXNEWS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/api/dxnews', async (req, res) => {
  try {
    if (dxNewsCache.data && (Date.now() - dxNewsCache.timestamp) < DXNEWS_CACHE_TTL) {
      return res.json(dxNewsCache.data);
    }

    const response = await fetch('https://dxnews.com/', {
      headers: { 'User-Agent': 'OpenHamClock/1.0 (amateur radio dashboard)' }
    });
    const html = await response.text();

    // Parse news items from HTML
    const items = [];
    // Match pattern: <h3><a href="URL" title="TITLE">TITLE</a></h3> followed by date and description
    const articleRegex = /<h3[^>]*>\s*<a\s+href="([^"]+)"\s+title="([^"]+)"[^>]*>[^<]*<\/a>\s*<\/h3>\s*[\s\S]*?(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*[\s\S]*?<\/li>\s*<\/ul>\s*([\s\S]*?)(?:<ul|<div\s+class="more"|<\/div>)/g;

    // Simpler approach: split by article blocks
    const blocks = html.split(/<h3[^>]*>\s*<a\s+href="/);
    for (let i = 1; i < blocks.length && items.length < 20; i++) {
      try {
        const block = blocks[i];
        // Extract URL
        const urlMatch = block.match(/^([^"]+)"/);
        // Extract title
        const titleMatch = block.match(/title="([^"]+)"/);
        // Extract date
        const dateMatch = block.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        // Extract description - text after the date, before stats
        const descParts = block.split(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
        let desc = '';
        if (descParts[1]) {
          // Get text content, strip HTML tags, then remove stats/junk
          desc = descParts[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/Views\s*\d+.*/i, '')
            .replace(/Comments\s*\d+.*/i, '')
            .replace(/\d+%/, '')
            .replace(/More\.\.\..*/i, '')
            .trim()
            .substring(0, 200);
        }

        if (titleMatch && urlMatch) {
          items.push({
            title: titleMatch[1],
            url: 'https://dxnews.com/' + urlMatch[1],
            date: dateMatch ? dateMatch[1] : null,
            description: desc || titleMatch[1]
          });
        }
      } catch (e) {
        // Skip malformed entries
      }
    }

    const result = { items, fetched: new Date().toISOString() };
    dxNewsCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (error) {
    logErrorOnce('DX News', error.message);
    if (dxNewsCache.data) return res.json(dxNewsCache.data);
    res.status(500).json({ error: 'Failed to fetch DX news', items: [] });
  }
});

// POTA Spots
// POTA cache (1 minute)
let potaCache = { data: null, timestamp: 0 };
const POTA_CACHE_TTL = 60 * 1000; // 1 minute

app.get('/api/pota/spots', async (req, res) => {
  try {
    // Return cached data if fresh
    if (potaCache.data && (Date.now() - potaCache.timestamp) < POTA_CACHE_TTL) {
      return res.json(potaCache.data);
    }
    
    const response = await fetch('https://api.pota.app/spot/activator');
    const data = await response.json();
    
    // Log diagnostic info about the response
    if (Array.isArray(data) && data.length > 0) {
      const sample = data[0];
      logDebug('[POTA] API returned', data.length, 'spots. Sample fields:', Object.keys(sample).join(', '));
      
      // Count coordinate coverage
      const withLatLon = data.filter(s => s.latitude && s.longitude).length;
      const withGrid6 = data.filter(s => s.grid6).length;
      const withGrid4 = data.filter(s => s.grid4).length;
      const noCoords = data.filter(s => !s.latitude && !s.longitude && !s.grid6 && !s.grid4).length;
      logDebug(`[POTA] Coords: ${withLatLon} lat/lon, ${withGrid6} grid6, ${withGrid4} grid4, ${noCoords} no coords`);
    }
    
    // Cache the response
    potaCache = { data, timestamp: Date.now() };
    
    res.json(data);
  } catch (error) {
    logErrorOnce('POTA', error.message);
    // Return stale cache on error
    if (potaCache.data) return res.json(potaCache.data);
    res.status(500).json({ error: 'Failed to fetch POTA spots' });
  }
});

// SOTA cache (2 minutes)
let sotaCache = { data: null, timestamp: 0 };
const SOTA_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// SOTA Spots
app.get('/api/sota/spots', async (req, res) => {
  try {
    // Return cached data if fresh
    if (sotaCache.data && (Date.now() - sotaCache.timestamp) < SOTA_CACHE_TTL) {
      return res.json(sotaCache.data);
    }
    
    const response = await fetch('https://api2.sota.org.uk/api/spots/50/all');
    const data = await response.json();
    
    // Cache the response
    sotaCache = { data, timestamp: Date.now() };
    
    res.json(data);
  } catch (error) {
    logErrorOnce('SOTA', error.message);
    if (sotaCache.data) return res.json(sotaCache.data);
    res.status(500).json({ error: 'Failed to fetch SOTA spots' });
  }
});

// HamQSL cache (5 minutes)
let hamqslCache = { data: null, timestamp: 0 };
const HAMQSL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// HamQSL Band Conditions
app.get('/api/hamqsl/conditions', async (req, res) => {
  try {
    // Return cached data if fresh
    if (hamqslCache.data && (Date.now() - hamqslCache.timestamp) < HAMQSL_CACHE_TTL) {
      res.set('Content-Type', 'application/xml');
      return res.send(hamqslCache.data);
    }
    
    const response = await fetch('https://www.hamqsl.com/solarxml.php');
    const text = await response.text();
    
    // Cache the response
    hamqslCache = { data: text, timestamp: Date.now() };
    
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (error) {
    logErrorOnce('HamQSL', error.message);
    if (hamqslCache.data) {
      res.set('Content-Type', 'application/xml');
      return res.send(hamqslCache.data);
    }
    res.status(500).json({ error: 'Failed to fetch band conditions' });
  }
});

// DX Cluster proxy - fetches from selectable sources
// Query param: ?source=hamqth|dxspider|proxy|auto (default: auto)
// Note: DX Spider uses telnet - works locally but may be blocked on cloud hosting
// The 'proxy' source uses our DX Spider Proxy microservice

// DX Spider Proxy URL (sibling service on Railway or external)
const DXSPIDER_PROXY_URL = process.env.DXSPIDER_PROXY_URL || 'https://dxspider-proxy-production-1ec7.up.railway.app';

// Cache for DX Spider telnet spots (to avoid excessive connections)
let dxSpiderCache = { spots: [], timestamp: 0 };
const DXSPIDER_CACHE_TTL = 90000; // 90 seconds cache - reduces reconnection frequency

app.get('/api/dxcluster/spots', async (req, res) => {
  const source = (req.query.source || CONFIG.dxClusterSource || 'auto').toLowerCase();
  
  // Helper function for HamQTH (HTTP-based, works everywhere)
  async function fetchHamQTH() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=25', {
        headers: { 'User-Agent': 'OpenHamClock/3.5' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const text = await response.text();
        // HamQTH CSV format: Spotter^Frequency^DXCall^Comment^TimeDate^^^Continent^Band^Country^DXCC
        // Example: KF0NYM^18070.0^TX5U^Correction, Good Sig MO, 73^2149 2025-05-27^^^EU^17M^France^227
        const lines = text.trim().split('\n').filter(line => line.includes('^'));
        
        if (lines.length > 0) {
          const spots = lines.slice(0, 25).map(line => {
            const parts = line.split('^');
            const spotter = parts[0] || '';
            const freqKhz = parseFloat(parts[1]) || 0;
            const dxCall = parts[2] || 'UNKNOWN';
            const comment = parts[3] || '';
            const timeDate = parts[4] || '';
            
            // Frequency: convert from kHz to MHz
            const freqMhz = freqKhz > 1000 ? (freqKhz / 1000).toFixed(3) : String(freqKhz);
            
            // Time: extract HHMM from "2149 2025-05-27" format
            let time = '';
            if (timeDate && timeDate.length >= 4) {
              const timeStr = timeDate.substring(0, 4);
              time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
            }
            
            return {
              freq: freqMhz,
              call: dxCall,
              comment: comment,
              time: time,
              spotter: spotter,
              source: 'HamQTH'
            };
          });
          logDebug('[DX Cluster] HamQTH:', spots.length, 'spots');
          return spots;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name !== 'AbortError') {
        logErrorOnce('DX Cluster', `HamQTH: ${error.message}`);
      }
    }
    return null;
  }
  
  // Helper function for DX Spider Proxy (our microservice)
  async function fetchDXSpiderProxy() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch(`${DXSPIDER_PROXY_URL}/api/dxcluster/spots?limit=50`, {
        headers: { 'User-Agent': 'OpenHamClock/3.5' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const spots = await response.json();
        if (Array.isArray(spots) && spots.length > 0) {
          logDebug('[DX Cluster] DX Spider Proxy:', spots.length, 'spots');
          return spots;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name !== 'AbortError') {
        logErrorOnce('DX Cluster', `Proxy: ${error.message}`);
      }
    }
    return null;
  }
  
  // Helper function for DX Spider (telnet-based, works locally/Pi)
  // Multiple nodes for failover
  // DX Spider nodes - dxspider.co.uk primary per G6NHU
  // SSID -56 for OpenHamClock (HamClock uses -55)
  const DXSPIDER_NODES = [
    { host: 'dxspider.co.uk', port: 7300 },
    { host: 'dxc.nc7j.com', port: 7373 },
    { host: 'dxc.ai9t.com', port: 7373 },
    { host: 'dxc.w6cua.org', port: 7300 }
  ];
  const DXSPIDER_SSID = '-56'; // OpenHamClock SSID
  
  async function fetchDXSpider() {
    // Check cache first (use longer cache to reduce connection attempts)
    if (Date.now() - dxSpiderCache.timestamp < DXSPIDER_CACHE_TTL && dxSpiderCache.spots.length > 0) {
      logDebug('[DX Cluster] DX Spider: returning', dxSpiderCache.spots.length, 'cached spots');
      return dxSpiderCache.spots;
    }
    
    // Try each node until one succeeds
    for (const node of DXSPIDER_NODES) {
      const result = await tryDXSpiderNode(node);
      if (result && result.length > 0) {
        return result;
      }
    }
    
    logDebug('[DX Cluster] DX Spider: all nodes failed');
    return null;
  }
  
  function tryDXSpiderNode(node) {
    return new Promise((resolve) => {
      const spots = [];
      let buffer = '';
      let loginSent = false;
      let commandSent = false;
      let resolved = false;
      
      const client = new net.Socket();
      client.setTimeout(12000);
      
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try { client.destroy(); } catch(e) {}
        }
      };
      
      // Try connecting to DX Spider node
      client.connect(node.port, node.host, () => {
        logDebug(`[DX Cluster] DX Spider: connected to ${node.host}:${node.port}`);
      });
      
      client.on('data', (data) => {
        buffer += data.toString();
        
        // Wait for login prompt
        if (!loginSent && (buffer.includes('login:') || buffer.includes('Please enter your call') || buffer.includes('enter your callsign'))) {
          loginSent = true;
          client.write('GUEST\r\n');
          return;
        }
        
        // Wait for prompt after login, then send command
        if (loginSent && !commandSent && (buffer.includes('Hello') || buffer.includes('de ') || buffer.includes('>') || buffer.includes('GUEST'))) {
          commandSent = true;
          setTimeout(() => {
            if (!resolved) {
              client.write('sh/dx 25\r\n');
            }
          }, 1000);
          return;
        }
        
        // Parse DX spots from the output
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.includes('DX de ')) {
            const match = line.match(/DX de ([A-Z0-9\/\-]+):\s+(\d+\.?\d*)\s+([A-Z0-9\/\-]+)\s+(.+?)\s+(\d{4})Z/i);
            if (match) {
              const spotter = match[1].replace(':', '');
              const freqKhz = parseFloat(match[2]);
              const dxCall = match[3];
              const comment = match[4].trim();
              const timeStr = match[5];
              
              if (!isNaN(freqKhz) && freqKhz > 0 && dxCall) {
                const freqMhz = (freqKhz / 1000).toFixed(3);
                const time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
                
                // Avoid duplicates
                if (!spots.find(s => s.call === dxCall && s.freq === freqMhz)) {
                  spots.push({
                    freq: freqMhz,
                    call: dxCall,
                    comment: comment,
                    time: time,
                    spotter: spotter,
                    source: 'DX Spider'
                  });
                }
              }
            }
          }
        }
        
        // If we have enough spots, close connection
        if (spots.length >= 20) {
          client.write('bye\r\n');
          setTimeout(cleanup, 500);
        }
      });
      
      client.on('timeout', () => {
        cleanup();
      });
      
      client.on('error', (err) => {
        // Only log unexpected errors, not connection issues (they're common)
        if (!err.message.includes('ECONNRESET') && !err.message.includes('ETIMEDOUT') && !err.message.includes('ENOTFOUND') && !err.message.includes('ECONNREFUSED')) {
          logErrorOnce('DX Cluster', `DX Spider ${node.host}: ${err.message}`);
        }
        cleanup();
      });
      
      client.on('close', () => {
        if (!resolved) {
          resolved = true;
          if (spots.length > 0) {
            logDebug('[DX Cluster] DX Spider:', spots.length, 'spots from', node.host);
            dxSpiderCache = { spots: spots, timestamp: Date.now() };
            resolve(spots);
          } else {
            resolve(null);
          }
        }
      });
      
      // Fallback timeout - close after 15 seconds regardless
      setTimeout(() => {
        if (!resolved) {
          if (spots.length > 0) {
            resolved = true;
            logDebug('[DX Cluster] DX Spider:', spots.length, 'spots from', node.host);
            dxSpiderCache = { spots: spots, timestamp: Date.now() };
            resolve(spots);
          }
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      }, 15000);
    });
  }
  
  // Fetch based on selected source
  let spots = null;
  
  if (source === 'hamqth') {
    spots = await fetchHamQTH();
  } else if (source === 'proxy') {
    spots = await fetchDXSpiderProxy();
    // Fallback to HamQTH if proxy fails
    if (!spots) {
      logDebug('[DX Cluster] Proxy failed, falling back to HamQTH');
      spots = await fetchHamQTH();
    }
  } else if (source === 'dxspider') {
    spots = await fetchDXSpider();
    // Fallback to HamQTH if DX Spider fails
    if (!spots) {
      logDebug('[DX Cluster] DX Spider failed, falling back to HamQTH');
      spots = await fetchHamQTH();
    }
  } else {
    // Auto mode - try Proxy first (best for Railway), then HamQTH, then DX Spider
    spots = await fetchDXSpiderProxy();
    if (!spots) {
      spots = await fetchHamQTH();
    }
    if (!spots) {
      spots = await fetchDXSpider();
    }
  }
  
  res.json(spots || []);
});

// Get available DX cluster sources
app.get('/api/dxcluster/sources', (req, res) => {
  res.json([
    { id: 'auto', name: 'Auto (Best Available)', description: 'Tries Proxy first, then HamQTH, then direct telnet' },
    { id: 'proxy', name: 'DX Spider Proxy ⭐', description: 'Our dedicated proxy service - real-time telnet feed via HTTP' },
    { id: 'hamqth', name: 'HamQTH', description: 'HamQTH.com CSV feed (HTTP, works everywhere)' },
    { id: 'dxspider', name: 'DX Spider Direct', description: 'Direct telnet to dxspider.co.uk (G6NHU) - works locally/Pi' }
  ]);
});

// ============================================
// DX SPOT PATHS API - Get spots with locations for map visualization
// Returns spots from the last 5 minutes with spotter and DX locations
// ============================================

// Cache for DX spot paths to avoid excessive lookups
let dxSpotPathsCache = { paths: [], allPaths: [], timestamp: 0 };
const DXPATHS_CACHE_TTL = 5000; // 5 seconds cache between fetches
const DXPATHS_RETENTION = 30 * 60 * 1000; // 30 minute spot retention

app.get('/api/dxcluster/paths', async (req, res) => {
  // Check cache first
  if (Date.now() - dxSpotPathsCache.timestamp < DXPATHS_CACHE_TTL && dxSpotPathsCache.paths.length > 0) {
    logDebug('[DX Paths] Returning', dxSpotPathsCache.paths.length, 'cached paths');
    return res.json(dxSpotPathsCache.paths);
  }
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const now = Date.now();
    
    // Try proxy first for better real-time data
    let newSpots = [];
    let usedSource = 'none';
    
    try {
      const proxyResponse = await fetch(`${DXSPIDER_PROXY_URL}/api/spots?limit=100`, {
        headers: { 'User-Agent': 'OpenHamClock/3.7' },
        signal: controller.signal
      });
      
      if (proxyResponse.ok) {
        const proxyData = await proxyResponse.json();
        if (proxyData.spots && proxyData.spots.length > 0) {
          usedSource = 'proxy';
          newSpots = proxyData.spots.map(s => ({
            spotter: s.spotter,
            spotterGrid: s.spotterGrid || null,
            dxCall: s.call,
            dxGrid: s.dxGrid || null,
            freq: s.freq,
            comment: s.comment || '',
            time: s.time || '',
            id: `${s.call}-${s.freqKhz || s.freq}-${s.spotter}`
          }));
          logDebug('[DX Paths] Got', newSpots.length, 'spots from proxy');
        }
      }
    } catch (proxyErr) {
      logDebug('[DX Paths] Proxy failed, trying HamQTH');
    }
    
    // Fallback to HamQTH if proxy failed
    if (newSpots.length === 0) {
      try {
        const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=50', {
          headers: { 'User-Agent': 'OpenHamClock/3.7' },
          signal: controller.signal
        });
        
        if (response.ok) {
          const text = await response.text();
          const lines = text.trim().split('\n').filter(line => line.includes('^'));
          usedSource = 'hamqth';
          
          for (const line of lines) {
            const parts = line.split('^');
            if (parts.length < 5) continue;
            
            const spotter = parts[0]?.trim().toUpperCase();
            const freqKhz = parseFloat(parts[1]) || 0;
            const dxCall = parts[2]?.trim().toUpperCase();
            const comment = parts[3]?.trim() || '';
            const timeDate = parts[4]?.trim() || '';
            
            if (!spotter || !dxCall || freqKhz <= 0) continue;
            
            // Extract grids from comment for HamQTH data too
            const grids = extractGridsFromComment(comment);
            
            newSpots.push({
              spotter,
              spotterGrid: grids.spotterGrid,
              dxCall,
              dxGrid: grids.dxGrid,
              freq: (freqKhz / 1000).toFixed(3),
              comment,
              time: timeDate.length >= 4 ? timeDate.substring(0, 2) + ':' + timeDate.substring(2, 4) + 'z' : '',
              id: `${dxCall}-${freqKhz}-${spotter}`
            });
          }
          logDebug('[DX Paths] Got', newSpots.length, 'spots from HamQTH');
        }
      } catch (hamqthErr) {
        logDebug('[DX Paths] HamQTH also failed');
      }
    }
    
    clearTimeout(timeout);
    
    if (newSpots.length === 0) {
      // Return existing paths if fetch failed
      const validPaths = dxSpotPathsCache.allPaths.filter(p => (now - p.timestamp) < DXPATHS_RETENTION);
      return res.json(validPaths.slice(0, 50));
    }
    
    // Get unique callsigns to look up
    const allCalls = new Set();
    newSpots.forEach(s => {
      allCalls.add(s.spotter);
      allCalls.add(s.dxCall);
    });
    
    // Look up prefix-based locations for all callsigns (includes grid squares!)
    const prefixLocations = {};
    const callsToLookup = [...allCalls].slice(0, 100);
    
    for (const call of callsToLookup) {
      const loc = estimateLocationFromPrefix(call);
      if (loc) {
        prefixLocations[call] = { 
          lat: loc.lat, 
          lon: loc.lon, 
          country: loc.country, 
          grid: loc.grid || null,  // Include grid from prefix mapping!
          source: loc.grid ? 'prefix-grid' : 'prefix' 
        };
      }
    }
    
    // Build new paths with locations - try grid first, fall back to prefix
    const newPaths = newSpots
      .map(spot => {
        // DX station location - try grid from spot data first, then comment, then prefix
        let dxLoc = null;
        let dxGridSquare = null;
        
        // Check if spot already has dxGrid from proxy
        if (spot.dxGrid) {
          const gridLoc = maidenheadToLatLon(spot.dxGrid);
          if (gridLoc) {
            dxLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
            dxGridSquare = spot.dxGrid;
          }
        }
        
        // If no grid yet, try extracting from comment
        if (!dxLoc && spot.comment) {
          const extractedGrids = extractGridsFromComment(spot.comment);
          if (extractedGrids.dxGrid) {
            const gridLoc = maidenheadToLatLon(extractedGrids.dxGrid);
            if (gridLoc) {
              dxLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
              dxGridSquare = extractedGrids.dxGrid;
            }
          }
        }
        
        // Fall back to prefix location (now includes grid-based coordinates!)
        if (!dxLoc) {
          dxLoc = prefixLocations[spot.dxCall];
          if (dxLoc && dxLoc.grid) {
            dxGridSquare = dxLoc.grid;
          }
        }
        
        // Spotter location - try grid first, then prefix
        let spotterLoc = null;
        let spotterGridSquare = null;
        
        // Check if spot already has spotterGrid from proxy
        if (spot.spotterGrid) {
          const gridLoc = maidenheadToLatLon(spot.spotterGrid);
          if (gridLoc) {
            spotterLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
            spotterGridSquare = spot.spotterGrid;
          }
        }
        
        // If no grid yet, try extracting from comment (in case of dual grid format)
        if (!spotterLoc && spot.comment) {
          const extractedGrids = extractGridsFromComment(spot.comment);
          if (extractedGrids.spotterGrid) {
            const gridLoc = maidenheadToLatLon(extractedGrids.spotterGrid);
            if (gridLoc) {
              spotterLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
              spotterGridSquare = extractedGrids.spotterGrid;
            }
          }
        }
        
        // Fall back to prefix location for spotter (now includes grid-based coordinates!)
        if (!spotterLoc) {
          spotterLoc = prefixLocations[spot.spotter];
          if (spotterLoc && spotterLoc.grid) {
            spotterGridSquare = spotterLoc.grid;
          }
        }
        
        if (spotterLoc && dxLoc) {
          return {
            spotter: spot.spotter,
            spotterLat: spotterLoc.lat,
            spotterLon: spotterLoc.lon,
            spotterCountry: spotterLoc.country || '',
            spotterGrid: spotterGridSquare,
            spotterLocSource: spotterLoc.source,
            dxCall: spot.dxCall,
            dxLat: dxLoc.lat,
            dxLon: dxLoc.lon,
            dxCountry: dxLoc.country || '',
            dxGrid: dxGridSquare,
            dxLocSource: dxLoc.source,
            freq: spot.freq,
            comment: spot.comment,
            time: spot.time,
            id: spot.id,
            timestamp: now
          };
        }
        return null;
      })
      .filter(p => p !== null);
    
    // Merge with existing paths, removing expired and duplicates
    const existingValidPaths = dxSpotPathsCache.allPaths.filter(p => 
      (now - p.timestamp) < DXPATHS_RETENTION
    );
    
    // Add new paths, avoiding duplicates (same dxCall+freq within 2 minutes)
    const mergedPaths = [...existingValidPaths];
    for (const newPath of newPaths) {
      const isDuplicate = mergedPaths.some(existing => 
        existing.dxCall === newPath.dxCall && 
        existing.freq === newPath.freq &&
        (now - existing.timestamp) < 120000 // 2 minute dedup window
      );
      if (!isDuplicate) {
        mergedPaths.push(newPath);
      }
    }
    
    // Sort by timestamp (newest first) and limit
    const sortedPaths = mergedPaths.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
    
    logDebug('[DX Paths]', sortedPaths.length, 'total paths (', newPaths.length, 'new from', newSpots.length, 'spots)');
    
    // Update cache
    dxSpotPathsCache = { 
      paths: sortedPaths.slice(0, 50), // Return 50 for display
      allPaths: sortedPaths, // Keep all for accumulation
      timestamp: now 
    };
    
    res.json(dxSpotPathsCache.paths);
  } catch (error) {
    logErrorOnce('DX Paths', error.message);
    // Return cached data on error
    res.json(dxSpotPathsCache.paths || []);
  }
});

// ============================================
// CALLSIGN LOOKUP API (for getting location from callsign)
// ============================================

// Simple callsign to grid/location lookup using HamQTH
app.get('/api/callsign/:call', async (req, res) => {
  const callsign = req.params.call.toUpperCase();
  logDebug('[Callsign Lookup] Looking up:', callsign);
  
  try {
    // Try HamQTH XML API (no auth needed for basic lookup)
    const response = await fetch(`https://www.hamqth.com/dxcc.php?callsign=${callsign}`);
    if (response.ok) {
      const text = await response.text();
      
      // Parse basic info from response
      const latMatch = text.match(/<lat>([^<]+)<\/lat>/);
      const lonMatch = text.match(/<lng>([^<]+)<\/lng>/);
      const countryMatch = text.match(/<name>([^<]+)<\/name>/);
      const cqMatch = text.match(/<cq>([^<]+)<\/cq>/);
      const ituMatch = text.match(/<itu>([^<]+)<\/itu>/);
      
      if (latMatch && lonMatch) {
        const result = {
          callsign,
          lat: parseFloat(latMatch[1]),
          lon: parseFloat(lonMatch[1]),
          country: countryMatch ? countryMatch[1] : 'Unknown',
          cqZone: cqMatch ? cqMatch[1] : '',
          ituZone: ituMatch ? ituMatch[1] : ''
        };
        logDebug('[Callsign Lookup] Found:', result);
        return res.json(result);
      }
    }
    
    // Fallback: estimate location from callsign prefix
    const estimated = estimateLocationFromPrefix(callsign);
    if (estimated) {
      logDebug('[Callsign Lookup] Estimated from prefix:', estimated);
      return res.json(estimated);
    }
    
    res.status(404).json({ error: 'Callsign not found' });
  } catch (error) {
    logErrorOnce('Callsign Lookup', error.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Convert Maidenhead grid locator to lat/lon (center of grid square)
function maidenheadToLatLon(grid) {
  if (!grid || typeof grid !== 'string') return null;
  
  grid = grid.toUpperCase().trim();
  
  // Validate grid format (2, 4, 6, or 8 characters)
  if (!/^[A-R]{2}([0-9]{2}([A-X]{2}([0-9]{2})?)?)?$/.test(grid)) return null;
  
  let lon = -180;
  let lat = -90;
  
  // Field (2 chars): 20° lon x 10° lat
  lon += (grid.charCodeAt(0) - 65) * 20;
  lat += (grid.charCodeAt(1) - 65) * 10;
  
  if (grid.length >= 4) {
    // Square (2 digits): 2° lon x 1° lat
    lon += parseInt(grid[2]) * 2;
    lat += parseInt(grid[3]) * 1;
  }
  
  if (grid.length >= 6) {
    // Subsquare (2 chars): 5' lon x 2.5' lat
    lon += (grid.charCodeAt(4) - 65) * (5 / 60);
    lat += (grid.charCodeAt(5) - 65) * (2.5 / 60);
  }
  
  if (grid.length >= 8) {
    // Extended square (2 digits): 0.5' lon x 0.25' lat
    lon += parseInt(grid[6]) * (0.5 / 60);
    lat += parseInt(grid[7]) * (0.25 / 60);
  }
  
  // Add offset to center of the grid square
  if (grid.length === 2) {
    lon += 10; lat += 5;
  } else if (grid.length === 4) {
    lon += 1; lat += 0.5;
  } else if (grid.length === 6) {
    lon += 2.5 / 60; lat += 1.25 / 60;
  } else if (grid.length === 8) {
    lon += 0.25 / 60; lat += 0.125 / 60;
  }
  
  return { lat, lon, grid };
}

// Try to extract grid locators from a comment string
// Returns { spotterGrid, dxGrid } - may have one, both, or neither
function extractGridsFromComment(comment) {
  if (!comment || typeof comment !== 'string') return { spotterGrid: null, dxGrid: null };
  
  // Check for dual grid format: FN20<>EM79 or FN20->EM79 or FN20/EM79
  const dualGridMatch = comment.match(/\b([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\s*(?:<>|->|\/|<)\s*([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\b/);
  if (dualGridMatch) {
    const grid1 = dualGridMatch[1].toUpperCase();
    const grid2 = dualGridMatch[2].toUpperCase();
    // Validate both are real grids
    if (isValidGrid(grid1) && isValidGrid(grid2)) {
      return { spotterGrid: grid1, dxGrid: grid2 };
    }
  }
  
  // Look for all grids in the comment
  const gridPattern = /\b([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\b/g;
  const grids = [];
  let match;
  while ((match = gridPattern.exec(comment)) !== null) {
    const grid = match[1].toUpperCase();
    if (isValidGrid(grid)) {
      grids.push(grid);
    }
  }
  
  // If we found two grids, assume first is spotter, second is DX
  if (grids.length >= 2) {
    return { spotterGrid: grids[0], dxGrid: grids[1] };
  }
  
  // If we found one grid, assume it's the DX station
  if (grids.length === 1) {
    return { spotterGrid: null, dxGrid: grids[0] };
  }
  
  return { spotterGrid: null, dxGrid: null };
}

// Validate a grid square is realistic (not "CQ00", "DE12", etc)
function isValidGrid(grid) {
  if (!grid || grid.length < 4) return false;
  const firstChar = grid.charCodeAt(0);
  const secondChar = grid.charCodeAt(1);
  // First char should be A-R, second char should be A-R
  return firstChar >= 65 && firstChar <= 82 && secondChar >= 65 && secondChar <= 82;
}

// Legacy single-grid extraction (kept for compatibility)
function extractGridFromComment(comment) {
  const grids = extractGridsFromComment(comment);
  return grids.dxGrid;
}

// Estimate location from callsign prefix using grid squares
// This gives much better precision than country centers
function estimateLocationFromPrefix(callsign) {
  if (!callsign) return null;
  
  // Comprehensive prefix to grid mapping
  // Uses typical/central grid for each prefix area
  const prefixGrids = {
    // USA - by call district
    'W1': 'FN41', 'K1': 'FN41', 'N1': 'FN41', 'AA1': 'FN41', // New England
    'W2': 'FN20', 'K2': 'FN20', 'N2': 'FN20', 'AA2': 'FN20', // NY/NJ
    'W3': 'FM19', 'K3': 'FM19', 'N3': 'FM19', 'AA3': 'FM19', // PA/MD/DE
    'W4': 'EM73', 'K4': 'EM73', 'N4': 'EM73', 'AA4': 'EM73', // SE USA
    'W5': 'EM12', 'K5': 'EM12', 'N5': 'EM12', 'AA5': 'EM12', // TX/OK/LA/AR/MS
    'W6': 'CM97', 'K6': 'CM97', 'N6': 'CM97', 'AA6': 'CM97', // California
    'W7': 'DN31', 'K7': 'DN31', 'N7': 'DN31', 'AA7': 'DN31', // Pacific NW/Mountain
    'W8': 'EN81', 'K8': 'EN81', 'N8': 'EN81', 'AA8': 'EN81', // MI/OH/WV
    'W9': 'EN52', 'K9': 'EN52', 'N9': 'EN52', 'AA9': 'EN52', // IL/IN/WI
    'W0': 'EN31', 'K0': 'EN31', 'N0': 'EN31', 'AA0': 'EN31', // Central USA
    // Generic USA (no district) - AA through AL are all US prefixes
    'W': 'EM79', 'K': 'EM79', 'N': 'EM79', 
    'AA': 'EM79', 'AB': 'EM79', 'AC': 'EM79', 'AD': 'EM79', 'AE': 'EM79', 'AF': 'EM79',
    'AG': 'EM79', 'AH': 'EM79', 'AI': 'EM79', 'AJ': 'EM79', 'AK': 'EM79', 'AL': 'EM79',
    // US A-prefixes by call district
    'AE0': 'EN31', 'AE1': 'FN41', 'AE2': 'FN20', 'AE3': 'FM19', 'AE4': 'EM73', 
    'AE5': 'EM12', 'AE6': 'CM97', 'AE7': 'DN31', 'AE8': 'EN81', 'AE9': 'EN52',
    'AC0': 'EN31', 'AC1': 'FN41', 'AC2': 'FN20', 'AC3': 'FM19', 'AC4': 'EM73',
    'AC5': 'EM12', 'AC6': 'CM97', 'AC7': 'DN31', 'AC8': 'EN81', 'AC9': 'EN52',
    'AD0': 'EN31', 'AD1': 'FN41', 'AD2': 'FN20', 'AD3': 'FM19', 'AD4': 'EM73',
    'AD5': 'EM12', 'AD6': 'CM97', 'AD7': 'DN31', 'AD8': 'EN81', 'AD9': 'EN52',
    'AF0': 'EN31', 'AF1': 'FN41', 'AF2': 'FN20', 'AF3': 'FM19', 'AF4': 'EM73',
    'AF5': 'EM12', 'AF6': 'CM97', 'AF7': 'DN31', 'AF8': 'EN81', 'AF9': 'EN52',
    'AG0': 'EN31', 'AG1': 'FN41', 'AG2': 'FN20', 'AG3': 'FM19', 'AG4': 'EM73',
    'AG5': 'EM12', 'AG6': 'CM97', 'AG7': 'DN31', 'AG8': 'EN81', 'AG9': 'EN52',
    'AI0': 'EN31', 'AI1': 'FN41', 'AI2': 'FN20', 'AI3': 'FM19', 'AI4': 'EM73',
    'AI5': 'EM12', 'AI6': 'CM97', 'AI7': 'DN31', 'AI8': 'EN81', 'AI9': 'EN52',
    'AJ0': 'EN31', 'AJ1': 'FN41', 'AJ2': 'FN20', 'AJ3': 'FM19', 'AJ4': 'EM73',
    'AJ5': 'EM12', 'AJ6': 'CM97', 'AJ7': 'DN31', 'AJ8': 'EN81', 'AJ9': 'EN52',
    'AK0': 'EN31', 'AK1': 'FN41', 'AK2': 'FN20', 'AK3': 'FM19', 'AK4': 'EM73',
    'AK5': 'EM12', 'AK6': 'CM97', 'AK7': 'DN31', 'AK8': 'EN81', 'AK9': 'EN52',
    'AL0': 'EN31', 'AL1': 'FN41', 'AL2': 'FN20', 'AL3': 'FM19', 'AL4': 'EM73',
    'AL5': 'EM12', 'AL6': 'CM97', 'AL7': 'BP51', 'AL8': 'EN81', 'AL9': 'EN52', // AL7 = Alaska
    
    // Canada - by province
    'VE1': 'FN74', 'VA1': 'FN74', // Maritime
    'VE2': 'FN35', 'VA2': 'FN35', // Quebec
    'VE3': 'FN03', 'VA3': 'FN03', // Ontario
    'VE4': 'EN19', 'VA4': 'EN19', // Manitoba
    'VE5': 'DO51', 'VA5': 'DO51', // Saskatchewan
    'VE6': 'DO33', 'VA6': 'DO33', // Alberta
    'VE7': 'CN89', 'VA7': 'CN89', // British Columbia
    'VE8': 'DP31', 'VA8': 'DP31', // NWT
    'VE9': 'FN65', 'VA9': 'FN65', // New Brunswick
    'VY1': 'CP28', // Yukon
    'VY2': 'FN86', // PEI
    'VO1': 'GN37', 'VO2': 'GO17', // Newfoundland/Labrador
    'VE': 'FN03', 'VA': 'FN03', // Generic Canada
    
    // UK & Ireland
    'G': 'IO91', 'M': 'IO91', '2E': 'IO91', 'GW': 'IO81', // England/Wales
    'GM': 'IO85', 'MM': 'IO85', '2M': 'IO85', // Scotland
    'GI': 'IO64', 'MI': 'IO64', '2I': 'IO64', // N. Ireland
    'EI': 'IO63', 'EJ': 'IO63', // Ireland
    
    // Germany
    'DL': 'JO51', 'DJ': 'JO51', 'DK': 'JO51', 'DA': 'JO51', 'DB': 'JO51', 'DC': 'JO51', 'DD': 'JO51', 'DF': 'JO51', 'DG': 'JO51', 'DH': 'JO51', 'DO': 'JO51',
    
    // Rest of Europe
    'F': 'JN18', // France
    'I': 'JN61', 'IK': 'JN45', 'IZ': 'JN61', // Italy
    'EA': 'IN80', 'EC': 'IN80', 'EB': 'IN80', // Spain
    'CT': 'IM58', // Portugal
    'PA': 'JO21', 'PD': 'JO21', 'PE': 'JO21', 'PH': 'JO21', // Netherlands
    'ON': 'JO20', 'OO': 'JO20', 'OR': 'JO20', 'OT': 'JO20', // Belgium
    'HB': 'JN47', 'HB9': 'JN47', // Switzerland
    'OE': 'JN78', // Austria
    'OZ': 'JO55', 'OU': 'JO55', // Denmark
    'SM': 'JO89', 'SA': 'JO89', 'SB': 'JO89', 'SE': 'JO89', // Sweden
    'LA': 'JO59', 'LB': 'JO59', // Norway
    'OH': 'KP20', 'OF': 'KP20', 'OG': 'KP20', 'OI': 'KP20', // Finland
    'SP': 'JO91', 'SQ': 'JO91', 'SO': 'JO91', '3Z': 'JO91', // Poland
    'OK': 'JN79', 'OL': 'JN79', // Czech Republic
    'OM': 'JN88', // Slovakia
    'HA': 'JN97', 'HG': 'JN97', // Hungary
    'YO': 'KN34', // Romania
    'LZ': 'KN22', // Bulgaria
    'YU': 'KN04', // Serbia
    '9A': 'JN75', // Croatia
    'S5': 'JN76', // Slovenia
    'SV': 'KM17', 'SX': 'KM17', // Greece
    '9H': 'JM75', // Malta
    'LY': 'KO24', // Lithuania
    'ES': 'KO29', // Estonia
    'YL': 'KO26', // Latvia
    
    // Russia & Ukraine
    'UA': 'KO85', 'RA': 'KO85', 'RU': 'KO85', 'RV': 'KO85', 'RW': 'KO85', 'RX': 'KO85', 'RZ': 'KO85',
    'UA0': 'OO33', 'RA0': 'OO33', 'R0': 'OO33', // Asiatic Russia
    'UA9': 'MO06', 'RA9': 'MO06', 'R9': 'MO06', // Ural
    'UR': 'KO50', 'UT': 'KO50', 'UX': 'KO50', 'US': 'KO50', // Ukraine
    
    // Japan - by call area
    'JA1': 'PM95', 'JH1': 'PM95', 'JR1': 'PM95', 'JE1': 'PM95', 'JF1': 'PM95', 'JG1': 'PM95', 'JI1': 'PM95', 'JJ1': 'PM95', 'JK1': 'PM95', 'JL1': 'PM95', 'JM1': 'PM95', 'JN1': 'PM95', 'JO1': 'PM95', 'JP1': 'PM95', 'JQ1': 'PM95', 'JS1': 'PM95', '7K1': 'PM95', '7L1': 'PM95', '7M1': 'PM95', '7N1': 'PM95',
    'JA2': 'PM84', 'JA3': 'PM74', 'JA4': 'PM64', 'JA5': 'PM63', 'JA6': 'PM53', 'JA7': 'QM07', 'JA8': 'QN02', 'JA9': 'PM86', 'JA0': 'PM97',
    'JA': 'PM95', 'JH': 'PM95', 'JR': 'PM95', 'JE': 'PM95', 'JF': 'PM95', 'JG': 'PM95', // Generic Japan
    
    // Rest of Asia
    'HL': 'PM37', 'DS': 'PM37', '6K': 'PM37', '6L': 'PM37', // South Korea
    'BV': 'PL04', 'BW': 'PL04', 'BX': 'PL04', // Taiwan
    'BY': 'OM92', 'BT': 'OM92', 'BA': 'OM92', 'BD': 'OM92', 'BG': 'OM92', // China
    'VU': 'MK82', 'VU2': 'MK82', 'VU3': 'MK82', // India
    'HS': 'OK03', 'E2': 'OK03', // Thailand
    '9V': 'OJ11', // Singapore
    '9M': 'OJ05', '9W': 'OJ05', // Malaysia
    'DU': 'PK04', 'DV': 'PK04', 'DW': 'PK04', 'DX': 'PK04', 'DY': 'PK04', 'DZ': 'PK04', '4D': 'PK04', '4E': 'PK04', '4F': 'PK04', '4G': 'PK04', '4H': 'PK04', '4I': 'PK04', // Philippines
    'YB': 'OI33', 'YC': 'OI33', 'YD': 'OI33', 'YE': 'OI33', 'YF': 'OI33', 'YG': 'OI33', 'YH': 'OI33', // Indonesia
    
    // Oceania
    'VK': 'QF56', 'VK1': 'QF44', 'VK2': 'QF56', 'VK3': 'QF22', 'VK4': 'QG62', 'VK5': 'PF95', 'VK6': 'OF86', 'VK7': 'QE38', // Australia
    'ZL': 'RF70', 'ZL1': 'RF72', 'ZL2': 'RF70', 'ZL3': 'RE66', 'ZL4': 'RE54', // New Zealand
    'KH6': 'BL01', // Hawaii
    'KH2': 'QK24', // Guam
    'FK': 'RG37', // New Caledonia
    
    // South America
    'LU': 'GF05', 'LW': 'GF05', 'LO': 'GF05', 'L2': 'GF05', 'L3': 'GF05', 'L4': 'GF05', 'L5': 'GF05', 'L6': 'GF05', 'L7': 'GF05', 'L8': 'GF05', 'L9': 'GF05', // Argentina
    'PY': 'GG87', 'PP': 'GG87', 'PQ': 'GG87', 'PR': 'GG87', 'PS': 'GG87', 'PT': 'GG87', 'PU': 'GG87', 'PV': 'GG87', 'PW': 'GG87', 'PX': 'GG87', // Brazil
    'CE': 'FF46', 'CA': 'FF46', 'CB': 'FF46', 'CC': 'FF46', 'CD': 'FF46', 'XQ': 'FF46', 'XR': 'FF46', '3G': 'FF46', // Chile
    'CX': 'GF15', // Uruguay
    'HC': 'FI09', 'HD': 'FI09', // Ecuador
    'OA': 'FH17', 'OB': 'FH17', 'OC': 'FH17', // Peru
    'HK': 'FJ35', 'HJ': 'FJ35', '5J': 'FJ35', '5K': 'FJ35', // Colombia
    'YV': 'FK60', 'YW': 'FK60', 'YX': 'FK60', 'YY': 'FK60', // Venezuela
    
    // Caribbean
    'KP4': 'FK68', 'NP4': 'FK68', 'WP4': 'FK68', // Puerto Rico
    'VP5': 'FL31', // Turks & Caicos
    'HI': 'FK49', // Dominican Republic
    'CO': 'FL10', 'CM': 'FL10', // Cuba
    'FG': 'FK96', // Guadeloupe
    'FM': 'FK94', // Martinique
    'PJ': 'FK52', // Netherlands Antilles
    
    // Africa
    'ZS': 'KG33', 'ZR': 'KG33', 'ZT': 'KG33', 'ZU': 'KG33', // South Africa
    '5N': 'JJ55', // Nigeria
    'CN': 'IM63', // Morocco
    '7X': 'JM16', // Algeria
    'SU': 'KL30', // Egypt
    '5Z': 'KI88', // Kenya
    'ET': 'KJ49', // Ethiopia
    'EA8': 'IL18', 'EA9': 'IM75', // Canary Islands, Ceuta
    
    // Middle East
    'A4': 'LL93', 'A41': 'LL93', 'A45': 'LL93', // Oman
    'A6': 'LL65', 'A61': 'LL65', // UAE
    'A7': 'LL45', 'A71': 'LL45', // Qatar
    'HZ': 'LL24', // Saudi Arabia
    '4X': 'KM72', '4Z': 'KM72', // Israel
    'OD': 'KM73', // Lebanon
    
    // Other
    'VP8': 'GD18', // Falkland Islands
    'CE9': 'FC56', 'DP0': 'IB59', 'KC4': 'FC56', // Antarctica
    'SV5': 'KM46', 'SV9': 'KM25', // Dodecanese, Crete
  };
  
  const upper = callsign.toUpperCase();
  
  // Smart US callsign detection - US prefixes follow specific patterns
  // K, N, W + anything = USA
  // A[A-L] + digit = USA (e.g., AA0, AE5, AL7)
  const usCallPattern = /^([KNW][0-9]?|A[A-L][0-9])/;
  const usMatch = upper.match(usCallPattern);
  if (usMatch) {
    // Extract call district (the digit) for more precise location
    const districtMatch = upper.match(/^[KNWA][A-L]?([0-9])/);
    const district = districtMatch ? districtMatch[1] : null;
    
    const usDistrictGrids = {
      '0': 'EN31', // Central (CO, IA, KS, MN, MO, NE, ND, SD)
      '1': 'FN41', // New England (CT, MA, ME, NH, RI, VT)
      '2': 'FN20', // NY, NJ
      '3': 'FM19', // PA, MD, DE
      '4': 'EM73', // Southeast (AL, FL, GA, KY, NC, SC, TN, VA)
      '5': 'EM12', // TX, OK, LA, AR, MS, NM
      '6': 'CM97', // California
      '7': 'DN31', // Pacific NW/Mountain (AZ, ID, MT, NV, OR, UT, WA, WY)
      '8': 'EN81', // MI, OH, WV
      '9': 'EN52', // IL, IN, WI
    };
    
    const grid = district && usDistrictGrids[district] ? usDistrictGrids[district] : 'EM79';
    const gridLoc = maidenheadToLatLon(grid);
    if (gridLoc) {
      return {
        callsign,
        lat: gridLoc.lat,
        lon: gridLoc.lon,
        grid: grid,
        country: 'USA',
        estimated: true,
        source: 'prefix-grid'
      };
    }
  }
  
  // Try longest prefix match first (up to 4 chars) for non-US calls
  for (let len = 4; len >= 1; len--) {
    const prefix = upper.substring(0, len);
    if (prefixGrids[prefix]) {
      const gridLoc = maidenheadToLatLon(prefixGrids[prefix]);
      if (gridLoc) {
        return { 
          callsign, 
          lat: gridLoc.lat, 
          lon: gridLoc.lon, 
          grid: prefixGrids[prefix],
          country: getCountryFromPrefix(prefix),
          estimated: true,
          source: 'prefix-grid'
        };
      }
    }
  }
  
  // Fallback to first character (most likely country for each letter)
  const firstCharGrids = {
    'A': 'EM79', 'B': 'PL02', 'C': 'FN03', 'D': 'JO51', 'E': 'IO63', // A=USA (AA-AL), B=China, C=Canada, D=Germany, E=Spain/Ireland
    'F': 'JN18', 'G': 'IO91', 'H': 'KM72', 'I': 'JN61', 'J': 'PM95', // F=France, G=UK, H=varies, I=Italy, J=Japan
    'K': 'EM79', 'L': 'GF05', 'M': 'IO91', 'N': 'EM79', 'O': 'KP20', // K=USA, L=Argentina, M=UK, N=USA, O=Finland
    'P': 'GG87', 'R': 'KO85', 'S': 'JO89', 'T': 'KI88', 'U': 'KO85', // P=Brazil, R=Russia, S=Sweden, T=varies, U=Russia
    'V': 'QF56', 'W': 'EM79', 'X': 'EK09', 'Y': 'JO91', 'Z': 'KG33'  // V=Australia, W=USA, X=Mexico, Y=varies, Z=South Africa
  };
  
  const firstChar = upper[0];
  if (firstCharGrids[firstChar]) {
    const gridLoc = maidenheadToLatLon(firstCharGrids[firstChar]);
    if (gridLoc) {
      return {
        callsign,
        lat: gridLoc.lat,
        lon: gridLoc.lon,
        grid: firstCharGrids[firstChar],
        country: 'Unknown',
        estimated: true,
        source: 'prefix-grid'
      };
    }
  }
  
  return null;
}

// Helper to get country name from prefix
function getCountryFromPrefix(prefix) {
  const prefixCountries = {
    'W': 'USA', 'K': 'USA', 'N': 'USA', 'AA': 'USA',
    'VE': 'Canada', 'VA': 'Canada', 'VY': 'Canada', 'VO': 'Canada',
    'G': 'England', 'M': 'England', '2E': 'England', 'GM': 'Scotland', 'GW': 'Wales', 'GI': 'N. Ireland',
    'EI': 'Ireland', 'F': 'France', 'DL': 'Germany', 'I': 'Italy', 'EA': 'Spain', 'CT': 'Portugal',
    'PA': 'Netherlands', 'ON': 'Belgium', 'HB': 'Switzerland', 'OE': 'Austria',
    'OZ': 'Denmark', 'SM': 'Sweden', 'LA': 'Norway', 'OH': 'Finland',
    'SP': 'Poland', 'OK': 'Czech Rep', 'HA': 'Hungary', 'YO': 'Romania', 'LZ': 'Bulgaria',
    'UA': 'Russia', 'UR': 'Ukraine',
    'JA': 'Japan', 'HL': 'S. Korea', 'BV': 'Taiwan', 'BY': 'China', 'VU': 'India', 'HS': 'Thailand',
    'VK': 'Australia', 'ZL': 'New Zealand', 'KH6': 'Hawaii',
    'LU': 'Argentina', 'PY': 'Brazil', 'CE': 'Chile', 'HK': 'Colombia', 'YV': 'Venezuela',
    'ZS': 'South Africa', 'CN': 'Morocco', 'SU': 'Egypt'
  };
  
  for (let len = 3; len >= 1; len--) {
    const p = prefix.substring(0, len);
    if (prefixCountries[p]) return prefixCountries[p];
  }
  return 'Unknown';
}

// ============================================
// MY SPOTS API - Get spots involving a specific callsign
// ============================================

app.get('/api/myspots/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  logDebug('[My Spots] Searching for callsign:', callsign);
  
  const mySpots = [];
  
  try {
    // Try HamQTH for spots involving this callsign
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(
      `https://www.hamqth.com/dxc_csv.php?limit=100`,
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('^');
        if (parts.length < 3) continue;
        
        const spotter = parts[0]?.trim().toUpperCase();
        const dxCall = parts[2]?.trim().toUpperCase();
        const freq = parts[1]?.trim();
        const comment = parts[3]?.trim() || '';
        const timeStr = parts[4]?.trim() || '';
        
        // Check if our callsign is involved (as spotter or spotted)
        if (spotter === callsign || dxCall === callsign || 
            spotter.includes(callsign) || dxCall.includes(callsign)) {
          mySpots.push({
            spotter,
            dxCall,
            freq: freq ? (parseFloat(freq) / 1000).toFixed(3) : '0.000',
            comment,
            time: timeStr ? timeStr.substring(0, 5) + 'z' : '',
            isMySpot: spotter.includes(callsign),
            isSpottedMe: dxCall.includes(callsign)
          });
        }
      }
    }
    
    logDebug('[My Spots] Found', mySpots.length, 'spots involving', callsign);
    
    // Now try to get locations for each unique callsign
    const uniqueCalls = [...new Set(mySpots.map(s => s.isMySpot ? s.dxCall : s.spotter))];
    const locations = {};
    
    for (const call of uniqueCalls.slice(0, 10)) { // Limit to 10 lookups
      try {
        const loc = estimateLocationFromPrefix(call);
        if (loc) {
          locations[call] = { lat: loc.lat, lon: loc.lon, country: loc.country };
        }
      } catch (e) {
        // Ignore lookup errors
      }
    }
    
    // Add locations to spots
    const spotsWithLocations = mySpots.map(spot => {
      const targetCall = spot.isMySpot ? spot.dxCall : spot.spotter;
      const loc = locations[targetCall];
      return {
        ...spot,
        targetCall,
        lat: loc?.lat,
        lon: loc?.lon,
        country: loc?.country
      };
    }).filter(s => s.lat && s.lon); // Only return spots with valid locations
    
    res.json(spotsWithLocations);
  } catch (error) {
    logErrorOnce('My Spots', error.message);
    res.json([]);
  }
});

// ============================================
// PSKREPORTER API (MQTT-based for real-time)
// ============================================

// PSKReporter MQTT feed at mqtt.pskreporter.info provides real-time spots
// WebSocket endpoints: 1885 (ws), 1886 (wss)
// Topic format: pskr/filter/v2/{band}/{mode}/{sendercall}/{receivercall}/{senderlocator}/{receiverlocator}/{sendercountry}/{receivercountry}

// Cache for PSKReporter data - stores recent spots from MQTT
const pskReporterSpots = {
  tx: new Map(), // Map of callsign -> spots where they're being heard
  rx: new Map(), // Map of callsign -> spots they're receiving
  maxAge: 60 * 60 * 1000 // Keep spots for 1 hour max
};

// Clean up old spots periodically
setInterval(() => {
  const cutoff = Date.now() - pskReporterSpots.maxAge;
  for (const [call, spots] of pskReporterSpots.tx) {
    const filtered = spots.filter(s => s.timestamp > cutoff);
    if (filtered.length === 0) {
      pskReporterSpots.tx.delete(call);
    } else {
      pskReporterSpots.tx.set(call, filtered);
    }
  }
  for (const [call, spots] of pskReporterSpots.rx) {
    const filtered = spots.filter(s => s.timestamp > cutoff);
    if (filtered.length === 0) {
      pskReporterSpots.rx.delete(call);
    } else {
      pskReporterSpots.rx.set(call, filtered);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// Convert grid square to lat/lon
function gridToLatLonSimple(grid) {
  if (!grid || grid.length < 4) return null;
  
  const g = grid.toUpperCase();
  const lon = (g.charCodeAt(0) - 65) * 20 - 180;
  const lat = (g.charCodeAt(1) - 65) * 10 - 90;
  const lonMin = parseInt(g[2]) * 2;
  const latMin = parseInt(g[3]) * 1;
  
  let finalLon = lon + lonMin + 1;
  let finalLat = lat + latMin + 0.5;
  
  // If 6-character grid, add more precision
  if (grid.length >= 6) {
    const lonSec = (g.charCodeAt(4) - 65) * (2/24);
    const latSec = (g.charCodeAt(5) - 65) * (1/24);
    finalLon = lon + lonMin + lonSec + (1/24);
    finalLat = lat + latMin + latSec + (0.5/24);
  }
  
  return { lat: finalLat, lon: finalLon };
}

// Get band name from frequency in Hz
function getBandFromHz(freqHz) {
  const freq = freqHz / 1000000; // Convert to MHz
  if (freq >= 1.8 && freq <= 2) return '160m';
  if (freq >= 3.5 && freq <= 4) return '80m';
  if (freq >= 5.3 && freq <= 5.4) return '60m';
  if (freq >= 7 && freq <= 7.3) return '40m';
  if (freq >= 10.1 && freq <= 10.15) return '30m';
  if (freq >= 14 && freq <= 14.35) return '20m';
  if (freq >= 18.068 && freq <= 18.168) return '17m';
  if (freq >= 21 && freq <= 21.45) return '15m';
  if (freq >= 24.89 && freq <= 24.99) return '12m';
  if (freq >= 28 && freq <= 29.7) return '10m';
  if (freq >= 50 && freq <= 54) return '6m';
  if (freq >= 144 && freq <= 148) return '2m';
  if (freq >= 420 && freq <= 450) return '70cm';
  return 'Unknown';
}

// PSKReporter endpoint - returns MQTT connection info for frontend
// The frontend connects directly to MQTT via WebSocket for real-time updates
app.get('/api/pskreporter/config', (req, res) => {
  res.json({
    mqtt: {
      host: 'mqtt.pskreporter.info',
      wsPort: 1885,      // WebSocket
      wssPort: 1886,     // WebSocket + TLS (recommended)
      topicPrefix: 'pskr/filter/v2'
    },
    // Topic format: pskr/filter/v2/{band}/{mode}/{sendercall}/{receivercall}/{senderlocator}/{receiverlocator}/{sendercountry}/{receivercountry}
    // Use + for single-level wildcard, # for multi-level
    // Example for TX (being heard): pskr/filter/v2/+/+/{CALLSIGN}/#
    // Example for RX (hearing): Subscribe and filter client-side
    info: 'Connect via WebSocket to mqtt.pskreporter.info:1886 (wss) for real-time spots'
  });
});

// Fallback HTTP endpoint for when MQTT isn't available
// Uses the traditional retrieve API with caching
let pskHttpCache = {};
const PSK_HTTP_CACHE_TTL = 10 * 60 * 1000; // 10 minutes - PSKReporter rate limits aggressively
let psk503Backoff = 0; // Timestamp when we can try again after 503

app.get('/api/pskreporter/http/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  const minutes = parseInt(req.query.minutes) || 15;
  const direction = req.query.direction || 'tx'; // tx or rx
  // flowStartSeconds must be NEGATIVE for "last N seconds"
  const flowStartSeconds = -Math.abs(minutes * 60);
  
  const cacheKey = `${direction}:${callsign}:${minutes}`;
  const now = Date.now();
  
  // Check cache first
  if (pskHttpCache[cacheKey] && (now - pskHttpCache[cacheKey].timestamp) < PSK_HTTP_CACHE_TTL) {
    return res.json({ ...pskHttpCache[cacheKey].data, cached: true });
  }
  
  // If we're in 503 backoff period, return cached data or empty result
  if (psk503Backoff > now) {
    if (pskHttpCache[cacheKey]) {
      return res.json({ ...pskHttpCache[cacheKey].data, cached: true, stale: true });
    }
    return res.json({ 
      callsign, 
      direction, 
      count: 0, 
      reports: [],
      backoff: true
    });
  }
  
  try {
    const param = direction === 'tx' ? 'senderCallsign' : 'receiverCallsign';
    // Add appcontact parameter as requested by PSKReporter developer docs
    const url = `https://retrieve.pskreporter.info/query?${param}=${encodeURIComponent(callsign)}&flowStartSeconds=${flowStartSeconds}&rronly=1&appcontact=openhamclock`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'OpenHamClock/3.11 (Amateur Radio Dashboard)',
        'Accept': '*/*'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      // Back off on rate-limit or access errors to avoid hammering
      if (response.status === 503) {
        psk503Backoff = Date.now() + (15 * 60 * 1000);
        logErrorOnce('PSKReporter HTTP', '503 - backing off for 15 minutes');
      } else if (response.status === 403 || response.status === 429) {
        psk503Backoff = Date.now() + (30 * 60 * 1000);
        logErrorOnce('PSKReporter HTTP', `${response.status} - backing off for 30 minutes (server-side HTTP proxy blocked; users unaffected via MQTT)`);
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    const reports = [];
    
    // Parse XML response
    const reportRegex = /<receptionReport[^>]*>/g;
    let match;
    while ((match = reportRegex.exec(xml)) !== null) {
      const report = match[0];
      const getAttr = (name) => {
        const m = report.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : null;
      };
      
      const receiverCallsign = getAttr('receiverCallsign');
      const receiverLocator = getAttr('receiverLocator');
      const senderCallsign = getAttr('senderCallsign');
      const senderLocator = getAttr('senderLocator');
      const frequency = getAttr('frequency');
      const mode = getAttr('mode');
      const flowStartSecs = getAttr('flowStartSeconds');
      const sNR = getAttr('sNR');
      
      if (receiverCallsign && senderCallsign) {
        const locator = direction === 'tx' ? receiverLocator : senderLocator;
        const loc = locator ? gridToLatLonSimple(locator) : null;
        
        reports.push({
          sender: senderCallsign,
          senderGrid: senderLocator,
          receiver: receiverCallsign,
          receiverGrid: receiverLocator,
          freq: frequency ? parseInt(frequency) : null,
          freqMHz: frequency ? (parseInt(frequency) / 1000000).toFixed(3) : null,
          band: frequency ? getBandFromHz(parseInt(frequency)) : 'Unknown',
          mode: mode || 'Unknown',
          timestamp: flowStartSecs ? parseInt(flowStartSecs) * 1000 : Date.now(),
          snr: sNR ? parseInt(sNR) : null,
          lat: loc?.lat,
          lon: loc?.lon,
          age: flowStartSecs ? Math.floor((Date.now() / 1000 - parseInt(flowStartSecs)) / 60) : 0
        });
      }
    }
    
    // Sort by timestamp (newest first)
    reports.sort((a, b) => b.timestamp - a.timestamp);
    
    // Clear backoff on success
    psk503Backoff = 0;
    
    const result = {
      callsign,
      direction,
      count: reports.length,
      reports: reports.slice(0, 100),
      timestamp: new Date().toISOString(),
      source: 'http'
    };
    
    // Cache it
    pskHttpCache[cacheKey] = { data: result, timestamp: now };
    
    logDebug(`[PSKReporter HTTP] Found ${reports.length} ${direction} reports for ${callsign}`);
    res.json(result);
    
  } catch (error) {
    // Don't re-log 403/503 errors - already logged above with backoff info
    if (!error.message?.includes('HTTP 403') && !error.message?.includes('HTTP 503')) {
      logErrorOnce('PSKReporter HTTP', error.message);
    }
    
    // Return cached data if available (without error flag)
    if (pskHttpCache[cacheKey]) {
      return res.json({ ...pskHttpCache[cacheKey].data, cached: true, stale: true });
    }
    
    // Return empty result without error flag for rate limiting
    res.json({ 
      callsign, 
      direction, 
      count: 0, 
      reports: []
    });
  }
});

// Combined endpoint that tries MQTT cache first, falls back to HTTP
app.get('/api/pskreporter/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  const minutes = parseInt(req.query.minutes) || 15;
  
  // For now, redirect to HTTP endpoint since MQTT requires client-side connection
  // The frontend should connect directly to MQTT for real-time updates
  try {
    const [txRes, rxRes] = await Promise.allSettled([
      fetch(`http://localhost:${PORT}/api/pskreporter/http/${callsign}?minutes=${minutes}&direction=tx`),
      fetch(`http://localhost:${PORT}/api/pskreporter/http/${callsign}?minutes=${minutes}&direction=rx`)
    ]);
    
    let txData = { count: 0, reports: [] };
    let rxData = { count: 0, reports: [] };
    
    if (txRes.status === 'fulfilled' && txRes.value.ok) {
      txData = await txRes.value.json();
    }
    if (rxRes.status === 'fulfilled' && rxRes.value.ok) {
      rxData = await rxRes.value.json();
    }
    
    res.json({
      callsign,
      tx: txData,
      rx: rxData,
      timestamp: new Date().toISOString(),
      mqtt: {
        available: true,
        host: 'wss://mqtt.pskreporter.info:1886',
        hint: 'Connect via WebSocket for real-time updates'
      }
    });
    
  } catch (error) {
    logErrorOnce('PSKReporter', error.message);
    res.json({ 
      callsign, 
      tx: { count: 0, reports: [] }, 
      rx: { count: 0, reports: [] }, 
      error: error.message 
    });
  }
});

// ============================================
// REVERSE BEACON NETWORK (RBN) API
// ============================================

// Convert lat/lon to Maidenhead grid (6-character)
function latLonToGrid(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  
  // Adjust longitude to 0-360 range
  let adjLon = lon + 180;
  let adjLat = lat + 90;
  
  // Field (2 chars): 20° lon x 10° lat
  const field1 = String.fromCharCode(65 + Math.floor(adjLon / 20));
  const field2 = String.fromCharCode(65 + Math.floor(adjLat / 10));
  
  // Square (2 digits): 2° lon x 1° lat
  const square1 = Math.floor((adjLon % 20) / 2);
  const square2 = Math.floor((adjLat % 10) / 1);
  
  // Subsquare (2 chars): 5' lon x 2.5' lat
  const subsq1 = String.fromCharCode(65 + Math.floor(((adjLon % 2) * 60) / 5));
  const subsq2 = String.fromCharCode(65 + Math.floor(((adjLat % 1) * 60) / 2.5));
  
  return `${field1}${field2}${square1}${square2}${subsq1}${subsq2}`.toUpperCase();
}

// Persistent RBN connection and spot storage
let rbnConnection = null;
let rbnSpots = []; // Rolling buffer of recent spots
const MAX_RBN_SPOTS = 500; // Keep last 500 spots
const RBN_SPOT_TTL = 30 * 60 * 1000; // 30 minutes
const callsignLocationCache = new Map(); // Permanent cache for skimmer locations

// Helper function to convert frequency to band
function freqToBandKHz(freqKHz) {
  if (freqKHz >= 1800 && freqKHz < 2000) return '160m';
  if (freqKHz >= 3500 && freqKHz < 4000) return '80m';
  if (freqKHz >= 7000 && freqKHz < 7300) return '40m';
  if (freqKHz >= 10100 && freqKHz < 10150) return '30m';
  if (freqKHz >= 14000 && freqKHz < 14350) return '20m';
  if (freqKHz >= 18068 && freqKHz < 18168) return '17m';
  if (freqKHz >= 21000 && freqKHz < 21450) return '15m';
  if (freqKHz >= 24890 && freqKHz < 24990) return '12m';
  if (freqKHz >= 28000 && freqKHz < 29700) return '10m';
  if (freqKHz >= 50000 && freqKHz < 54000) return '6m';
  return 'Other';
}

/**
 * Maintain persistent connection to RBN Telnet
 */
function maintainRBNConnection(port = 7000) {
  if (rbnConnection && !rbnConnection.destroyed) {
    return; // Already connected
  }
  
  console.log(`[RBN] Creating persistent connection to telnet.reversebeacon.net:${port}...`);
  
  let dataBuffer = '';
  let authenticated = false;
  const userCallsign = 'OPENHAMCLOCK'; // Generic callsign for the app
  
  const client = net.createConnection({ 
    host: 'telnet.reversebeacon.net', 
    port: port 
  }, () => {
    console.log(`[RBN] Persistent connection established`);
  });

  client.setEncoding('utf8');
  client.setKeepAlive(true, 60000); // Keep alive every 60s
  
  client.on('data', (data) => {
    dataBuffer += data;
    
    // Check for authentication prompt
    if (!authenticated && dataBuffer.includes('Please enter your call:')) {
      console.log(`[RBN] Authenticating as ${userCallsign}`);
      client.write(`${userCallsign}\r\n`);
      authenticated = true;
      dataBuffer = '';
      return;
    }
    
    const lines = dataBuffer.split('\n');
    dataBuffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      // Start collecting after authentication
      if (authenticated && line.includes('Connected')) {
        console.log(`[RBN] Authenticated, now streaming spots...`);
        continue;
      }
      
      // Parse RBN spot line format:
      // DX de W3LPL-#:     7003.0  K3LR           CW    30 dB  23 WPM  CQ      0123Z
      const spotMatch = line.match(/DX de\s+(\S+)\s*:\s*([\d.]+)\s+(\S+)\s+(\S+)\s+([-\d]+)\s+dB\s+(\d+)\s+WPM/);
      
      if (spotMatch) {
        const [, skimmer, freq, dx, mode, snr, wpm] = spotMatch;
        const timestamp = Date.now();
        const freqNum = parseFloat(freq) * 1000;
        const band = freqToBandKHz(freqNum / 1000);
        
        const spot = {
          callsign: skimmer.replace(/-#.*$/, ''),
          skimmerFull: skimmer,
          dx: dx,
          frequency: freqNum,
          freqMHz: parseFloat(freq),
          band: band,
          mode: mode,
          snr: parseInt(snr),
          wpm: parseInt(wpm),
          timestamp: new Date().toISOString(),
          timestampMs: timestamp,
          age: 0,
          source: 'rbn-telnet',
          grid: null // Will be filled by frontend from cache
        };
        
        // Add to rolling buffer
        rbnSpots.push(spot);
        
        // Keep only recent spots
        if (rbnSpots.length > MAX_RBN_SPOTS) {
          rbnSpots.shift();
        }
        
        // Clean old spots
        const cutoff = timestamp - RBN_SPOT_TTL;
        rbnSpots = rbnSpots.filter(s => s.timestampMs > cutoff);
      }
    }
  });

  client.on('error', (err) => {
    console.error(`[RBN] Connection error: ${err.message}`);
    rbnConnection = null;
    // Reconnect after 5 seconds
    setTimeout(() => maintainRBNConnection(port), 5000);
  });

  client.on('close', () => {
    console.log(`[RBN] Connection closed, reconnecting in 5s...`);
    rbnConnection = null;
    setTimeout(() => maintainRBNConnection(port), 5000);
  });
  
  rbnConnection = client;
}

// Start persistent connection on server startup
maintainRBNConnection(7000);

// Endpoint to get recent RBN spots (no filtering, just return all recent spots)
app.get('/api/rbn/spots', async (req, res) => {
  const minutes = parseInt(req.query.minutes) || 30;
  const limit = parseInt(req.query.limit) || 500;
  
  const now = Date.now();
  const cutoff = now - (minutes * 60 * 1000);
  
  // Filter by time window
  const recentSpots = rbnSpots
    .filter(spot => spot.timestampMs > cutoff)
    .slice(-limit); // Get most recent
  
  // Enrich spots with skimmer location data
  const enrichedSpots = await Promise.all(recentSpots.map(async (spot) => {
    const skimmerCall = spot.callsign;
    
    // Check cache first
    if (callsignLocationCache.has(skimmerCall)) {
      const location = callsignLocationCache.get(skimmerCall);
      return {
        ...spot,
        grid: location.grid,
        skimmerLat: location.lat,
        skimmerLon: location.lon,
        skimmerCountry: location.country
      };
    }
    
    // Lookup location (don't block on failures)
    try {
      const response = await fetch(`http://localhost:${PORT}/api/callsign/${skimmerCall}`);
      if (response.ok) {
        const locationData = await response.json();
        const grid = latLonToGrid(locationData.lat, locationData.lon);
        
        const location = {
          callsign: skimmerCall,
          grid: grid,
          lat: locationData.lat,
          lon: locationData.lon,
          country: locationData.country
        };
        
        // Cache permanently
        callsignLocationCache.set(skimmerCall, location);
        
        return {
          ...spot,
          grid: grid,
          skimmerLat: locationData.lat,
          skimmerLon: locationData.lon,
          skimmerCountry: locationData.country
        };
      }
    } catch (err) {
      // Silent fail - return spot without location
    }
    
    // Return spot as-is if lookup failed
    return spot;
  }));
  
  console.log(`[RBN] Returning ${enrichedSpots.length} enriched spots (last ${minutes} min)`);
  
  res.json({
    count: enrichedSpots.length,
    spots: enrichedSpots,
    minutes: minutes,
    timestamp: new Date().toISOString(),
    source: 'rbn-telnet-stream'
  });
});

// Endpoint to lookup skimmer location (cached permanently)
app.get('/api/rbn/location/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  
  // Check cache first
  if (callsignLocationCache.has(callsign)) {
    return res.json(callsignLocationCache.get(callsign));
  }
  
  try {
    // Look up via HamQTH
    const response = await fetch(`http://localhost:${PORT}/api/callsign/${callsign}`);
    if (response.ok) {
      const locationData = await response.json();
      const grid = latLonToGrid(locationData.lat, locationData.lon);
      
      const result = {
        callsign: callsign,
        grid: grid,
        lat: locationData.lat,
        lon: locationData.lon,
        country: locationData.country
      };
      
      // Cache permanently (skimmers don't move!)
      callsignLocationCache.set(callsign, result);
      
      return res.json(result);
    }
  } catch (err) {
    console.warn(`[RBN] Failed to lookup ${callsign}: ${err.message}`);
  }
  
  res.status(404).json({ error: 'Location not found' });
});

// Legacy endpoint for compatibility (deprecated)
app.get('/api/rbn', async (req, res) => {
  console.log('[RBN] Warning: Using deprecated /api/rbn endpoint, use /api/rbn/spots instead');
  
  const callsign = (req.query.callsign || '').toUpperCase().trim();
  const minutes = parseInt(req.query.minutes) || 30;
  const limit = parseInt(req.query.limit) || 100;
  
  if (!callsign || callsign === 'N0CALL') {
    return res.json([]);
  }
  
  const now = Date.now();
  const cutoff = now - (minutes * 60 * 1000);
  
  // Filter spots for this callsign
  const userSpots = rbnSpots
    .filter(spot => spot.timestampMs > cutoff && spot.dx.toUpperCase() === callsign)
    .slice(-limit);
  
  res.json(userSpots);
});
// ============================================
// WSPR PROPAGATION HEATMAP API
// ============================================

// WSPR heatmap endpoint - gets global propagation data
// Uses PSK Reporter to fetch WSPR mode spots from the last N minutes
let wsprCache = { data: null, timestamp: 0 };
const WSPR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

app.get('/api/wspr/heatmap', async (req, res) => {
  const minutes = parseInt(req.query.minutes) || 30; // Default 30 minutes
  const band = req.query.band || 'all'; // all, 20m, 40m, etc.
  const now = Date.now();
  
  // Return cached data if fresh
  const cacheKey = `${minutes}:${band}`;
  if (wsprCache.data && 
      wsprCache.data.cacheKey === cacheKey && 
      (now - wsprCache.timestamp) < WSPR_CACHE_TTL) {
    return res.json({ ...wsprCache.data.result, cached: true });
  }
  
  try {
    const flowStartSeconds = -Math.abs(minutes * 60);
    // Query PSK Reporter for WSPR mode spots (no specific callsign filter)
    // Get data from multiple popular WSPR frequencies to build heatmap
    const url = `https://retrieve.pskreporter.info/query?mode=WSPR&flowStartSeconds=${flowStartSeconds}&rronly=1&nolocator=0&appcontact=openhamclock&rptlimit=2000`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'OpenHamClock/3.12 (Amateur Radio Dashboard)',
        'Accept': '*/*'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    const spots = [];
    
    // Parse XML response
    const reportRegex = /<receptionReport[^>]*>/g;
    let match;
    while ((match = reportRegex.exec(xml)) !== null) {
      const report = match[0];
      const getAttr = (name) => {
        const m = report.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : null;
      };
      
      const receiverCallsign = getAttr('receiverCallsign');
      const receiverLocator = getAttr('receiverLocator');
      const senderCallsign = getAttr('senderCallsign');
      const senderLocator = getAttr('senderLocator');
      const frequency = getAttr('frequency');
      const mode = getAttr('mode');
      const flowStartSecs = getAttr('flowStartSeconds');
      const sNR = getAttr('sNR');
      
      if (receiverCallsign && senderCallsign && senderLocator && receiverLocator) {
        const freq = frequency ? parseInt(frequency) : null;
        const spotBand = freq ? getBandFromHz(freq) : 'Unknown';
        
        // Filter by band if specified
        if (band !== 'all' && spotBand !== band) continue;
        
        const senderLoc = gridToLatLonSimple(senderLocator);
        const receiverLoc = gridToLatLonSimple(receiverLocator);
        
        if (senderLoc && receiverLoc) {
          spots.push({
            sender: senderCallsign,
            senderGrid: senderLocator,
            senderLat: senderLoc.lat,
            senderLon: senderLoc.lon,
            receiver: receiverCallsign,
            receiverGrid: receiverLocator,
            receiverLat: receiverLoc.lat,
            receiverLon: receiverLoc.lon,
            freq: freq,
            freqMHz: freq ? (freq / 1000000).toFixed(3) : null,
            band: spotBand,
            snr: sNR ? parseInt(sNR) : null,
            timestamp: flowStartSecs ? parseInt(flowStartSecs) * 1000 : Date.now(),
            age: flowStartSecs ? Math.floor((Date.now() / 1000 - parseInt(flowStartSecs)) / 60) : 0
          });
        }
      }
    }
    
    // Sort by timestamp (newest first)
    spots.sort((a, b) => b.timestamp - a.timestamp);
    
    const result = {
      count: spots.length,
      spots: spots,
      minutes: minutes,
      band: band,
      timestamp: new Date().toISOString(),
      source: 'pskreporter'
    };
    
    // Cache it
    wsprCache = { 
      data: { result, cacheKey }, 
      timestamp: now 
    };
    
    console.log(`[WSPR Heatmap] Found ${spots.length} WSPR spots (${minutes}min, band: ${band})`);
    res.json(result);
    
  } catch (error) {
    logErrorOnce('WSPR Heatmap', error.message);
    
    // Return cached data if available
    if (wsprCache.data && wsprCache.data.cacheKey === cacheKey) {
      return res.json({ ...wsprCache.data.result, cached: true, stale: true });
    }
    
    // Return empty result
    res.json({ 
      count: 0, 
      spots: [],
      minutes,
      band,
      error: error.message 
    });
  }
});


// ============================================
// SATELLITE TRACKING API
// ============================================

// Comprehensive ham radio satellites - NORAD IDs
// Updated list of active amateur radio satellites
const HAM_SATELLITES = {
  // High Priority - Popular FM satellites
  'ISS': { norad: 25544, name: 'ISS (ZARYA)', color: '#00ffff', priority: 1, mode: 'FM/APRS/SSTV' },
  'SO-50': { norad: 27607, name: 'SO-50', color: '#00ff00', priority: 1, mode: 'FM' },
  'AO-91': { norad: 43017, name: 'AO-91 (Fox-1B)', color: '#ff6600', priority: 1, mode: 'FM' },
  'AO-92': { norad: 43137, name: 'AO-92 (Fox-1D)', color: '#ff9900', priority: 1, mode: 'FM/L-band' },
  'PO-101': { norad: 43678, name: 'PO-101 (Diwata-2)', color: '#ff3399', priority: 1, mode: 'FM' },
  
  // Linear Transponder Satellites
  'RS-44': { norad: 44909, name: 'RS-44 (DOSAAF)', color: '#ff0066', priority: 1, mode: 'Linear' },
  'AO-7': { norad: 7530, name: 'AO-7', color: '#ffcc00', priority: 2, mode: 'Linear (daylight)' },
  'FO-29': { norad: 24278, name: 'FO-29 (JAS-2)', color: '#ff6699', priority: 2, mode: 'Linear' },
  'FO-99': { norad: 43937, name: 'FO-99 (NEXUS)', color: '#ff99cc', priority: 2, mode: 'Linear' },
  'JO-97': { norad: 43803, name: 'JO-97 (JY1Sat)', color: '#cc99ff', priority: 2, mode: 'Linear/FM' },
  'XW-2A': { norad: 40903, name: 'XW-2A (CAS-3A)', color: '#66ff99', priority: 2, mode: 'Linear' },
  'XW-2B': { norad: 40911, name: 'XW-2B (CAS-3B)', color: '#66ffcc', priority: 2, mode: 'Linear' },
  'XW-2C': { norad: 40906, name: 'XW-2C (CAS-3C)', color: '#99ffcc', priority: 2, mode: 'Linear' },
  'XW-2D': { norad: 40907, name: 'XW-2D (CAS-3D)', color: '#99ff99', priority: 2, mode: 'Linear' },
  'XW-2E': { norad: 40909, name: 'XW-2E (CAS-3E)', color: '#ccff99', priority: 2, mode: 'Linear' },
  'XW-2F': { norad: 40910, name: 'XW-2F (CAS-3F)', color: '#ccffcc', priority: 2, mode: 'Linear' },
  
  // CAS (Chinese Amateur Satellites)
  'CAS-4A': { norad: 42761, name: 'CAS-4A', color: '#9966ff', priority: 2, mode: 'Linear' },
  'CAS-4B': { norad: 42759, name: 'CAS-4B', color: '#9933ff', priority: 2, mode: 'Linear' },
  'CAS-6': { norad: 44881, name: 'CAS-6 (TO-108)', color: '#cc66ff', priority: 2, mode: 'Linear' },
  
  // GreenCube / IO satellites
  'IO-117': { norad: 53106, name: 'IO-117 (GreenCube)', color: '#00ff99', priority: 2, mode: 'Digipeater' },
  
  // TEVEL constellation
  'TEVEL-1': { norad: 50988, name: 'TEVEL-1', color: '#66ccff', priority: 3, mode: 'FM' },
  'TEVEL-2': { norad: 50989, name: 'TEVEL-2', color: '#66ddff', priority: 3, mode: 'FM' },
  'TEVEL-3': { norad: 50994, name: 'TEVEL-3', color: '#66eeff', priority: 3, mode: 'FM' },
  'TEVEL-4': { norad: 50998, name: 'TEVEL-4', color: '#77ccff', priority: 3, mode: 'FM' },
  'TEVEL-5': { norad: 51062, name: 'TEVEL-5', color: '#77ddff', priority: 3, mode: 'FM' },
  'TEVEL-6': { norad: 51063, name: 'TEVEL-6', color: '#77eeff', priority: 3, mode: 'FM' },
  'TEVEL-7': { norad: 51069, name: 'TEVEL-7', color: '#88ccff', priority: 3, mode: 'FM' },
  'TEVEL-8': { norad: 51084, name: 'TEVEL-8', color: '#88ddff', priority: 3, mode: 'FM' },
  
  // OSCAR satellites
  'AO-27': { norad: 22825, name: 'AO-27', color: '#ff9966', priority: 3, mode: 'FM' },
  'AO-73': { norad: 39444, name: 'AO-73 (FUNcube-1)', color: '#ffcc66', priority: 3, mode: 'Linear/Telemetry' },
  'EO-88': { norad: 42017, name: 'EO-88 (Nayif-1)', color: '#ffaa66', priority: 3, mode: 'Linear/Telemetry' },
  
  // Russian satellites
  'RS-15': { norad: 23439, name: 'RS-15', color: '#ff6666', priority: 3, mode: 'Linear' },
  
  // QO-100 (Geostationary - special)
  'QO-100': { norad: 43700, name: 'QO-100 (Es\'hail-2)', color: '#ffff00', priority: 1, mode: 'Linear (GEO)' },
  
  // APRS Digipeaters
  'ARISS': { norad: 25544, name: 'ARISS (ISS)', color: '#00ffff', priority: 1, mode: 'APRS' },
  
  // Cubesats with amateur payloads
  'UVSQ-SAT': { norad: 47438, name: 'UVSQ-SAT', color: '#ff66ff', priority: 4, mode: 'Telemetry' },
  'MEZNSAT': { norad: 46489, name: 'MeznSat', color: '#66ff66', priority: 4, mode: 'Telemetry' },
  
  // SSTV/Slow Scan
  'SSTV-ISS': { norad: 25544, name: 'ISS SSTV', color: '#00ffff', priority: 2, mode: 'SSTV' }
};

// Cache for TLE data (refresh every 6 hours)
let tleCache = { data: null, timestamp: 0 };
const TLE_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/satellites/tle', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if fresh
    if (tleCache.data && (now - tleCache.timestamp) < TLE_CACHE_DURATION) {
      return res.json(tleCache.data);
    }
    
    logDebug('[Satellites] Fetching fresh TLE data...');
    
    // Fetch fresh TLE data from CelesTrak
    const tleData = {};
    
    // Fetch amateur radio satellites TLE
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle',
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      // Parse TLE data (3 lines per satellite: name, line1, line2)
      for (let i = 0; i < lines.length - 2; i += 3) {
        const name = lines[i].trim();
        const line1 = lines[i + 1]?.trim();
        const line2 = lines[i + 2]?.trim();
        
        if (line1 && line2 && line1.startsWith('1 ') && line2.startsWith('2 ')) {
          // Extract NORAD ID from line 1
          const noradId = parseInt(line1.substring(2, 7));
          
          // Check if this is a satellite we care about
          for (const [key, sat] of Object.entries(HAM_SATELLITES)) {
            if (sat.norad === noradId) {
              tleData[key] = {
                ...sat,
                tle1: line1,
                tle2: line2
              };
            }
          }
        }
      }
    }
    
    // Also try to get ISS specifically (it's in the stations group)
    if (!tleData['ISS']) {
      try {
        const issController = new AbortController();
        const issTimeout = setTimeout(() => issController.abort(), 10000);
        
        const issResponse = await fetch(
          'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle',
          { 
            headers: { 'User-Agent': 'OpenHamClock/3.3' },
            signal: issController.signal
          }
        );
        clearTimeout(issTimeout);
        
        if (issResponse.ok) {
          const issText = await issResponse.text();
          const issLines = issText.trim().split('\n');
          if (issLines.length >= 3) {
            tleData['ISS'] = {
              ...HAM_SATELLITES['ISS'],
              tle1: issLines[1].trim(),
              tle2: issLines[2].trim()
            };
            logDebug('[Satellites] Found ISS TLE');
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          logErrorOnce('Satellites', `ISS TLE fetch: ${e.message}`);
        }
      }
    }
    
    // Cache the result
    tleCache = { data: tleData, timestamp: now };
    
    logDebug('[Satellites] Loaded TLE for', Object.keys(tleData).length, 'satellites');
    res.json(tleData);
    
  } catch (error) {
    // Don't spam logs for timeouts (AbortError) or network issues
    if (error.name !== 'AbortError') {
      logErrorOnce('Satellites', `TLE fetch error: ${error.message}`);
    }
    // Return cached data even if stale, or empty object
    res.json(tleCache.data || {});
  }
});

// ============================================
// IONOSONDE DATA API (Real-time ionospheric data from KC2G/GIRO)
// ============================================

// Cache for ionosonde data (refresh every 10 minutes)
let ionosondeCache = {
  data: null,
  timestamp: 0,
  maxAge: 10 * 60 * 1000 // 10 minutes
};

// Fetch real-time ionosonde data from KC2G (GIRO network)
async function fetchIonosondeData() {
  const now = Date.now();
  
  // Return cached data if fresh
  if (ionosondeCache.data && (now - ionosondeCache.timestamp) < ionosondeCache.maxAge) {
    return ionosondeCache.data;
  }
  
  try {
    const response = await fetch('https://prop.kc2g.com/api/stations.json', {
      headers: { 'User-Agent': 'OpenHamClock/3.5' },
      timeout: 15000
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    
    // Filter to only recent data (within last 2 hours) with valid readings
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const validStations = data.filter(s => {
      if (!s.fof2 || !s.station) return false;
      const stationTime = new Date(s.time);
      return stationTime > twoHoursAgo && s.cs > 0; // confidence score > 0
    }).map(s => ({
      code: s.station.code,
      name: s.station.name,
      lat: parseFloat(s.station.latitude),
      lon: parseFloat(s.station.longitude) > 180 ? parseFloat(s.station.longitude) - 360 : parseFloat(s.station.longitude),
      foF2: s.fof2,
      mufd: s.mufd, // MUF at 3000km
      hmF2: s.hmf2, // Height of F2 layer
      md: parseFloat(s.md) || 3.0, // M(3000)F2 factor
      confidence: s.cs,
      time: s.time
    }));
    
    ionosondeCache = {
      data: validStations,
      timestamp: now
    };
    
    logDebug(`[Ionosonde] Fetched ${validStations.length} valid stations from KC2G`);
    return validStations;
    
  } catch (error) {
    logErrorOnce('Ionosonde', `Fetch error: ${error.message}`);
    return ionosondeCache.data || [];
  }
}

// API endpoint to get ionosonde data
app.get('/api/ionosonde', async (req, res) => {
  try {
    const stations = await fetchIonosondeData();
    res.json({
      count: stations.length,
      timestamp: new Date().toISOString(),
      stations: stations
    });
  } catch (error) {
    logErrorOnce('Ionosonde', `API: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch ionosonde data' });
  }
});

// Calculate distance between two points in km
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Interpolate foF2 at a given location using inverse distance weighting
function interpolateFoF2(lat, lon, stations) {
  if (!stations || stations.length === 0) return null;
  
  // Maximum distance (km) to consider ionosonde data valid
  // Beyond this, the data is too far away to be representative
  const MAX_VALID_DISTANCE = 3000; // km
  
  // Calculate distances to all stations
  const stationsWithDist = stations.map(s => ({
    ...s,
    distance: haversineDistance(lat, lon, s.lat, s.lon)
  })).filter(s => s.foF2 > 0);
  
  if (stationsWithDist.length === 0) return null;
  
  // Sort by distance and take nearest 5
  stationsWithDist.sort((a, b) => a.distance - b.distance);
  
  // Check if nearest station is within valid range
  if (stationsWithDist[0].distance > MAX_VALID_DISTANCE) {
    logDebug(`[Ionosonde] Nearest station ${stationsWithDist[0].name} is ${Math.round(stationsWithDist[0].distance)}km away - too far, using estimates`);
    return {
      foF2: null,
      mufd: null,
      hmF2: null,
      md: 3.0,
      nearestStation: stationsWithDist[0].name,
      nearestDistance: Math.round(stationsWithDist[0].distance),
      stationsUsed: 0,
      method: 'no-coverage',
      reason: `Nearest ionosonde (${stationsWithDist[0].name}) is ${Math.round(stationsWithDist[0].distance)}km away - no local coverage`
    };
  }
  
  // Filter to only stations within valid range
  const validStations = stationsWithDist.filter(s => s.distance <= MAX_VALID_DISTANCE);
  const nearest = validStations.slice(0, 5);
  
  // If very close to a station, use its value directly
  if (nearest[0].distance < 100) {
    return {
      foF2: nearest[0].foF2,
      mufd: nearest[0].mufd,
      hmF2: nearest[0].hmF2,
      md: nearest[0].md,
      source: nearest[0].name,
      confidence: nearest[0].confidence,
      nearestDistance: Math.round(nearest[0].distance),
      method: 'direct'
    };
  }
  
  // Inverse distance weighted interpolation
  let sumWeights = 0;
  let sumFoF2 = 0;
  let sumMufd = 0;
  let sumHmF2 = 0;
  let sumMd = 0;
  
  nearest.forEach(s => {
    const weight = (s.confidence / 100) / Math.pow(s.distance, 2);
    sumWeights += weight;
    sumFoF2 += s.foF2 * weight;
    if (s.mufd) sumMufd += s.mufd * weight;
    if (s.hmF2) sumHmF2 += s.hmF2 * weight;
    if (s.md) sumMd += s.md * weight;
  });
  
  return {
    foF2: sumFoF2 / sumWeights,
    mufd: sumMufd > 0 ? sumMufd / sumWeights : null,
    hmF2: sumHmF2 > 0 ? sumHmF2 / sumWeights : null,
    md: sumMd > 0 ? sumMd / sumWeights : 3.0,
    nearestStation: nearest[0].name,
    nearestDistance: Math.round(nearest[0].distance),
    stationsUsed: nearest.length,
    method: 'interpolated'
  };
}

// ============================================
// HYBRID PROPAGATION SYSTEM
// Combines ITURHFProp (ITU-R P.533-14) with real-time ionosonde data
// ============================================

// Cache for ITURHFProp predictions (5-minute cache)
let iturhfpropCache = {
  data: null,
  key: null,
  timestamp: 0,
  maxAge: 5 * 60 * 1000  // 5 minutes
};

/**
 * Fetch base prediction from ITURHFProp service
 */
async function fetchITURHFPropPrediction(txLat, txLon, rxLat, rxLon, ssn, month, hour) {
  if (!ITURHFPROP_URL) return null;
  
  const cacheKey = `${txLat.toFixed(1)},${txLon.toFixed(1)}-${rxLat.toFixed(1)},${rxLon.toFixed(1)}-${ssn}-${month}-${hour}`;
  const now = Date.now();
  
  // Check cache
  if (iturhfpropCache.key === cacheKey && (now - iturhfpropCache.timestamp) < iturhfpropCache.maxAge) {
    return iturhfpropCache.data;
  }
  
  try {
    const url = `${ITURHFPROP_URL}/api/bands?txLat=${txLat}&txLon=${txLon}&rxLat=${rxLat}&rxLon=${rxLon}&ssn=${ssn}&month=${month}&hour=${hour}`;
    
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      logErrorOnce('Hybrid', `ITURHFProp returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    // Only log success occasionally to reduce noise
    
    // Cache the result
    iturhfpropCache = {
      data,
      key: cacheKey,
      timestamp: now,
      maxAge: iturhfpropCache.maxAge
    };
    
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      logErrorOnce('Hybrid', `ITURHFProp: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch 24-hour predictions from ITURHFProp
 */
async function fetchITURHFPropHourly(txLat, txLon, rxLat, rxLon, ssn, month) {
  if (!ITURHFPROP_URL) return null;
  
  try {
    const url = `${ITURHFPROP_URL}/api/predict/hourly?txLat=${txLat}&txLon=${txLon}&rxLat=${rxLat}&rxLon=${rxLon}&ssn=${ssn}&month=${month}`;
    
    const response = await fetch(url, { timeout: 60000 }); // 60s timeout for 24-hour calc
    if (!response.ok) return null;
    
    const data = await response.json();
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      logErrorOnce('Hybrid', `ITURHFProp hourly: ${err.message}`);
    }
    return null;
  }
}

/**
 * Calculate ionospheric correction factor
 * Compares expected foF2 (from P.533 model) vs actual ionosonde foF2
 * Returns multiplier to adjust reliability predictions
 */
function calculateIonoCorrection(expectedFoF2, actualFoF2, kIndex) {
  if (!expectedFoF2 || !actualFoF2) return { factor: 1.0, confidence: 'low' };
  
  // Ratio of actual to expected ionospheric conditions
  const ratio = actualFoF2 / expectedFoF2;
  
  // Geomagnetic correction (storms reduce reliability)
  const kFactor = kIndex <= 3 ? 1.0 : 1.0 - (kIndex - 3) * 0.1;
  
  // Combined correction factor
  // ratio > 1 means better conditions than predicted
  // ratio < 1 means worse conditions than predicted
  const factor = ratio * kFactor;
  
  // Confidence based on how close actual is to expected
  let confidence;
  if (Math.abs(ratio - 1) < 0.15) {
    confidence = 'high';  // Within 15% - model is accurate
  } else if (Math.abs(ratio - 1) < 0.3) {
    confidence = 'medium'; // Within 30%
  } else {
    confidence = 'low';    // Model significantly off - rely more on ionosonde
  }
  
  logDebug(`[Hybrid] Correction factor: ${factor.toFixed(2)} (expected foF2: ${expectedFoF2.toFixed(1)}, actual: ${actualFoF2.toFixed(1)}, K: ${kIndex})`);
  
  return { factor, confidence, ratio, kFactor };
}

/**
 * Apply ionospheric correction to ITURHFProp predictions
 */
function applyHybridCorrection(iturhfpropData, ionoData, kIndex, sfi) {
  if (!iturhfpropData?.bands) return null;
  
  // Estimate what foF2 ITURHFProp expected (based on SSN/SFI)
  const ssn = Math.max(0, Math.round((sfi - 67) / 0.97));
  const expectedFoF2 = 0.9 * Math.sqrt(ssn + 15) * 1.2; // Rough estimate at solar noon
  
  // Get actual foF2 from ionosonde
  const actualFoF2 = ionoData?.foF2;
  
  // Calculate correction
  const correction = calculateIonoCorrection(expectedFoF2, actualFoF2, kIndex);
  
  // Apply correction to each band
  const correctedBands = {};
  for (const [band, data] of Object.entries(iturhfpropData.bands)) {
    const baseReliability = data.reliability || 50;
    
    // Apply correction factor with bounds
    let correctedReliability = baseReliability * correction.factor;
    correctedReliability = Math.max(0, Math.min(100, correctedReliability));
    
    // For high bands, also check if we're above/below MUF
    const freq = data.freq;
    if (actualFoF2 && freq > actualFoF2 * 3.5) {
      // Frequency likely above MUF - reduce reliability
      correctedReliability *= 0.5;
    }
    
    correctedBands[band] = {
      ...data,
      reliability: Math.round(correctedReliability),
      baseReliability: Math.round(baseReliability),
      correctionApplied: correction.factor !== 1.0,
      status: correctedReliability >= 70 ? 'GOOD' : 
              correctedReliability >= 40 ? 'FAIR' : 'POOR'
    };
  }
  
  // Correct MUF based on actual ionosonde data
  let correctedMuf = iturhfpropData.muf;
  if (actualFoF2 && ionoData?.md) {
    // Use actual foF2 * M-factor for more accurate MUF
    const ionoMuf = actualFoF2 * (ionoData.md || 3.0);
    // Blend ITURHFProp MUF with ionosonde-derived MUF
    correctedMuf = (iturhfpropData.muf * 0.4) + (ionoMuf * 0.6);
  }
  
  return {
    bands: correctedBands,
    muf: Math.round(correctedMuf * 10) / 10,
    correction,
    model: 'Hybrid ITU-R P.533-14'
  };
}

/**
 * Estimate expected foF2 from P.533 model for a given hour
 */
function estimateExpectedFoF2(ssn, lat, hour) {
  // Simplified P.533 foF2 estimation
  // diurnal variation: peak around 14:00 local, minimum around 04:00
  const hourFactor = 0.6 + 0.4 * Math.cos((hour - 14) * Math.PI / 12);
  const latFactor = 1 - Math.abs(lat) / 150;
  const ssnFactor = Math.sqrt(ssn + 15);
  
  return 0.9 * ssnFactor * hourFactor * latFactor;
}

// ============================================
// ENHANCED PROPAGATION PREDICTION API (Hybrid ITU-R P.533)
// ============================================

app.get('/api/propagation', async (req, res) => {
  const { deLat, deLon, dxLat, dxLon } = req.query;
  
  const useHybrid = ITURHFPROP_URL !== null;
  logDebug(`[Propagation] ${useHybrid ? 'Hybrid' : 'Standalone'} calculation for DE:`, deLat, deLon, 'to DX:', dxLat, dxLon);
  
  try {
    // Get current space weather data
    let sfi = 150, ssn = 100, kIndex = 2, aIndex = 10;
    
    try {
      const [fluxRes, kRes] = await Promise.allSettled([
        fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
        fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')
      ]);
      
      if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
        const data = await fluxRes.value.json();
        if (data?.length) sfi = Math.round(data[data.length - 1].flux || 150);
      }
      if (kRes.status === 'fulfilled' && kRes.value.ok) {
        const data = await kRes.value.json();
        if (data?.length > 1) kIndex = parseInt(data[data.length - 1][1]) || 2;
      }
      ssn = Math.max(0, Math.round((sfi - 67) / 0.97));
    } catch (e) {
      logDebug('[Propagation] Using default solar values');
    }
    
    // Get real ionosonde data
    const ionosondeStations = await fetchIonosondeData();
    
    // Calculate path geometry
    const de = { lat: parseFloat(deLat) || 40, lon: parseFloat(deLon) || -75 };
    const dx = { lat: parseFloat(dxLat) || 35, lon: parseFloat(dxLon) || 139 };
    
    const distance = haversineDistance(de.lat, de.lon, dx.lat, dx.lon);
    const midLat = (de.lat + dx.lat) / 2;
    let midLon = (de.lon + dx.lon) / 2;
    
    // Handle antimeridian crossing
    if (Math.abs(de.lon - dx.lon) > 180) {
      midLon = (de.lon + dx.lon + 360) / 2;
      if (midLon > 180) midLon -= 360;
    }
    
    // Get ionospheric data at path midpoint
    const ionoData = interpolateFoF2(midLat, midLon, ionosondeStations);
    const hasValidIonoData = !!(ionoData && ionoData.method !== 'no-coverage' && ionoData.foF2);
    
    const currentHour = new Date().getUTCHours();
    const currentMonth = new Date().getMonth() + 1;
    
    logDebug('[Propagation] Distance:', Math.round(distance), 'km');
    logDebug('[Propagation] Solar: SFI', sfi, 'SSN', ssn, 'K', kIndex);
    if (hasValidIonoData) {
      logDebug('[Propagation] Real foF2:', ionoData.foF2?.toFixed(2), 'MHz from', ionoData.nearestStation || ionoData.source);
    }
    
    // ===== HYBRID MODE: Try ITURHFProp first =====
    let hybridResult = null;
    if (useHybrid) {
      const iturhfpropData = await fetchITURHFPropPrediction(
        de.lat, de.lon, dx.lat, dx.lon, ssn, currentMonth, currentHour
      );
      
      if (iturhfpropData && hasValidIonoData) {
        // Full hybrid: ITURHFProp + ionosonde correction
        hybridResult = applyHybridCorrection(iturhfpropData, ionoData, kIndex, sfi);
        logDebug('[Propagation] Using HYBRID mode (ITURHFProp + ionosonde correction)');
      } else if (iturhfpropData) {
        // ITURHFProp only (no ionosonde coverage)
        hybridResult = {
          bands: iturhfpropData.bands,
          muf: iturhfpropData.muf,
          model: 'ITU-R P.533-14 (ITURHFProp)'
        };
        logDebug('[Propagation] Using ITURHFProp only (no ionosonde coverage)');
      }
    }
    
    // ===== FALLBACK: Built-in calculations =====
    const bands = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '11m', '10m', '6m'];
    const bandFreqs = [1.8, 3.5, 7, 10, 14, 18, 21, 24, 27, 28, 50];
    
    // Generate predictions (hybrid or fallback)
    const effectiveIonoData = hasValidIonoData ? ionoData : null;
    const predictions = {};
    let currentBands;
    
    if (hybridResult) {
      // Use hybrid results for current bands
      currentBands = bands.map((band, idx) => {
        const hybridBand = hybridResult.bands?.[band];
        if (hybridBand) {
          return {
            band,
            freq: bandFreqs[idx],
            reliability: hybridBand.reliability,
            baseReliability: hybridBand.baseReliability,
            snr: calculateSNR(hybridBand.reliability),
            status: hybridBand.status,
            corrected: hybridBand.correctionApplied
          };
        }
        // Fallback for bands not in hybrid result
        const reliability = calculateEnhancedReliability(
          bandFreqs[idx], distance, midLat, midLon, currentHour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
        );
        return {
          band,
          freq: bandFreqs[idx],
          reliability: Math.round(reliability),
          snr: calculateSNR(reliability),
          status: getStatus(reliability)
        };
      }).sort((a, b) => b.reliability - a.reliability);
      
      // Generate 24-hour predictions with correction ratios from hybrid data
      // This makes predictions more accurate by scaling them to match the hybrid model
      bands.forEach((band, idx) => {
        const freq = bandFreqs[idx];
        predictions[band] = [];
        
        // Calculate built-in reliability for current hour
        const builtInCurrentReliability = calculateEnhancedReliability(
          freq, distance, midLat, midLon, currentHour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
        );
        
        // Get hybrid reliability for this band (the accurate one)
        const hybridBand = hybridResult.bands?.[band];
        const hybridReliability = hybridBand?.reliability || builtInCurrentReliability;
        
        // Calculate correction ratio (how much to scale predictions)
        // Avoid division by zero, and cap the ratio to prevent extreme corrections
        let correctionRatio = 1.0;
        if (builtInCurrentReliability > 5) {
          correctionRatio = hybridReliability / builtInCurrentReliability;
          // Cap correction ratio to reasonable bounds (0.2x to 3x)
          correctionRatio = Math.max(0.2, Math.min(3.0, correctionRatio));
        } else if (hybridReliability > 20) {
          // Built-in thinks band is closed but hybrid says it's open
          correctionRatio = 2.0;
        }
        
        for (let hour = 0; hour < 24; hour++) {
          const baseReliability = calculateEnhancedReliability(
            freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
          );
          // Apply correction ratio and clamp to valid range
          const correctedReliability = Math.min(99, Math.max(0, Math.round(baseReliability * correctionRatio)));
          predictions[band].push({
            hour,
            reliability: correctedReliability,
            snr: calculateSNR(correctedReliability)
          });
        }
      });
      
    } else {
      // Full fallback - use built-in calculations
      logDebug('[Propagation] Using FALLBACK mode (built-in calculations)');
      
      bands.forEach((band, idx) => {
        const freq = bandFreqs[idx];
        predictions[band] = [];
        for (let hour = 0; hour < 24; hour++) {
          const reliability = calculateEnhancedReliability(
            freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
          );
          predictions[band].push({
            hour,
            reliability: Math.round(reliability),
            snr: calculateSNR(reliability)
          });
        }
      });
      
      currentBands = bands.map((band, idx) => ({
        band,
        freq: bandFreqs[idx],
        reliability: predictions[band][currentHour].reliability,
        snr: predictions[band][currentHour].snr,
        status: getStatus(predictions[band][currentHour].reliability)
      })).sort((a, b) => b.reliability - a.reliability);
    }
    
    // Calculate MUF and LUF
    const currentMuf = hybridResult?.muf || calculateMUF(distance, midLat, midLon, currentHour, sfi, ssn, effectiveIonoData);
    const currentLuf = calculateLUF(distance, midLat, currentHour, sfi, kIndex);
    
    // Build ionospheric response
    let ionosphericResponse;
    if (hasValidIonoData) {
      ionosphericResponse = {
        foF2: ionoData.foF2?.toFixed(2),
        mufd: ionoData.mufd?.toFixed(1),
        hmF2: ionoData.hmF2?.toFixed(0),
        source: ionoData.nearestStation || ionoData.source,
        distance: ionoData.nearestDistance,
        method: ionoData.method,
        stationsUsed: ionoData.stationsUsed || 1
      };
    } else if (ionoData?.method === 'no-coverage') {
      ionosphericResponse = {
        source: 'No ionosonde coverage',
        reason: ionoData.reason,
        nearestStation: ionoData.nearestStation,
        nearestDistance: ionoData.nearestDistance,
        method: 'estimated'
      };
    } else {
      ionosphericResponse = { source: 'model', method: 'estimated' };
    }
    
    // Determine data source description
    let dataSource;
    if (hybridResult && hasValidIonoData) {
      dataSource = 'Hybrid: ITURHFProp (ITU-R P.533-14) + KC2G/GIRO ionosonde';
    } else if (hybridResult) {
      dataSource = 'ITURHFProp (ITU-R P.533-14)';
    } else if (hasValidIonoData) {
      dataSource = 'KC2G/GIRO Ionosonde Network';
    } else {
      dataSource = 'Estimated from solar indices';
    }
    
    res.json({
      model: hybridResult?.model || 'Built-in estimation',
      solarData: { sfi, ssn, kIndex },
      ionospheric: ionosphericResponse,
      muf: Math.round(currentMuf * 10) / 10,
      luf: Math.round(currentLuf * 10) / 10,
      distance: Math.round(distance),
      currentHour,
      currentBands,
      hourlyPredictions: predictions,
      hybrid: {
        enabled: useHybrid,
        iturhfpropAvailable: hybridResult !== null,
        ionosondeAvailable: hasValidIonoData,
        correctionFactor: hybridResult?.correction?.factor?.toFixed(2),
        confidence: hybridResult?.correction?.confidence
      },
      dataSource
    });
    
  } catch (error) {
    logErrorOnce('Propagation', error.message);
    res.status(500).json({ error: 'Failed to calculate propagation' });
  }
});

// Legacy endpoint removed - merged into /api/propagation above

// Calculate MUF using real ionosonde data or model
function calculateMUF(distance, midLat, midLon, hour, sfi, ssn, ionoData) {
  // If we have real MUF(3000) data, scale it for actual distance
  if (ionoData?.mufd) {
    // MUF scales with distance: MUF(d) ≈ MUF(3000) * sqrt(3000/d) for d < 3000km
    // For d > 3000km, MUF(d) ≈ MUF(3000) * (1 + 0.1 * log(d/3000))
    if (distance < 3000) {
      return ionoData.mufd * Math.sqrt(distance / 3000);
    } else {
      return ionoData.mufd * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // If we have foF2, calculate MUF using M(3000)F2 factor
  if (ionoData?.foF2) {
    const M = ionoData.md || 3.0; // M(3000)F2 factor, typically 2.5-3.5
    const muf3000 = ionoData.foF2 * M;
    
    // Scale for actual distance
    if (distance < 3000) {
      return muf3000 * Math.sqrt(distance / 3000);
    } else {
      return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // Fallback: Estimate foF2 from solar indices
  // foF2 ≈ 0.9 * sqrt(SSN + 15) * diurnal_factor
  const hourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12); // Peak at 14:00 local
  const latFactor = 1 - Math.abs(midLat) / 150; // Higher latitudes = lower foF2
  const foF2_est = 0.9 * Math.sqrt(ssn + 15) * hourFactor * latFactor;
  
  // Standard M(3000)F2 factor
  const M = 3.0;
  const muf3000 = foF2_est * M;
  
  // Scale for distance
  if (distance < 3000) {
    return muf3000 * Math.sqrt(distance / 3000);
  } else {
    return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
  }
}

// Calculate LUF (Lowest Usable Frequency) based on D-layer absorption
function calculateLUF(distance, midLat, hour, sfi, kIndex) {
  // LUF increases with:
  // - Higher solar flux (more D-layer ionization)
  // - Daytime (D-layer forms during day)
  // - Shorter paths (higher elevation angles = more time in D-layer)
  // - Geomagnetic activity
  
  // Local solar time at midpoint (approximate)
  const localHour = hour; // Would need proper calculation with midLon
  
  // Day/night factor: D-layer absorption is much higher during daytime
  let dayFactor = 0.3; // Night
  if (localHour >= 6 && localHour <= 18) {
    // Daytime - peaks around noon
    dayFactor = 0.5 + 0.5 * Math.cos((localHour - 12) * Math.PI / 6);
  }
  
  // Solar flux factor: higher SFI = more absorption
  const sfiFactor = 1 + (sfi - 70) / 200;
  
  // Distance factor: shorter paths have higher LUF (higher angles)
  const distFactor = Math.max(0.5, 1 - distance / 10000);
  
  // Latitude factor: polar paths have more absorption
  const latFactor = 1 + Math.abs(midLat) / 90 * 0.5;
  
  // K-index: geomagnetic storms increase absorption
  const kFactor = 1 + kIndex * 0.1;
  
  // Base LUF is around 2 MHz for long night paths
  const baseLuf = 2.0;
  
  return baseLuf * dayFactor * sfiFactor * distFactor * latFactor * kFactor;
}

// Enhanced reliability calculation using real ionosonde data
function calculateEnhancedReliability(freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, ionoData, currentHour) {
  // Calculate MUF and LUF for this hour
  // For non-current hours, we need to estimate how foF2 changes
  let hourIonoData = ionoData;
  
  if (ionoData && hour !== currentHour) {
    // Estimate foF2 change based on diurnal variation
    // foF2 typically varies by factor of 2-3 between day and night
    const currentHourFactor = 1 + 0.4 * Math.cos((currentHour - 14) * Math.PI / 12);
    const targetHourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12);
    const scaleFactor = targetHourFactor / currentHourFactor;
    
    hourIonoData = {
      ...ionoData,
      foF2: ionoData.foF2 * scaleFactor,
      mufd: ionoData.mufd ? ionoData.mufd * scaleFactor : null
    };
  }
  
  const muf = calculateMUF(distance, midLat, midLon, hour, sfi, ssn, hourIonoData);
  const luf = calculateLUF(distance, midLat, hour, sfi, kIndex);
  
  // Calculate reliability based on frequency position relative to MUF/LUF
  let reliability = 0;
  
  if (freq > muf * 1.1) {
    // Well above MUF - very poor
    reliability = Math.max(0, 30 - (freq - muf) * 5);
  } else if (freq > muf) {
    // Slightly above MUF - marginal (sometimes works due to scatter)
    reliability = 30 + (muf * 1.1 - freq) / (muf * 0.1) * 20;
  } else if (freq < luf * 0.8) {
    // Well below LUF - absorbed
    reliability = Math.max(0, 20 - (luf - freq) * 10);
  } else if (freq < luf) {
    // Near LUF - marginal
    reliability = 20 + (freq - luf * 0.8) / (luf * 0.2) * 30;
  } else {
    // In usable range - calculate optimum
    // Optimum Working Frequency (OWF) is typically 80-85% of MUF
    const owf = muf * 0.85;
    const range = muf - luf;
    
    if (range <= 0) {
      reliability = 30; // Very narrow window
    } else {
      // Higher reliability near OWF, tapering toward MUF and LUF
      const position = (freq - luf) / range; // 0 at LUF, 1 at MUF
      const optimalPosition = 0.75; // 75% up from LUF = OWF
      
      if (position < optimalPosition) {
        // Below OWF - reliability increases as we approach OWF
        reliability = 50 + (position / optimalPosition) * 45;
      } else {
        // Above OWF - reliability decreases as we approach MUF
        reliability = 95 - ((position - optimalPosition) / (1 - optimalPosition)) * 45;
      }
    }
  }
  
  // K-index degradation (geomagnetic storms)
  if (kIndex >= 7) reliability *= 0.1;
  else if (kIndex >= 6) reliability *= 0.2;
  else if (kIndex >= 5) reliability *= 0.4;
  else if (kIndex >= 4) reliability *= 0.6;
  else if (kIndex >= 3) reliability *= 0.8;
  
  // Very long paths (multiple hops) are harder
  const hops = Math.ceil(distance / 3500);
  if (hops > 1) {
    reliability *= Math.pow(0.92, hops - 1); // ~8% loss per additional hop
  }
  
  // Polar path penalty (auroral absorption)
  if (Math.abs(midLat) > 60) {
    reliability *= 0.7;
    if (kIndex >= 3) reliability *= 0.7; // Additional penalty during storms
  }
  
  // High bands need sufficient solar activity
  if (freq >= 21 && sfi < 100) reliability *= Math.sqrt(sfi / 100);
  if (freq >= 28 && sfi < 120) reliability *= Math.sqrt(sfi / 120);
  if (freq >= 50 && sfi < 150) reliability *= Math.pow(sfi / 150, 1.5);
  
  // Low bands work better at night
  const localHour = (hour + midLon / 15 + 24) % 24;
  const isNight = localHour < 6 || localHour > 18;
  if (freq <= 7 && isNight) reliability *= 1.1;
  if (freq <= 3.5 && !isNight) reliability *= 0.7;
  
  return Math.min(99, Math.max(0, reliability));
}

// Convert reliability to estimated SNR
function calculateSNR(reliability) {
  if (reliability >= 80) return '+20dB';
  if (reliability >= 60) return '+10dB';
  if (reliability >= 40) return '0dB';
  if (reliability >= 20) return '-10dB';
  return '-20dB';
}

// Get status label from reliability
function getStatus(reliability) {
  if (reliability >= 70) return 'EXCELLENT';
  if (reliability >= 50) return 'GOOD';
  if (reliability >= 30) return 'FAIR';
  if (reliability >= 15) return 'POOR';
  return 'CLOSED';
}

// QRZ Callsign lookup (requires API key)
app.get('/api/qrz/lookup/:callsign', async (req, res) => {
  const { callsign } = req.params;
  // Note: QRZ requires an API key - this is a placeholder
  res.json({ 
    message: 'QRZ lookup requires API key configuration',
    callsign: callsign.toUpperCase()
  });
});

// ============================================
// CONTEST CALENDAR API
// ============================================

app.get('/api/contests', async (req, res) => {
  // Try WA7BNM Contest Calendar RSS feed
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://www.contestcalendar.com/calendar.rss', {
      headers: { 
        'User-Agent': 'OpenHamClock/3.3',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const contests = parseContestRSS(text);
      
      if (contests.length > 0) {
        logDebug('[Contests] WA7BNM RSS:', contests.length, 'contests');
        return res.json(contests);
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      logErrorOnce('Contests RSS', error.message);
    }
  }

  // Fallback: Use calculated contests
  try {
    const contests = calculateUpcomingContests();
    logDebug('[Contests] Using calculated:', contests.length, 'contests');
    return res.json(contests);
  } catch (error) {
    logErrorOnce('Contests', error.message);
  }

  res.json([]);
});

// Parse WA7BNM RSS feed
function parseContestRSS(xml) {
  const contests = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Simple regex-based XML parsing (no external dependencies)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>([^<]+)<\/title>/;
  const linkRegex = /<link>([^<]+)<\/link>/;
  const descRegex = /<description>([^<]+)<\/description>/;
  
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    
    const titleMatch = item.match(titleRegex);
    const linkMatch = item.match(linkRegex);
    const descMatch = item.match(descRegex);
    
    if (titleMatch && descMatch) {
      const name = titleMatch[1].trim();
      const desc = descMatch[1].trim();
      const url = linkMatch ? linkMatch[1].trim() : null;
      
      // Parse description like "1300Z, Jan 31 to 1300Z, Feb 1" or "0000Z-2359Z, Jan 31"
      const parsed = parseContestDateTime(desc, currentYear);
      
      if (parsed) {
        const status = (now >= parsed.start && now <= parsed.end) ? 'active' : 'upcoming';
        
        // Try to detect mode from contest name
        let mode = 'Mixed';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('cw') || nameLower.includes('morse')) mode = 'CW';
        else if (nameLower.includes('ssb') || nameLower.includes('phone') || nameLower.includes('sideband')) mode = 'SSB';
        else if (nameLower.includes('rtty')) mode = 'RTTY';
        else if (nameLower.includes('ft4') || nameLower.includes('ft8') || nameLower.includes('digi')) mode = 'Digital';
        else if (nameLower.includes('vhf') || nameLower.includes('uhf')) mode = 'VHF';
        
        contests.push({
          name,
          start: parsed.start.toISOString(),
          end: parsed.end.toISOString(),
          mode,
          status,
          url
        });
      }
    }
  }
  
  // Sort by start date, filter out past contests, and limit
  const currentAndFuture = contests.filter(c => new Date(c.end) >= now);
  currentAndFuture.sort((a, b) => new Date(a.start) - new Date(b.start));
  return currentAndFuture.slice(0, 20);
}

// Parse contest date/time strings
function parseContestDateTime(desc, year) {
  try {
    const months = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 
                     'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    
    // Pattern 1: "1300Z, Jan 31 to 1300Z, Feb 1"
    const rangeMatch = desc.match(/(\d{4})Z,\s*(\w+)\s+(\d+)\s+to\s+(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (rangeMatch) {
      const [, startTime, startMon, startDay, endTime, endMon, endDay] = rangeMatch;
      const startMonth = months[startMon.toLowerCase()];
      const endMonth = months[endMon.toLowerCase()];
      
      let startYear = year;
      let endYear = year;
      // Handle year rollover
      if (startMonth > 10 && endMonth < 2) endYear = year + 1;
      
      const start = new Date(Date.UTC(startYear, startMonth, parseInt(startDay), 
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(endYear, endMonth, parseInt(endDay),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      return { start, end };
    }
    
    // Pattern 2: "0000Z-2359Z, Jan 31" (same day)
    const sameDayMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (sameDayMatch) {
      const [, startTime, endTime, mon, day] = sameDayMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      // Handle overnight contests (end time < start time means next day)
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
    // Pattern 3: "0000Z-0100Z, Feb 5 and 0200Z-0300Z, Feb 6" (multiple sessions - use first)
    const multiMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (multiMatch) {
      const [, startTime, endTime, mon, day] = multiMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
  } catch (e) {
    // Parse error, skip this contest
  }
  
  return null;
}

// Helper function to calculate upcoming contests
function calculateUpcomingContests() {
  const now = new Date();
  const contests = [];
  
  // Major contest definitions with typical schedules
  const majorContests = [
    { name: 'CQ WW DX CW', month: 10, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend Nov
    { name: 'CQ WW DX SSB', month: 9, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Oct
    { name: 'ARRL DX CW', month: 1, weekend: 3, duration: 48, mode: 'CW' }, // 3rd full weekend Feb
    { name: 'ARRL DX SSB', month: 2, weekend: 1, duration: 48, mode: 'SSB' }, // 1st full weekend Mar
    { name: 'CQ WPX SSB', month: 2, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Mar
    { name: 'CQ WPX CW', month: 4, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend May
    { name: 'IARU HF Championship', month: 6, weekend: 2, duration: 24, mode: 'Mixed' }, // 2nd full weekend Jul
    { name: 'ARRL Field Day', month: 5, weekend: 4, duration: 27, mode: 'Mixed' }, // 4th full weekend Jun
    { name: 'ARRL Sweepstakes CW', month: 10, weekend: 1, duration: 24, mode: 'CW' }, // 1st full weekend Nov
    { name: 'ARRL Sweepstakes SSB', month: 10, weekend: 3, duration: 24, mode: 'SSB' }, // 3rd full weekend Nov
    { name: 'ARRL 10m Contest', month: 11, weekend: 2, duration: 48, mode: 'Mixed' }, // 2nd full weekend Dec
    { name: 'ARRL RTTY Roundup', month: 0, weekend: 1, duration: 24, mode: 'RTTY' }, // 1st full weekend Jan
    { name: 'NA QSO Party CW', month: 0, weekend: 2, duration: 12, mode: 'CW' },
    { name: 'NA QSO Party SSB', month: 0, weekend: 3, duration: 12, mode: 'SSB' },
    { name: 'CQ 160m CW', month: 0, weekend: -1, duration: 42, mode: 'CW' }, // Last full weekend Jan
    { name: 'CQ 160m SSB', month: 1, weekend: -1, duration: 42, mode: 'SSB' }, // Last full weekend Feb
    { name: 'CQ WW RTTY', month: 8, weekend: -1, duration: 48, mode: 'RTTY' },
    { name: 'JIDX CW', month: 3, weekend: 2, duration: 48, mode: 'CW' },
    { name: 'JIDX SSB', month: 10, weekend: 2, duration: 48, mode: 'SSB' },
    { name: 'ARRL VHF Contest', month: 0, weekend: 3, duration: 33, mode: 'Mixed' }, // 3rd weekend Jan
    { name: 'ARRL June VHF', month: 5, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Jun
    { name: 'ARRL Sept VHF', month: 8, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Sep
    { name: 'Winter Field Day', month: 0, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Jan
    { name: 'CQWW WPX RTTY', month: 1, weekend: 2, duration: 48, mode: 'RTTY' }, // 2nd weekend Feb
    { name: 'Stew Perry Topband', month: 11, weekend: 4, duration: 14, mode: 'CW' }, // 4th weekend Dec
    { name: 'RAC Canada Day', month: 6, weekend: 1, duration: 24, mode: 'Mixed' }, // 1st weekend Jul
    { name: 'RAC Winter Contest', month: 11, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Dec
    { name: 'NAQP RTTY', month: 1, weekend: 4, duration: 12, mode: 'RTTY' }, // 4th weekend Feb
    { name: 'NAQP RTTY', month: 6, weekend: 3, duration: 12, mode: 'RTTY' }, // 3rd weekend Jul
  ];

  // Weekly mini-contests (CWT, SST, etc.) - dayOfWeek: 0=Sun, 1=Mon, ... 6=Sat
  const weeklyContests = [
    { name: 'CWT 1300z', dayOfWeek: 3, hour: 13, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 1900z', dayOfWeek: 3, hour: 19, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 0300z', dayOfWeek: 4, hour: 3, duration: 1, mode: 'CW' }, // Thursday
    { name: 'CWT 0700z', dayOfWeek: 4, hour: 7, duration: 1, mode: 'CW' }, // Thursday
    { name: 'NCCC Sprint', dayOfWeek: 5, hour: 3, minute: 30, duration: 0.5, mode: 'CW' }, // Friday
    { name: 'K1USN SST', dayOfWeek: 0, hour: 0, duration: 1, mode: 'CW' }, // Sunday 0000z (Sat evening US)
    { name: 'K1USN SST', dayOfWeek: 1, hour: 20, duration: 1, mode: 'CW' }, // Monday 2000z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 13, duration: 1, mode: 'CW' }, // Monday 1300z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 19, duration: 1, mode: 'CW' }, // Monday 1900z
    { name: 'ICWC MST', dayOfWeek: 2, hour: 3, duration: 1, mode: 'CW' }, // Tuesday 0300z
    { name: 'SKCC Sprint', dayOfWeek: 3, hour: 0, duration: 2, mode: 'CW' }, // Wednesday 0000z
    { name: 'QRP Fox Hunt', dayOfWeek: 3, hour: 2, duration: 1.5, mode: 'CW' }, // Wednesday 0200z
    { name: 'RTTY Weekday Sprint', dayOfWeek: 2, hour: 23, duration: 1, mode: 'RTTY' }, // Tuesday 2300z
  ];

  // Calculate next occurrences of weekly contests
  weeklyContests.forEach(contest => {
    const next = new Date(now);
    const currentDay = now.getUTCDay();
    let daysUntil = contest.dayOfWeek - currentDay;
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0) {
      // Check if it's today but already passed
      const todayStart = new Date(now);
      todayStart.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
      if (now > todayStart) daysUntil = 7;
    }
    
    next.setUTCDate(now.getUTCDate() + daysUntil);
    next.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
    
    const endTime = new Date(next.getTime() + contest.duration * 3600000);
    
    contests.push({
      name: contest.name,
      start: next.toISOString(),
      end: endTime.toISOString(),
      mode: contest.mode,
      status: (now >= next && now <= endTime) ? 'active' : 'upcoming'
    });
  });

  // Calculate next occurrences of major contests
  const year = now.getFullYear();
  majorContests.forEach(contest => {
    for (let y = year; y <= year + 1; y++) {
      let startDate;
      
      if (contest.weekend === -1) {
        // Last weekend of month
        startDate = getLastWeekendOfMonth(y, contest.month);
      } else {
        // Nth weekend of month
        startDate = getNthWeekendOfMonth(y, contest.month, contest.weekend);
      }
      
      // Most contests start at 00:00 UTC Saturday
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + contest.duration * 3600000);
      
      if (endDate > now) {
        const status = (now >= startDate && now <= endDate) ? 'active' : 'upcoming';
        contests.push({
          name: contest.name,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          mode: contest.mode,
          status: status
        });
        break; // Only add next occurrence
      }
    }
  });

  // Sort by start date
  contests.sort((a, b) => new Date(a.start) - new Date(b.start));
  
  return contests.slice(0, 15);
}

function getNthWeekendOfMonth(year, month, n) {
  const date = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  let weekendCount = 0;
  
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === 6) { // Saturday
      weekendCount++;
      if (weekendCount === n) return new Date(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  
  return date;
}

function getLastWeekendOfMonth(year, month) {
  // Start from last day of month and work backwards
  const date = new Date(Date.UTC(year, month + 1, 0)); // Last day of month
  
  while (date.getUTCDay() !== 6) { // Find last Saturday
    date.setUTCDate(date.getUTCDate() - 1);
  }
  
  return date;
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  rolloverVisitorStats();
  const avg = visitorStats.history.length > 0
    ? Math.round(visitorStats.history.reduce((sum, d) => sum + d.uniqueVisitors, 0) / visitorStats.history.length)
    : visitorStats.uniqueIPs.size;
  res.json({
    status: 'ok',
    version: APP_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    visitors: {
      today: {
        date: visitorStats.today,
        uniqueVisitors: visitorStats.uniqueIPs.size,
        totalRequests: visitorStats.totalRequests
      },
      allTime: {
        since: visitorStats.serverStarted,
        uniqueVisitors: visitorStats.allTimeVisitors,
        totalRequests: visitorStats.allTimeRequests
      },
      dailyAverage: avg,
      history: visitorStats.history
    }
  });
});

// ============================================
// CONFIGURATION ENDPOINT
// ============================================

// Serve station configuration to frontend
// This allows the frontend to get config from .env/config.json without exposing secrets
app.get('/api/config', (req, res) => {
  // Don't expose API keys/passwords - only public config
  res.json({
    version: APP_VERSION,
    
    // Station info (from .env or config.json)
    callsign: CONFIG.callsign,
    locator: CONFIG.gridSquare,
    latitude: CONFIG.latitude,
    longitude: CONFIG.longitude,
    
    // Display preferences
    units: CONFIG.units,
    timeFormat: CONFIG.timeFormat,
    theme: CONFIG.theme,
    layout: CONFIG.layout,
    
    // DX target
    dxLatitude: CONFIG.dxLatitude,
    dxLongitude: CONFIG.dxLongitude,
    
    // Feature toggles
    showSatellites: CONFIG.showSatellites,
    showPota: CONFIG.showPota,
    showDxPaths: CONFIG.showDxPaths,
    showContests: CONFIG.showContests,
    showDXpeditions: CONFIG.showDXpeditions,
    
    // DX Cluster settings
    spotRetentionMinutes: CONFIG.spotRetentionMinutes,
    dxClusterSource: CONFIG.dxClusterSource,
    
    // Whether config is incomplete (show setup wizard)
    configIncomplete: CONFIG.callsign === 'N0CALL' || !CONFIG.gridSquare,
    
    // Server timezone (from TZ env var or system)
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    
    // Feature availability
    features: {
      spaceWeather: true,
      pota: true,
      sota: true,
      dxCluster: true,
      satellites: true,
      contests: true,
      dxpeditions: true,
      wsjtxRelay: !!WSJTX_RELAY_KEY,
    },
    
    // Refresh intervals (ms)
    refreshIntervals: {
      spaceWeather: 300000,
      pota: 60000,
      sota: 60000,
      dxCluster: 30000
    }
  });
});

// ============================================
// MANUAL UPDATE ENDPOINT
// ============================================
app.post('/api/update', async (req, res) => {
  if (autoUpdateState.inProgress) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  try {
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      return res.status(503).json({ error: 'Not a git repository' });
    }
    await execFilePromise('git', ['--version']);
    if (await hasDirtyWorkingTree()) {
      return res.status(409).json({ error: 'Local changes detected' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Update preflight failed' });
  }

  // Respond immediately; update runs asynchronously
  res.json({ ok: true, started: true, timestamp: Date.now() });

  setTimeout(() => {
    autoUpdateTick('manual', true);
  }, 100);
});

app.get('/api/update/status', (req, res) => {
  res.json({
    enabled: AUTO_UPDATE_ENABLED,
    inProgress: autoUpdateState.inProgress,
    lastCheck: autoUpdateState.lastCheck,
    lastResult: autoUpdateState.lastResult
  });
});

// ============================================
// WSJT-X UDP LISTENER
// ============================================
// Receives decoded messages from WSJT-X, JTDX, etc.
// Configure WSJT-X: Settings > Reporting > UDP Server > address/port
// Protocol: QDataStream binary format per NetworkMessage.hpp

const WSJTX_UDP_PORT = parseInt(process.env.WSJTX_UDP_PORT || '2237');
const WSJTX_ENABLED = process.env.WSJTX_ENABLED !== 'false'; // enabled by default
const WSJTX_RELAY_KEY = process.env.WSJTX_RELAY_KEY || ''; // auth key for remote relay agent
const WSJTX_MAX_DECODES = 200; // max decodes to keep in memory
const WSJTX_MAX_AGE = 30 * 60 * 1000; // 30 minutes

// WSJT-X protocol magic number
const WSJTX_MAGIC = 0xADBCCBDA;

// Message types
const WSJTX_MSG = {
  HEARTBEAT: 0,
  STATUS: 1,
  DECODE: 2,
  CLEAR: 3,
  REPLY: 4,
  QSO_LOGGED: 5,
  CLOSE: 6,
  REPLAY: 7,
  HALT_TX: 8,
  FREE_TEXT: 9,
  WSPR_DECODE: 10,
  LOCATION: 11,
  LOGGED_ADIF: 12,
  HIGHLIGHT_CALLSIGN: 13,
  SWITCH_CONFIG: 14,
  CONFIGURE: 15,
};

// In-memory store (for local UDP — no session)
const wsjtxState = {
  clients: {},    // clientId -> { status, lastSeen }
  decodes: [],    // decoded messages (ring buffer)
  qsos: [],       // logged QSOs
  wspr: [],       // WSPR decodes
  relay: null,    // not used for local UDP
};

// Per-session relay storage — each browser gets its own isolated data
const wsjtxRelaySessions = {};  // sessionId -> { clients, decodes, qsos, wspr, relay, lastAccess }
const WSJTX_SESSION_MAX_AGE = 60 * 60 * 1000; // 1 hour inactive expiry
const WSJTX_MAX_SESSIONS = 50; // prevent memory abuse

function getRelaySession(sessionId) {
  if (!sessionId) return null;
  if (!wsjtxRelaySessions[sessionId]) {
    // Check session limit
    if (Object.keys(wsjtxRelaySessions).length >= WSJTX_MAX_SESSIONS) {
      // Evict oldest session
      let oldestId = null, oldestTime = Infinity;
      for (const [id, s] of Object.entries(wsjtxRelaySessions)) {
        if (s.lastAccess < oldestTime) { oldestTime = s.lastAccess; oldestId = id; }
      }
      if (oldestId) delete wsjtxRelaySessions[oldestId];
    }
    wsjtxRelaySessions[sessionId] = {
      clients: {}, decodes: [], qsos: [], wspr: [],
      relay: null, lastAccess: Date.now()
    };
  }
  wsjtxRelaySessions[sessionId].lastAccess = Date.now();
  return wsjtxRelaySessions[sessionId];
}

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(wsjtxRelaySessions)) {
    if (now - session.lastAccess > WSJTX_SESSION_MAX_AGE) {
      delete wsjtxRelaySessions[id];
    }
  }
}, 5 * 60 * 1000);

/**
 * QDataStream binary reader for WSJT-X protocol
 * Reads big-endian Qt-serialized data types
 */
class WSJTXReader {
  constructor(buffer) {
    this.buf = buffer;
    this.offset = 0;
  }
  
  remaining() { return this.buf.length - this.offset; }
  
  readUInt8() {
    if (this.remaining() < 1) return null;
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  
  readInt32() {
    if (this.remaining() < 4) return null;
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  
  readUInt32() {
    if (this.remaining() < 4) return null;
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  
  readUInt64() {
    if (this.remaining() < 8) return null;
    // JavaScript can't do 64-bit ints natively, use BigInt or approximate
    const high = this.buf.readUInt32BE(this.offset);
    const low = this.buf.readUInt32BE(this.offset + 4);
    this.offset += 8;
    return high * 0x100000000 + low;
  }
  
  readBool() {
    const v = this.readUInt8();
    return v === null ? null : v !== 0;
  }
  
  readDouble() {
    if (this.remaining() < 8) return null;
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }
  
  // Qt utf8 string: uint32 length + bytes (0xFFFFFFFF = null)
  readUtf8() {
    const len = this.readUInt32();
    if (len === null || len === 0xFFFFFFFF) return null;
    if (len === 0) return '';
    if (this.remaining() < len) return null;
    const str = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return str;
  }
  
  // QTime: uint32 milliseconds since midnight
  readQTime() {
    const ms = this.readUInt32();
    if (ms === null) return null;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return { ms, hours: h, minutes: m, seconds: s, 
             formatted: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` };
  }
  
  // QDateTime: QDate (int64 julian day) + QTime (uint32 ms) + timespec
  readQDateTime() {
    const julianDay = this.readUInt64();
    const time = this.readQTime();
    const timeSpec = this.readUInt8();
    if (timeSpec === 2) this.readInt32(); // UTC offset
    return { julianDay, time, timeSpec };
  }
}

/**
 * Parse a WSJT-X UDP datagram
 */
function parseWSJTXMessage(buffer) {
  const reader = new WSJTXReader(buffer);
  
  // Header
  const magic = reader.readUInt32();
  if (magic !== WSJTX_MAGIC) return null;
  
  const schema = reader.readUInt32();
  const type = reader.readUInt32();
  const id = reader.readUtf8();
  
  if (type === null || id === null) return null;
  
  const msg = { type, id, schema, timestamp: Date.now() };
  
  try {
    switch (type) {
      case WSJTX_MSG.HEARTBEAT: {
        msg.maxSchema = reader.readUInt32();
        msg.version = reader.readUtf8();
        msg.revision = reader.readUtf8();
        break;
      }
      
      case WSJTX_MSG.STATUS: {
        msg.dialFrequency = reader.readUInt64();
        msg.mode = reader.readUtf8();
        msg.dxCall = reader.readUtf8();
        msg.report = reader.readUtf8();
        msg.txMode = reader.readUtf8();
        msg.txEnabled = reader.readBool();
        msg.transmitting = reader.readBool();
        msg.decoding = reader.readBool();
        msg.rxDF = reader.readUInt32();
        msg.txDF = reader.readUInt32();
        msg.deCall = reader.readUtf8();
        msg.deGrid = reader.readUtf8();
        msg.dxGrid = reader.readUtf8();
        msg.txWatchdog = reader.readBool();
        msg.subMode = reader.readUtf8();
        msg.fastMode = reader.readBool();
        msg.specialOp = reader.readUInt8();
        msg.freqTolerance = reader.readUInt32();
        msg.trPeriod = reader.readUInt32();
        msg.configName = reader.readUtf8();
        msg.txMessage = reader.readUtf8();
        break;
      }
      
      case WSJTX_MSG.DECODE: {
        msg.isNew = reader.readBool();
        msg.time = reader.readQTime();
        msg.snr = reader.readInt32();
        msg.deltaTime = reader.readDouble();
        msg.deltaFreq = reader.readUInt32();
        msg.mode = reader.readUtf8();
        msg.message = reader.readUtf8();
        msg.lowConfidence = reader.readBool();
        msg.offAir = reader.readBool();
        break;
      }
      
      case WSJTX_MSG.CLEAR: {
        msg.window = reader.readUInt8();
        break;
      }
      
      case WSJTX_MSG.QSO_LOGGED: {
        msg.dateTimeOff = reader.readQDateTime();
        msg.dxCall = reader.readUtf8();
        msg.dxGrid = reader.readUtf8();
        msg.txFrequency = reader.readUInt64();
        msg.mode = reader.readUtf8();
        msg.reportSent = reader.readUtf8();
        msg.reportRecv = reader.readUtf8();
        msg.txPower = reader.readUtf8();
        msg.comments = reader.readUtf8();
        msg.name = reader.readUtf8();
        msg.dateTimeOn = reader.readQDateTime();
        msg.operatorCall = reader.readUtf8();
        msg.myCall = reader.readUtf8();
        msg.myGrid = reader.readUtf8();
        msg.exchangeSent = reader.readUtf8();
        msg.exchangeRecv = reader.readUtf8();
        msg.adifPropMode = reader.readUtf8();
        break;
      }
      
      case WSJTX_MSG.WSPR_DECODE: {
        msg.isNew = reader.readBool();
        msg.time = reader.readQTime();
        msg.snr = reader.readInt32();
        msg.deltaTime = reader.readDouble();
        msg.frequency = reader.readUInt64();
        msg.drift = reader.readInt32();
        msg.callsign = reader.readUtf8();
        msg.grid = reader.readUtf8();
        msg.power = reader.readInt32();
        msg.offAir = reader.readBool();
        break;
      }
      
      case WSJTX_MSG.LOGGED_ADIF: {
        msg.adif = reader.readUtf8();
        break;
      }
      
      case WSJTX_MSG.CLOSE:
        break;
        
      default:
        // Unknown message type - ignore per protocol spec
        return null;
    }
  } catch (e) {
    // Malformed packet - ignore
    return null;
  }
  
  return msg;
}

/**
 * Parse decoded message text to extract callsigns and grid
 * FT8/FT4 messages follow a standard format
 */
function parseDecodeMessage(text) {
  if (!text) return {};
  const result = {};
  
  // CQ message: "CQ DX K1ABC FN42" or "CQ K1ABC FN42"
  const cqMatch = text.match(/^CQ\s+(?:(\S+)\s+)?([A-Z0-9/]+)\s+([A-Z]{2}\d{2}[a-z]{0,2})?/i);
  if (cqMatch) {
    result.type = 'CQ';
    result.modifier = cqMatch[1] && !cqMatch[1].match(/^[A-Z0-9/]{3,}$/) ? cqMatch[1] : null;
    result.caller = cqMatch[2] || cqMatch[1];
    result.grid = cqMatch[3] || null;
    return result;
  }
  
  // Standard QSO exchange: "K1ABC W2DEF +05" or "K1ABC W2DEF R-12" or "K1ABC W2DEF RR73"
  const qsoMatch = text.match(/^([A-Z0-9/]+)\s+([A-Z0-9/]+)\s+(.*)/i);
  if (qsoMatch) {
    result.type = 'QSO';
    result.dxCall = qsoMatch[1];
    result.deCall = qsoMatch[2];
    result.exchange = qsoMatch[3].trim();
    // Check for grid in exchange
    const gridMatch = result.exchange.match(/^([A-Z]{2}\d{2}[a-z]{0,2})$/i);
    if (gridMatch) result.grid = gridMatch[1];
    return result;
  }
  
  return result;
}

/**
 * Convert frequency in Hz to band name
 */
function freqToBand(freqHz) {
  const mhz = freqHz / 1000000;
  if (mhz >= 1.8 && mhz < 2.0) return '160m';
  if (mhz >= 3.5 && mhz < 4.0) return '80m';
  if (mhz >= 5.3 && mhz < 5.4) return '60m';
  if (mhz >= 7.0 && mhz < 7.3) return '40m';
  if (mhz >= 10.1 && mhz < 10.15) return '30m';
  if (mhz >= 14.0 && mhz < 14.35) return '20m';
  if (mhz >= 18.068 && mhz < 18.168) return '17m';
  if (mhz >= 21.0 && mhz < 21.45) return '15m';
  if (mhz >= 24.89 && mhz < 24.99) return '12m';
  if (mhz >= 28.0 && mhz < 29.7) return '10m';
  if (mhz >= 50.0 && mhz < 54.0) return '6m';
  if (mhz >= 144.0 && mhz < 148.0) return '2m';
  if (mhz >= 420.0 && mhz < 450.0) return '70cm';
  return `${mhz.toFixed(3)} MHz`;
}

/**
 * Handle incoming WSJT-X messages
 * @param {Object} msg - parsed WSJT-X message
 * @param {Object} state - state object to update (wsjtxState for local, session for relay)
 */
function handleWSJTXMessage(msg, state) {
  if (!msg) return;
  if (!state) state = wsjtxState;
  
  switch (msg.type) {
    case WSJTX_MSG.HEARTBEAT: {
      state.clients[msg.id] = {
        ...(state.clients[msg.id] || {}),
        version: msg.version,
        lastSeen: msg.timestamp
      };
      break;
    }
    
    case WSJTX_MSG.STATUS: {
      state.clients[msg.id] = {
        ...(state.clients[msg.id] || {}),
        lastSeen: msg.timestamp,
        dialFrequency: msg.dialFrequency,
        mode: msg.mode,
        dxCall: msg.dxCall,
        deCall: msg.deCall,
        deGrid: msg.deGrid,
        txEnabled: msg.txEnabled,
        transmitting: msg.transmitting,
        decoding: msg.decoding,
        subMode: msg.subMode,
        band: msg.dialFrequency ? freqToBand(msg.dialFrequency) : null,
        configName: msg.configName,
        txMessage: msg.txMessage,
      };
      break;
    }
    
    case WSJTX_MSG.DECODE: {
      const clientStatus = state.clients[msg.id] || {};
      const parsed = parseDecodeMessage(msg.message);
      
      const decode = {
        id: `${msg.id}-${msg.timestamp}-${msg.deltaFreq}`,
        clientId: msg.id,
        isNew: msg.isNew,
        time: msg.time?.formatted || '',
        timeMs: msg.time?.ms || 0,
        snr: msg.snr,
        dt: msg.deltaTime ? msg.deltaTime.toFixed(1) : '0.0',
        freq: msg.deltaFreq,
        mode: msg.mode || clientStatus.mode || '',
        message: msg.message,
        lowConfidence: msg.lowConfidence,
        offAir: msg.offAir,
        dialFrequency: clientStatus.dialFrequency || 0,
        band: clientStatus.band || '',
        ...parsed,
        timestamp: msg.timestamp,
      };
      
      // Resolve grid to lat/lon for map plotting
      if (parsed.grid) {
        const coords = gridToLatLon(parsed.grid);
        if (coords) {
          decode.lat = coords.latitude;
          decode.lon = coords.longitude;
        }
      }
      
      // Only keep new decodes (not replays)
      if (msg.isNew) {
        state.decodes.push(decode);
        
        // Trim old decodes
        const cutoff = Date.now() - WSJTX_MAX_AGE;
        while (state.decodes.length > WSJTX_MAX_DECODES || 
               (state.decodes.length > 0 && state.decodes[0].timestamp < cutoff)) {
          state.decodes.shift();
        }
      }
      break;
    }
    
    case WSJTX_MSG.CLEAR: {
      // WSJT-X cleared its band activity - optionally clear our decodes for this client
      state.decodes = state.decodes.filter(d => d.clientId !== msg.id);
      break;
    }
    
    case WSJTX_MSG.QSO_LOGGED: {
      const clientStatus = state.clients[msg.id] || {};
      const qso = {
        clientId: msg.id,
        dxCall: msg.dxCall,
        dxGrid: msg.dxGrid,
        frequency: msg.txFrequency,
        band: msg.txFrequency ? freqToBand(msg.txFrequency) : '',
        mode: msg.mode,
        reportSent: msg.reportSent,
        reportRecv: msg.reportRecv,
        myCall: msg.myCall || clientStatus.deCall,
        myGrid: msg.myGrid || clientStatus.deGrid,
        timestamp: msg.timestamp,
      };
      // Resolve grid to lat/lon
      if (msg.dxGrid) {
        const coords = gridToLatLon(msg.dxGrid);
        if (coords) { qso.lat = coords.latitude; qso.lon = coords.longitude; }
      }
      state.qsos.push(qso);
      // Keep last 50 QSOs
      if (state.qsos.length > 50) state.qsos.shift();
      break;
    }
    
    case WSJTX_MSG.WSPR_DECODE: {
      const wsprDecode = {
        clientId: msg.id,
        isNew: msg.isNew,
        time: msg.time?.formatted || '',
        snr: msg.snr,
        dt: msg.deltaTime ? msg.deltaTime.toFixed(1) : '0.0',
        frequency: msg.frequency,
        drift: msg.drift,
        callsign: msg.callsign,
        grid: msg.grid,
        power: msg.power,
        timestamp: msg.timestamp,
      };
      if (msg.isNew) {
        state.wspr.push(wsprDecode);
        if (state.wspr.length > 100) state.wspr.shift();
      }
      break;
    }
    
    case WSJTX_MSG.CLOSE: {
      delete state.clients[msg.id];
      break;
    }
  }
}

// Start UDP listener
let wsjtxSocket = null;
if (WSJTX_ENABLED) {
  try {
    wsjtxSocket = dgram.createSocket('udp4');
    
    wsjtxSocket.on('message', (buf, rinfo) => {
      const msg = parseWSJTXMessage(buf);
      if (msg) handleWSJTXMessage(msg);
    });
    
    wsjtxSocket.on('error', (err) => {
      logErrorOnce('WSJT-X UDP', err.message);
    });
    
    wsjtxSocket.on('listening', () => {
      const addr = wsjtxSocket.address();
      console.log(`[WSJT-X] UDP listener on ${addr.address}:${addr.port}`);
    });
    
    wsjtxSocket.bind(WSJTX_UDP_PORT, '0.0.0.0');
  } catch (e) {
    console.error(`[WSJT-X] Failed to start UDP listener: ${e.message}`);
  }
}

// API endpoint: get WSJT-X data
app.get('/api/wsjtx', (req, res) => {
  const sessionId = req.query.session || '';
  
  // Use session-specific state for relay mode, or global state for local UDP
  const state = (sessionId && WSJTX_RELAY_KEY) ? (wsjtxRelaySessions[sessionId] || { clients: {}, decodes: [], qsos: [], wspr: [], relay: null }) : wsjtxState;
  
  const clients = {};
  for (const [id, client] of Object.entries(state.clients)) {
    // Only include clients seen in last 5 minutes
    if (Date.now() - client.lastSeen < 5 * 60 * 1000) {
      clients[id] = client;
    }
  }
  
  // Relay is "connected" if this session's relay was seen in last 60 seconds
  const relayConnected = state.relay && (Date.now() - state.relay.lastSeen < 60000);
  
  res.json({
    enabled: WSJTX_ENABLED,
    port: WSJTX_UDP_PORT,
    relayEnabled: !!WSJTX_RELAY_KEY,
    relayConnected: !!relayConnected,
    clients,
    decodes: state.decodes.slice(-100), // last 100
    qsos: state.qsos.slice(-20), // last 20
    wspr: state.wspr.slice(-50), // last 50
    stats: {
      totalDecodes: state.decodes.length,
      totalQsos: state.qsos.length,
      totalWspr: state.wspr.length,
      activeClients: Object.keys(clients).length,
    }
  });
});

// API endpoint: get just decodes (lightweight polling)
app.get('/api/wsjtx/decodes', (req, res) => {
  const sessionId = req.query.session || '';
  const state = (sessionId && WSJTX_RELAY_KEY) ? (wsjtxRelaySessions[sessionId] || { decodes: [] }) : wsjtxState;
  
  const since = parseInt(req.query.since) || 0;
  const decodes = since 
    ? state.decodes.filter(d => d.timestamp > since)
    : state.decodes.slice(-100);
  
  res.json({ decodes, timestamp: Date.now() });
});

// API endpoint: relay — receive messages from remote relay agent
// The relay agent runs on the same machine as WSJT-X and forwards
// parsed messages over HTTPS for cloud-hosted instances.
app.post('/api/wsjtx/relay', (req, res) => {
  // Auth check
  if (!WSJTX_RELAY_KEY) {
    return res.status(503).json({ error: 'Relay not configured — set WSJTX_RELAY_KEY in .env' });
  }
  
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== WSJTX_RELAY_KEY) {
    return res.status(401).json({ error: 'Invalid relay key' });
  }
  
  // Session ID is required for relay — isolates data per browser
  const sessionId = req.body.session || req.headers['x-relay-session'] || '';
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = getRelaySession(sessionId);
  
  // Relay heartbeat — just registers the relay as alive for this session
  if (req.body && req.body.relay === true) {
    session.relay = {
      lastSeen: Date.now(),
      version: req.body.version || '1.0.0',
      port: req.body.port || 2237,
    };
    return res.json({ ok: true, timestamp: Date.now() });
  }
  
  // Regular message batch
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }
  
  // Update relay last seen on every batch too
  session.relay = { ...(session.relay || {}), lastSeen: Date.now() };
  
  // Rate limit: max 100 messages per request
  const batch = messages.slice(0, 100);
  let processed = 0;
  
  for (const msg of batch) {
    if (msg && typeof msg.type === 'number' && msg.id) {
      // Ensure timestamp is reasonable (within last 5 minutes or use server time)
      if (!msg.timestamp || Math.abs(Date.now() - msg.timestamp) > 5 * 60 * 1000) {
        msg.timestamp = Date.now();
      }
      handleWSJTXMessage(msg, session);
      processed++;
    }
  }
  
  res.json({ ok: true, processed, timestamp: Date.now() });
});

// API endpoint: serve raw relay.js (used by Windows .bat launcher)
app.get('/api/wsjtx/relay/agent.js', (req, res) => {
  const relayJsPath = path.join(__dirname, 'wsjtx-relay', 'relay.js');
  try {
    const content = fs.readFileSync(relayJsPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.send(content);
  } catch (e) {
    res.status(500).json({ error: 'relay.js not found on server' });
  }
});

// API endpoint: download pre-configured relay agent script
// Embeds relay.js + server URL + relay key into a one-file launcher
app.get('/api/wsjtx/relay/download/:platform', (req, res) => {
  if (!WSJTX_RELAY_KEY) {
    return res.status(503).json({ error: 'Relay not configured — set WSJTX_RELAY_KEY in .env' });
  }
  
  const platform = req.params.platform; // 'linux', 'mac', or 'windows'
  const relayJsPath = path.join(__dirname, 'wsjtx-relay', 'relay.js');
  
  let relayJs;
  try {
    relayJs = fs.readFileSync(relayJsPath, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'relay.js not found on server' });
  }
  
  // Detect server URL from request
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const serverURL = proto + '://' + host;
  
  // Session ID from query param — ties this relay to the downloading browser
  const sessionId = req.query.session || '';
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required — download from the OpenHamClock dashboard' });
  }
  
  if (platform === 'linux' || platform === 'mac') {
    // Build bash script with relay.js embedded as heredoc
    const lines = [
      '#!/bin/bash',
      '# OpenHamClock WSJT-X Relay — Auto-configured',
      '# Generated by ' + serverURL,
      '#',
      '# Usage:  bash ' + (platform === 'mac' ? 'start-relay.command' : 'start-relay.sh'),
      '# Stop:   Ctrl+C',
      '# Requires: Node.js 14+ (https://nodejs.org)',
      '#',
      '# In WSJT-X: Settings > Reporting > UDP Server',
      '#   Address: 127.0.0.1   Port: 2237',
      '',
      'set -e',
      '',
      '# Check for Node.js',
      'if ! command -v node &> /dev/null; then',
      '    echo ""',
      '    echo "Node.js is not installed."',
      '    echo "Install from https://nodejs.org (LTS recommended)"',
      '    echo ""',
      '    echo "Quick install:"',
      '    echo "  Ubuntu/Debian: sudo apt install nodejs"',
      '    echo "  Mac (Homebrew): brew install node"',
      '    echo "  Fedora: sudo dnf install nodejs"',
      '    echo ""',
      '    exit 1',
      'fi',
      '',
      '# Write relay agent to temp file',
      'RELAY_FILE=$(mktemp /tmp/ohc-relay-XXXXXX.js)',
      'trap "rm -f $RELAY_FILE" EXIT',
      '',
      "cat > \"$RELAY_FILE\" << 'OPENHAMCLOCK_RELAY_EOF'",
      relayJs,
      'OPENHAMCLOCK_RELAY_EOF',
      '',
      '# Run relay',
      'exec node "$RELAY_FILE" \\',
      '  --url "' + serverURL + '" \\',
      '  --key "' + WSJTX_RELAY_KEY + '" \\',
      '  --session "' + sessionId + '"',
    ];
    
    const script = lines.join('\n') + '\n';
    const filename = platform === 'mac' ? 'start-relay.command' : 'start-relay.sh';
    res.setHeader('Content-Type', 'application/x-sh');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    return res.send(script);
    
  } else if (platform === 'windows') {
    // .bat that auto-downloads portable Node.js if needed, then runs relay
    // No install, no admin, no PowerShell execution policy issues
    const NODE_VERSION = 'v22.13.1'; // LTS
    const NODE_ZIP = 'node-' + NODE_VERSION + '-win-x64.zip';
    const NODE_DIR = 'node-' + NODE_VERSION + '-win-x64';
    const NODE_URL = 'https://nodejs.org/dist/' + NODE_VERSION + '/' + NODE_ZIP;
    
    const batLines = [
      '@echo off',
      'setlocal',
      'title OpenHamClock WSJT-X Relay',
      'echo.',
      'echo  =========================================',
      'echo   OpenHamClock WSJT-X Relay Agent v1.0',
      'echo  =========================================',
      'echo.',
      '',
      ':: Check for Node.js (system-installed or portable)',
      'set "NODE_EXE=node"',
      'set "PORTABLE_DIR=%TEMP%\\ohc-node"',
      '',
      'where node >nul 2>nul',
      'if not errorlevel 1 (',
      '    for /f "tokens=*" %%i in (\'node -v\') do echo   Found Node.js %%i',
      '    goto :have_node',
      ')',
      '',
      ':: Check for previously downloaded portable Node.js',
      'if exist "%PORTABLE_DIR%\\' + NODE_DIR + '\\node.exe" (',
      '    set "NODE_EXE=%PORTABLE_DIR%\\' + NODE_DIR + '\\node.exe"',
      '    echo   Found portable Node.js',
      '    goto :have_node',
      ')',
      '',
      ':: Download portable Node.js',
      'echo   Node.js not found. Downloading portable version...',
      'echo   (This is a one-time ~30MB download^)',
      'echo.',
      '',
      'if not exist "%PORTABLE_DIR%" mkdir "%PORTABLE_DIR%"',
      '',
      'powershell -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri \'' + NODE_URL + '\' -OutFile \'%PORTABLE_DIR%\\' + NODE_ZIP + '\' } catch { Write-Host $_.Exception.Message; exit 1 }"',
      'if errorlevel 1 (',
      '    echo.',
      '    echo   Failed to download Node.js!',
      '    echo   Check your internet connection and try again.',
      '    echo.',
      '    pause',
      '    exit /b 1',
      ')',
      '',
      'echo   Extracting...',
      'powershell -Command "Expand-Archive -Path \'%PORTABLE_DIR%\\' + NODE_ZIP + '\' -DestinationPath \'%PORTABLE_DIR%\' -Force"',
      'if errorlevel 1 (',
      '    echo   Failed to extract Node.js!',
      '    echo.',
      '    pause',
      '    exit /b 1',
      ')',
      '',
      'del "%PORTABLE_DIR%\\' + NODE_ZIP + '" >nul 2>nul',
      'set "NODE_EXE=%PORTABLE_DIR%\\' + NODE_DIR + '\\node.exe"',
      'echo   Portable Node.js ready.',
      'echo.',
      '',
      ':have_node',
      'echo   Server: ' + serverURL,
      'echo.',
      '',
      ':: Download relay agent',
      'echo   Downloading relay agent...',
      'powershell -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri \'' + serverURL + '/api/wsjtx/relay/agent.js\' -OutFile \'%TEMP%\\ohc-relay.js\' } catch { Write-Host $_.Exception.Message; exit 1 }"',
      'if errorlevel 1 (',
      '    echo   Failed to download relay agent!',
      '    echo   Check your internet connection and try again.',
      '    echo.',
      '    pause',
      '    exit /b 1',
      ')',
      '',
      'echo   Relay agent ready.',
      'echo.',
      'echo   In WSJT-X: Settings ^> Reporting ^> UDP Server',
      'echo     Address: 127.0.0.1   Port: 2237',
      'echo.',
      'echo   Press Ctrl+C to stop',
      'echo.',
      '',
      ':: Run relay',
      '%NODE_EXE% "%TEMP%\\ohc-relay.js" --url "' + serverURL + '" --key "' + WSJTX_RELAY_KEY + '" --session "' + sessionId + '"',
      '',
      'echo.',
      'echo   Relay stopped.',
      'del "%TEMP%\\ohc-relay.js" >nul 2>nul',
      'echo.',
      'pause',
    ];
    
    const script = batLines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'application/x-msdos-program');
    res.setHeader('Content-Disposition', 'attachment; filename="start-relay.bat"');
    return res.send(script);
    
  } else {
    return res.status(400).json({ error: 'Invalid platform. Use: linux, mac, or windows' });
  }
});

// ============================================
// CATCH-ALL FOR SPA
// ============================================

app.get('*', (req, res) => {
  // Try dist first (built React app), fallback to public (monolithic)
  const distIndex = path.join(__dirname, 'dist', 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  
  const indexPath = fs.existsSync(distIndex) ? distIndex : publicIndex;
  res.sendFile(indexPath);
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║                                                       ║');
  console.log('║   ██████╗ ██████╗ ███████╗███╗   ██╗                  ║');
  console.log('║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║                  ║');
  console.log('║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║                  ║');
  console.log('║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║                  ║');
  console.log('║  ╚██████╔╝██║     ███████╗██║ ╚████║                  ║');
  console.log('║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝                  ║');
  console.log('║                                                       ║');
  console.log('║  ██╗  ██╗ █████╗ ███╗   ███╗ ██████╗██╗      ██╗  ██╗ ║');
  console.log('║  ██║  ██║██╔══██╗████╗ ████║██╔════╝██║      ██║ ██╔╝ ║');
  console.log('║  ███████║███████║██╔████╔██║██║     ██║      █████╔╝  ║');
  console.log('║  ██╔══██║██╔══██║██║╚██╔╝██║██║     ██║      ██╔═██╗  ║');
  console.log('║  ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╗███████╗██║  ██╗ ║');
  console.log('║  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ║');
  console.log('║                                                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`  🌐 OpenHamClock v${APP_VERSION}`);
  console.log(`  🌐 Server running at http://${displayHost}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`  🔗 Network access: http://<your-ip>:${PORT}`);
  }
  console.log('  📡 API proxy enabled for NOAA, POTA, SOTA, DX Cluster');
  console.log(`  📋 Log level: ${LOG_LEVEL} (set LOG_LEVEL=debug for verbose)`);
  if (WSJTX_ENABLED) {
    console.log(`  🔊 WSJT-X UDP listener on port ${WSJTX_UDP_PORT}`);
  }
  if (WSJTX_RELAY_KEY) {
    console.log(`  🔁 WSJT-X relay endpoint enabled (POST /api/wsjtx/relay)`);
  }
  if (AUTO_UPDATE_ENABLED) {
    console.log(`  🔄 Auto-update enabled every ${AUTO_UPDATE_INTERVAL_MINUTES || 60} minutes`);
  }
  console.log('  🖥️  Open your browser to start using OpenHamClock');
  console.log('');
  if (CONFIG.callsign !== 'N0CALL') {
    console.log(`  📻 Station: ${CONFIG.callsign} @ ${CONFIG.gridSquare}`);
  } else {
    console.log('  ⚠️  Configure your station in .env file');
  }
  console.log('');
  console.log('  In memory of Elwood Downey, WB0OEW');
  console.log('  73 de OpenHamClock contributors');
  console.log('');

  startAutoUpdateScheduler();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
