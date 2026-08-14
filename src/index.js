// amzinvite-api — Cloudflare Worker
//
// Endpoints exposés :
//   GET  /api/public/invitations       feed curé, requête signée HMAC (anti-scraping)
//   GET  /api/public/waves             statistiques anonymes agrégées des vagues
//   GET  /api/extension/monitoring     shard de produits Amazon à observer
//   POST /api/extension/register       délivre un credential HMAC aléatoire
//   POST /api/extension/feedback       feedback signé HMAC, depuis l'extension
//   POST /api/extension/observations   observations anonymes, depuis l'extension
//   POST /api/admin/upsert             alimenté par le job d'alimentation du catalogue
//
// Secrets requis (wrangler secret put …) :
//   ADMIN_TOKEN   : pour le endpoint /api/admin/upsert

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Instance-Id, X-Auth-Version, X-Credential-Id, X-Ts, X-Sig, X-Admin-Token",
  "Access-Control-Max-Age": "86400",
};

const HMAC_MAX_DRIFT_SEC = 300; // ±5 min
const FEED_PATH = "/api/public/invitations";
const BOOTSTRAP_PATH = "/api/extension/bootstrap";
const MONITORING_PATH = "/api/extension/monitoring";
const FEEDBACK_BATCH_PATH = "/api/extension/feedback/batch";
const DEFAULT_MONITORING_SHARD_SIZE = 20;
const MAX_MONITORING_SHARD_SIZE = 40;
const MAX_FEEDBACK_BATCH_ITEMS = 50;
const SUPPORTED_MARKETPLACES = new Set(["amazon.fr", "amazon.com.be"]);

function normalizeMarketplace(value, fallback = null) {
  const normalized = String(value || "").toLowerCase().replace(/^www\./, "");
  return SUPPORTED_MARKETPLACES.has(normalized) ? normalized : fallback;
}

function marketplaceFromItem(item) {
  const explicit = normalizeMarketplace(item?.marketplace);
  if (explicit) return explicit;
  try { return normalizeMarketplace(new URL(item?.url || item?.source_url).hostname); }
  catch { return null; }
}

function invitationUrlMatchesMarketplace(rawUrl, marketplace) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
    return url.protocol === "https:" && host === marketplace && Boolean(asin);
  } catch {
    return false;
  }
}
const MAX_EXTENSION_BODY_BYTES = 128 * 1024;
const OBSERVATION_CREDENTIAL_TTL_SEC = 48 * 60 * 60;
const DEFAULT_ADMIN_STATS_HOURS = 48;
const MAX_ADMIN_STATS_HOURS = 7 * 24;
const ADMIN_STATS_CACHE_TTL_SEC = 30 * 60;
const RAW_FEEDBACK_STATES = new Set(["available", "accepted"]);
const DEFAULT_RETENTION_DAYS = 14;
const PUBLIC_WAVES_CACHE_TTL_SEC = 5 * 60;
const PUBLIC_WAVES_CACHE_URL = "https://waves-cache.amzinvite.internal/v12";
const PARIS_TIME_ZONE = "Europe/Paris";
const CANONICAL_WAVE_SLOTS = Object.freeze([
  { weekday: 1, hour: 22, minute: 0 },
  { weekday: 5, hour: 10, minute: 0 },
]);
const WAVE_CANARY_PERCENT = 10;
const WAVE_INITIAL_SCAN_LAST_BASE_MINUTE = 28;
const WAVE_STATS_SCAN_OFFSETS_MINUTES = Object.freeze([60, 180, 360, 720, 1380]);

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function initialWaveScanOffset(instanceId) {
  const hash = stableHash(String(instanceId || ""));
  if (hash % 100 < WAVE_CANARY_PERCENT) return hash % 2;
  return 2 + (hash % (WAVE_INITIAL_SCAN_LAST_BASE_MINUTE - 1));
}

function publicWavesCacheControl(payload) {
  const hasLiveWave = Array.isArray(payload?.waves) && payload.waves.some((wave) => !wave.finalized);
  return hasLiveWave
    ? "public, max-age=30, s-maxage=60, stale-while-revalidate=60"
    : `public, max-age=300, s-maxage=${PUBLIC_WAVES_CACHE_TTL_SEC}, stale-while-revalidate=3600`;
}

function parisParts(date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: PARIS_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function parisDateTimeToEpoch(year, month, day, hour, minute) {
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  const initialParts = parisParts(new Date(wallClockUtc));
  const initialOffset = Date.UTC(
    initialParts.year, initialParts.month - 1, initialParts.day,
    initialParts.hour, initialParts.minute, initialParts.second,
  ) - wallClockUtc;
  const candidate = wallClockUtc - initialOffset;
  const corrected = parisParts(new Date(candidate));
  const correctedOffset = Date.UTC(
    corrected.year, corrected.month - 1, corrected.day,
    corrected.hour, corrected.minute, corrected.second,
  ) - candidate;
  return Math.round((wallClockUtc - correctedOffset) / 1000);
}

export function canonicalWaveSlots(nowEpoch, cutoffEpoch) {
  const now = new Date(Number(nowEpoch) * 1000);
  const current = parisParts(now);
  const parisDayUtc = Date.UTC(current.year, current.month - 1, current.day);
  const slots = [];
  for (let dayOffset = -21; dayOffset <= 1; dayOffset++) {
    const day = new Date(parisDayUtc + dayOffset * 86400000);
    for (const slot of CANONICAL_WAVE_SLOTS) {
      if (day.getUTCDay() !== slot.weekday) continue;
      const startedAt = parisDateTimeToEpoch(
        day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
        slot.hour, slot.minute,
      );
      if (startedAt <= nowEpoch && startedAt + 86400 >= cutoffEpoch) {
        slots.push({ id: String(startedAt), started_at: startedAt, ended_at: startedAt + 86400 });
      }
    }
  }
  return slots.sort((a, b) => a.started_at - b.started_at);
}

export function normalizeObservationPrice(value) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0
    ? Math.round(normalized * 100)
    : null;
}

export function normalizeObservationStock(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/api/public/invitations" && request.method === "GET") {
        return await handlePublicFeed(request, env);
      }
      if (url.pathname === "/api/public/waves" && request.method === "GET") {
        return await handlePublicWaves(env, ctx);
      }
      if (url.pathname === BOOTSTRAP_PATH && request.method === "GET") {
        return await handleExtensionBootstrap(request, env, ctx);
      }
      if (url.pathname === MONITORING_PATH && request.method === "GET") {
        return await handleMonitoringFeed(request, env);
      }
      if (url.pathname === "/api/extension/register" && request.method === "POST") {
        return await handleCredentialRegistration(request, env);
      }
      if (url.pathname === "/api/extension/feedback" && request.method === "POST") {
        return await handleFeedback(request, env);
      }
      if (url.pathname === FEEDBACK_BATCH_PATH && request.method === "POST") {
        return await handleFeedbackBatch(request, env);
      }
      if (url.pathname === "/api/extension/observations" && request.method === "POST") {
        return await handleObservations(request, env);
      }
      if (url.pathname === "/api/admin/upsert" && request.method === "POST") {
        return await handleAdminUpsert(request, env);
      }
      if (url.pathname === "/api/admin/invitations" && request.method === "GET") {
        return await handleAdminInvitations(request, env);
      }
      if (url.pathname === "/api/admin/sync" && request.method === "GET") {
        return await handleAdminSync(request, env);
      }
      if (url.pathname === "/api/admin/stats" && request.method === "GET") {
        return await handleAdminStats(request, env, ctx);
      }
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return json({ ok: true, service: "amzinvite-api" });
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "internal", detail: String(err) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env, controller?.cron || null));
  },
};

// ─────────────────────────────────────────────────────────────────────────
// GET /api/public/waves
// Statistiques strictement agrégées : aucun instance_id ne quitte D1.
// Une vague commence après au moins 36 h sans nouvelle sélection détectée et
// couvre les 24 h suivantes. Toute la fenêtre est renvoyée en une réponse pour
// que le sélecteur côté PrixTCG ne déclenche aucun nouvel appel réseau.
// ─────────────────────────────────────────────────────────────────────────
async function handlePublicWaves(env, ctx, { bypassCache = false } = {}) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(PUBLIC_WAVES_CACHE_URL);
  const cached = cache && !bypassCache ? await cache.match(cacheKey) : null;
  if (cached) {
    const cachedPayload = await cached.json();
    return json(cachedPayload, 200, {
      "Cache-Control": publicWavesCacheControl(cachedPayload),
      "X-Amzinvite-Cache": "HIT",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const retentionDays = Math.max(7, Math.min(90, Number.parseInt(env.DATA_RETENTION_DAYS || "14", 10) || 14));
  const cutoff = now - retentionDays * 86400;
  const waveSlots = canonicalWaveSlots(now, cutoff);
  const result = await env.DB.prepare(
    `WITH signal_hours AS (
       SELECT instance_id, marketplace, asin, state, hour,
              COALESCE(first_observed_at, first_received_at) AS observed_at
         FROM feedback_hourly
        WHERE state IN ('available', 'accepted') AND hour >= ?1
     ), wave_signals_by_product AS (
       SELECT instance_id, marketplace, asin, MIN(observed_at) AS signal_at
         FROM signal_hours
        GROUP BY instance_id, marketplace, asin
     ), acceptance_events AS (
       SELECT instance_id, marketplace, asin, MIN(observed_at) AS accepted_at
         FROM signal_hours
        WHERE state = 'accepted'
        GROUP BY instance_id, marketplace, asin
     ), configured_bounds AS (
       SELECT CAST(json_extract(value, '$.id') AS TEXT) AS wave_id,
              CAST(json_extract(value, '$.started_at') AS INTEGER) AS started_at,
              CAST(json_extract(value, '$.ended_at') AS INTEGER) AS ended_at
         FROM json_each(?2)
     ), wave_signals AS (
       SELECT b.wave_id, s.instance_id, s.marketplace, s.asin, s.signal_at
         FROM configured_bounds b
         JOIN wave_signals_by_product s
           ON s.signal_at >= b.started_at - 900 AND s.signal_at < b.ended_at + 10800
     ), wave_bounds AS (
       SELECT b.wave_id, b.started_at, MIN(s.signal_at) AS detected_at,
              MIN(s.signal_at) + 86400 AS ended_at
         FROM configured_bounds b
         JOIN wave_signals s ON s.wave_id = b.wave_id
        GROUP BY b.wave_id, b.started_at
       HAVING COUNT(DISTINCT s.instance_id) >= 2
     ), wave_products AS (
       SELECT DISTINCT s.wave_id, s.marketplace, s.asin
         FROM wave_bounds b
         JOIN wave_signals s ON s.wave_id = b.wave_id AND s.signal_at < b.ended_at
     ), selection_summary AS (
       SELECT b.wave_id,
              COUNT(DISTINCT a.instance_id) AS selected_users,
              COUNT(a.instance_id) AS validations
         FROM wave_bounds b
         LEFT JOIN acceptance_events a
           ON a.accepted_at >= b.started_at - 900 AND a.accepted_at < b.ended_at
        GROUP BY b.wave_id
     ), selected_product_summary AS (
       SELECT b.wave_id,
              COUNT(DISTINCT CASE WHEN a.instance_id IS NOT NULL
                THEN p.marketplace || ':' || p.asin END) AS products
         FROM wave_bounds b
         JOIN wave_products p ON p.wave_id = b.wave_id
         LEFT JOIN acceptance_events a
           ON a.marketplace = p.marketplace AND a.asin = p.asin
          AND a.accepted_at >= b.started_at - 900 AND a.accepted_at < b.ended_at
        GROUP BY b.wave_id
     ), wave_summary AS (
       SELECT b.wave_id, b.started_at, b.ended_at, b.detected_at,
              s.selected_users, s.validations,
              p.products
         FROM wave_bounds b
         JOIN selection_summary s ON s.wave_id = b.wave_id
         JOIN selected_product_summary p ON p.wave_id = b.wave_id
        GROUP BY b.wave_id, b.started_at, b.ended_at, b.detected_at,
                 s.selected_users, s.validations, p.products
     ), wave_activity AS (
       SELECT b.wave_id,
              COUNT(DISTINCT f.instance_id) AS active_users
         FROM wave_bounds b
         LEFT JOIN feedback_hourly f
           ON f.last_received_at >= b.started_at AND f.first_received_at < b.ended_at
        GROUP BY b.wave_id
     ), wave_installs AS (
       SELECT b.wave_id,
              COUNT(DISTINCT c.instance_id) AS installations
         FROM wave_bounds b
         LEFT JOIN extension_credentials c
           ON c.scope = 'instance' AND c.instance_id IS NOT NULL AND c.created_at < b.ended_at
          AND c.last_used_at - c.created_at > 3600
        GROUP BY b.wave_id
     ), product_summary AS (
       SELECT b.wave_id, p.marketplace, p.asin,
              COALESCE(i.name, m.name, p.asin) AS name,
              COUNT(DISTINCT a.instance_id) AS selected_users,
              COUNT(a.instance_id) AS validations
         FROM wave_bounds b
         JOIN wave_products p ON p.wave_id = b.wave_id
         LEFT JOIN acceptance_events a
           ON a.marketplace = p.marketplace AND a.asin = p.asin
          AND a.accepted_at >= b.started_at - 900 AND a.accepted_at < b.ended_at
         LEFT JOIN invitations i ON i.marketplace = p.marketplace AND i.asin = p.asin
         LEFT JOIN monitoring_products m ON m.marketplace = p.marketplace AND m.asin = p.asin
        GROUP BY b.wave_id, p.marketplace, p.asin, COALESCE(i.name, m.name, p.asin)
     ), eligible_summary AS (
       SELECT b.wave_id, f.marketplace, f.asin,
              COUNT(DISTINCT f.instance_id) AS eligible_users
         FROM wave_bounds b
         JOIN feedback_hourly f
           ON f.last_received_at >= b.started_at - 86400
          AND f.first_received_at < b.ended_at
          AND f.state IN ('already_requested', 'accepted')
        GROUP BY b.wave_id, f.marketplace, f.asin
     ), latest_product_images AS (
       SELECT marketplace, asin, image_url
         FROM (
           SELECT marketplace, asin, image_url,
                  ROW_NUMBER() OVER (
                    PARTITION BY marketplace, asin ORDER BY last_received_at DESC
                  ) AS rn
             FROM observations_hourly
            WHERE hour >= ?1 AND image_url IS NOT NULL AND image_url <> ''
         )
        WHERE rn = 1
     )
     SELECT s.wave_id, s.started_at, s.ended_at, s.detected_at, s.selected_users,
            s.validations, s.products, a.active_users, n.installations,
            p.marketplace, p.asin, p.name,
            p.selected_users AS product_selected_users,
            p.validations AS product_validations,
            COALESCE(e.eligible_users, p.selected_users) AS eligible_users,
            x.image_url
       FROM wave_summary s
       JOIN wave_activity a ON a.wave_id = s.wave_id
       JOIN wave_installs n ON n.wave_id = s.wave_id
       JOIN product_summary p ON p.wave_id = s.wave_id
       LEFT JOIN eligible_summary e
         ON e.wave_id = p.wave_id AND e.marketplace = p.marketplace AND e.asin = p.asin
       LEFT JOIN latest_product_images x
         ON x.marketplace = p.marketplace AND x.asin = p.asin
      ORDER BY s.started_at DESC, product_selected_users DESC, p.name`,
  ).bind(cutoff, JSON.stringify(waveSlots)).all();

  const wavesById = new Map();
  for (const row of result.results || []) {
    const id = String(row.started_at);
    let wave = wavesById.get(id);
    if (!wave) {
      const activeUsers = Number(row.active_users || 0);
      const selectedUsers = Number(row.selected_users || 0);
      wave = {
        id,
        started_at: Number(row.started_at),
        detected_at: Number(row.detected_at || row.started_at),
        ended_at: Number(row.ended_at),
        // Une vague terminée reste dynamique jusqu'à son archivage par le cron.
        // `finalized` signifie donc désormais « compteurs figés en base ».
        finalized: false,
        installations: Number(row.installations || 0),
        active_users: activeUsers,
        selected_users: selectedUsers,
        validations: Number(row.validations || 0),
        products: Number(row.products || 0),
        selection_rate: activeUsers ? selectedUsers / activeUsers : 0,
        items: [],
      };
      wavesById.set(id, wave);
    }
    const eligibleUsers = Number(row.eligible_users || 0);
    const productSelectedUsers = Number(row.product_selected_users || 0);
    wave.items.push({
      marketplace: row.marketplace,
      asin: row.asin,
      name: row.name,
      image_url: safePublicAmazonImage(row.image_url),
      selected_users: productSelectedUsers,
      validations: Number(row.product_validations || 0),
      eligible_users: eligibleUsers,
      selection_rate: eligibleUsers ? productSelectedUsers / eligibleUsers : 0,
    });
  }

  const archived = await env.DB.prepare(
    `SELECT w.id, w.started_at, w.detected_at, w.ended_at, w.installations, w.active_users,
            w.selected_users, w.validations, w.products, w.selection_rate,
            p.marketplace, p.asin, p.name, p.image_url,
            p.selected_users AS product_selected_users,
            p.validations AS product_validations,
            p.eligible_users, p.selection_rate AS product_selection_rate
       FROM invitation_waves w
       JOIN invitation_wave_products p ON p.wave_id = w.id
      ORDER BY w.started_at DESC, product_selected_users DESC, p.name`,
  ).all();
  const archivedById = new Map();
  for (const row of archived.results || []) {
    const id = String(row.id);
    let wave = archivedById.get(id);
    if (!wave) {
      wave = {
        id,
        started_at: Number(row.started_at),
        detected_at: Number(row.detected_at || row.started_at),
        ended_at: Number(row.ended_at),
        finalized: true,
        installations: Number(row.installations || 0),
        active_users: Number(row.active_users || 0),
        selected_users: Number(row.selected_users || 0),
        validations: Number(row.validations || 0),
        products: Number(row.products || 0),
        selection_rate: Number(row.selection_rate || 0),
        items: [],
      };
      archivedById.set(id, wave);
    }
    wave.items.push({
      marketplace: row.marketplace,
      asin: row.asin,
      name: row.name,
      image_url: safePublicAmazonImage(row.image_url),
      selected_users: Number(row.product_selected_users || 0),
      validations: Number(row.product_validations || 0),
      eligible_users: Number(row.eligible_users || 0),
      selection_rate: Number(row.product_selection_rate || 0),
    });
  }
  for (const [id, wave] of archivedById) {
    for (const [liveId, liveWave] of wavesById) {
      if (Math.abs(liveWave.started_at - wave.started_at) < 3 * 3600) wavesById.delete(liveId);
    }
    wavesById.set(id, wave);
  }

  const payload = {
    generated_at: now,
    window_days: retentionDays,
    methodology: "Statistiques anonymes amzinvite, dédupliquées par installation durable et ASIN. Une installation est confirmée après plus d’une heure de réutilisation du même identifiant anonyme.",
    waves: Array.from(wavesById.values()).sort((a, b) => b.started_at - a.started_at),
  };
  const responseHeaders = {
    "Cache-Control": publicWavesCacheControl(payload),
    "X-Amzinvite-Cache": "MISS",
  };
  if (cache) {
    const write = cache.put(cacheKey, json(payload, 200, responseHeaders));
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
  }
  return json(payload, 200, responseHeaders);
}

export function upcomingWaveSlots(nowEpoch, count = 6) {
  const now = new Date(Number(nowEpoch) * 1000);
  const current = parisParts(now);
  const parisDayUtc = Date.UTC(current.year, current.month - 1, current.day);
  const slots = [];
  for (let dayOffset = -4; dayOffset <= 14 && slots.length < count + 2; dayOffset++) {
    const day = new Date(parisDayUtc + dayOffset * 86400000);
    for (const slot of CANONICAL_WAVE_SLOTS) {
      if (day.getUTCDay() !== slot.weekday) continue;
      const startedAt = parisDateTimeToEpoch(
        day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
        slot.hour, slot.minute,
      );
      if (startedAt + 3 * 86400 > nowEpoch) {
        slots.push({
          id: String(startedAt),
          starts_at: startedAt,
          ends_at: startedAt + 86400,
        });
      }
    }
  }
  return slots.sort((left, right) => left.starts_at - right.starts_at).slice(0, count);
}

async function runScheduledMaintenance(env, cron = null) {
  const shouldArchive = cron == null || cron === "*/15 * * * *";
  const shouldPurge = cron == null || cron === "17 3 * * *";
  if (shouldArchive && env.WAVE_ARCHIVE_ENABLED !== "false") {
    try {
      // Le cron doit relire les compteurs courants, sans reprendre une réponse
      // publique potentiellement mise en cache juste avant la fin de vague.
      const response = await handlePublicWaves(env, {}, { bypassCache: true });
      if (response.ok) {
        const payload = await response.json();
        const archived = await persistFinalizedWaves(env, payload.waves || []);
        if (archived > 0) {
          await globalThis.caches?.default?.delete?.(new Request(PUBLIC_WAVES_CACHE_URL));
        }
      }
    } catch (error) {
      console.error("wave archive failed", error);
    }
  }
  if (shouldPurge && env.DATA_RETENTION_ENABLED !== "false") await purgeExpiredData(env);
}

export async function persistFinalizedWaves(env, waves) {
  const finalizedAt = Math.floor(Date.now() / 1000);
  let archived = 0;
  for (const wave of waves) {
    if (Number(wave.ended_at) > finalizedAt) continue;
    const existing = await env.DB.prepare(
      "SELECT 1 FROM invitation_waves WHERE id = ?1 LIMIT 1",
    ).bind(wave.id).first();
    if (existing) continue;
    const statements = [
      env.DB.prepare(
        `INSERT INTO invitation_waves
           (id, started_at, detected_at, ended_at, finalized_at, installations, active_users,
            selected_users, validations, products, selection_rate)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        wave.id, wave.started_at, wave.detected_at || wave.started_at, wave.ended_at, finalizedAt,
        wave.installations, wave.active_users, wave.selected_users,
        wave.validations, wave.products, wave.selection_rate,
      ),
      env.DB.prepare("DELETE FROM invitation_wave_products WHERE wave_id = ?1").bind(wave.id),
      ...wave.items
        .filter((item) => Number(item.selected_users) >= 1)
        .map((item) => env.DB.prepare(
          `INSERT INTO invitation_wave_products
             (wave_id, marketplace, asin, name, image_url, selected_users,
              validations, eligible_users, selection_rate)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          wave.id, item.marketplace, item.asin, item.name, item.image_url,
          item.selected_users, item.validations, item.eligible_users,
          item.selection_rate,
        )),
    ];
    await env.DB.batch(statements);
    archived += 1;
  }
  return archived;
}

function safePublicAmazonImage(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "m.media-amazon.com" && !host.endsWith(".ssl-images-amazon.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/extension/register
// Délivre un secret HMAC aléatoire. Le scope "instance" est lié à l'UUID
// anonyme de l'extension ; le scope "observations" expire rapidement et ne
// contient aucun identifiant d'installation.
// ─────────────────────────────────────────────────────────────────────────
async function handleCredentialRegistration(request, env) {
  const body = await readLimitedText(request);
  if (!body.ok) return json({ error: body.error }, body.status);

  let payload;
  try { payload = JSON.parse(body.text); }
  catch { return json({ error: "bad_json" }, 400); }

  const scope = payload?.scope;
  if (!["instance", "observations"].includes(scope)) {
    return json({ error: "bad_scope" }, 400);
  }

  const instanceId = scope === "instance" ? payload.instanceId : null;
  if (scope === "instance" && !/^[0-9a-f-]{32,40}$/i.test(instanceId || "")) {
    return json({ error: "bad_instance_id" }, 400);
  }

  const registrationLimit = await env.REGISTRATION_RATE_LIMITER.limit({
    key: request.headers.get("CF-Connecting-IP") || "unknown",
  });
  if (!registrationLimit.success) {
    return json({ error: "rate_limit" }, 429);
  }

  const credentialId = crypto.randomUUID();
  const secret = randomBase64Url(32);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = scope === "observations" ? now + OBSERVATION_CREDENTIAL_TTL_SEC : null;
  // Les clients renouvellent 6 h avant l'échéance ; la purge ne supprime donc
  // aucun credential actif et empêche la table de croître indéfiniment.
  await env.DB.prepare(
    `DELETE FROM extension_credentials
     WHERE expires_at IS NOT NULL
       AND expires_at <= ?`,
  ).bind(now).run();
  await env.DB.prepare(
    `INSERT INTO extension_credentials
       (credential_id, secret, scope, instance_id, created_at, expires_at, last_used_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
  ).bind(credentialId, secret, scope, instanceId, now, expiresAt).run();

  return json({
    scope,
    credentialId,
    secret,
    expiresAt: expiresAt == null ? null : expiresAt * 1000,
  }, 201, { "Cache-Control": "no-store" });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/public/invitations
// ─────────────────────────────────────────────────────────────────────────
async function handlePublicFeed(request, env) {
  // Le feed expose la liste curée d'ASIN/URL : on exige une requête signée
  // par l'extension (même schéma HMAC que le feedback) pour éviter qu'un
  // simple `curl` de l'URL ne récupère la liste. La signature porte sur le
  // path (pas de body en GET). Le secret reste extractible côté navigateur,
  // mais ça bloque le scraping anonyme trivial.
  //
  // Période de grâce : tant que FEED_AUTH_ENFORCE !== "true", on n'échoue pas
  // sur une requête non signée (extension < 0.1.14 encore déployée).
  const enforce = env.FEED_AUTH_ENFORCE === "true";
  const auth = await checkFeedAuth(request, env);
  if (!auth.ok && enforce) {
    return json({ error: auth.error }, 401);
  }

  const feedLimit = await env.FEED_RATE_LIMITER.limit({
    key: request.headers.get("X-Instance-Id")
      || request.headers.get("CF-Connecting-IP")
      || "unknown",
  });
  if (!feedLimit.success) {
    return json({ error: "rate_limit" }, 429);
  }

  const url = new URL(request.url);
  const rawMarketplaces = (url.searchParams.get("marketplaces") || "amazon.fr").split(",");
  const requested = rawMarketplaces.map((value) => normalizeMarketplace(value));
  if (requested.some((value) => !value)) return json({ error: "bad_marketplaces" }, 400);
  const marketplaces = [...new Set(requested)];
  if (!marketplaces.length) return json({ error: "bad_marketplaces" }, 400);
  const placeholders = marketplaces.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT asin, url, name, marketplace, first_seen, is_mirror
     FROM invitations
     WHERE active = 1 AND marketplace IN (${placeholders})
     ORDER BY first_seen DESC
     LIMIT 200`,
  ).bind(...marketplaces).all();
  return new Response(JSON.stringify(result.results || []), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // Réponse signée/par-instance : surtout pas de cache CDN partagé,
      // sinon Cloudflare resservirait le JSON en clair sans vérifier la
      // signature (le cache ne varie pas sur les en-têtes).
      "Cache-Control": "no-store",
    },
  });
}

async function handleAdminInvitations(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN || "")) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const marketplace = normalizeMarketplace(url.searchParams.get("marketplace") || "amazon.fr");
  if (!marketplace) return json({ error: "bad_marketplace" }, 400);
  const result = await env.DB.prepare(
    `SELECT asin, url, name, marketplace, first_seen, is_mirror
       FROM invitations
      WHERE active = 1 AND marketplace = ?1
      ORDER BY first_seen DESC`,
  ).bind(marketplace).all();
  return json(result.results || [], 200, { "Cache-Control": "private, no-store" });
}

async function handleExtensionBootstrap(request, env, ctx) {
  const auth = await checkFeedAuth(request, env, BOOTSTRAP_PATH);
  if (!auth.ok) return json({ error: auth.error }, 401);

  const instanceId = request.headers.get("X-Instance-Id");
  const feedLimit = await env.FEED_RATE_LIMITER.limit({ key: instanceId });
  if (!feedLimit.success) return json({ error: "rate_limit" }, 429);

  const url = new URL(request.url);
  const rawMarketplaces = (url.searchParams.get("marketplaces") || "amazon.fr").split(",");
  const requested = rawMarketplaces.map((value) => normalizeMarketplace(value));
  if (requested.some((value) => !value)) return json({ error: "bad_marketplaces" }, 400);
  const marketplaces = [...new Set(requested)];
  const placeholders = marketplaces.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT asin, url, name, marketplace, first_seen, is_mirror
       FROM invitations
      WHERE active = 1 AND marketplace IN (${placeholders})
      ORDER BY first_seen DESC
      LIMIT 200`,
  ).bind(...marketplaces).all();

  const wavesResponse = await handlePublicWaves(env, ctx);
  const wavesPayload = wavesResponse.ok ? await wavesResponse.json() : { waves: [] };
  const now = Math.floor(Date.now() / 1000);
  const invitations = result.results || [];
  const latestFinalizedWave = (wavesPayload.waves || []).find((wave) => wave.finalized) || null;
  let feedHash = 0x811c9dc5;
  for (const item of invitations) {
    const value = `${item.marketplace}:${item.asin}:${item.first_seen || 0}|`;
    for (let index = 0; index < value.length; index++) {
      feedHash ^= value.charCodeAt(index);
      feedHash = Math.imul(feedHash, 0x01000193);
    }
  }
  const feedRevision = (feedHash >>> 0).toString(16).padStart(8, "0");

  return json({
    schema_version: 1,
    generated_at: now,
    feed_revision: feedRevision,
    invitations,
    schedule: {
      version: "2026-08-14.2",
      timezone: PARIS_TIME_ZONE,
      waves: upcomingWaveSlots(now),
      // Un seul premier scan par installation entre T+0 et T+29. Environ 10 %
      // des installations servent de canaris pendant les deux premières minutes;
      // les autres sont réparties de façon stable jusqu'à T+29. Les scans plus
      // espacés alimentent ensuite les statistiques sur les 24 h de la vague.
      scan_offsets_minutes: [
        initialWaveScanOffset(instanceId),
        ...WAVE_STATS_SCAN_OFFSETS_MINUTES,
      ],
      jitter_minutes: 1,
      sync_interval_minutes: 360,
      custom_interval_minutes: 360,
    },
    latest_finalized_wave: latestFinalizedWave,
  }, 200, { "Cache-Control": "private, no-store" });
}

function monitoringAssignmentScore(instanceId, item) {
  const value = `${instanceId}:${item.marketplace}:${item.asin}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// GET /api/extension/monitoring
// Retourne un petit shard stable par installation. Avec plusieurs centaines
// de clients, chaque URL PrixTCG est ainsi relue par plusieurs navigateurs
// sans faire scanner l'intégralité du catalogue à chacun.
async function handleMonitoringFeed(request, env) {
  const auth = await checkFeedAuth(request, env, MONITORING_PATH);
  if (!auth.ok) return json({ error: auth.error }, 401);

  const instanceId = request.headers.get("X-Instance-Id");
  const limitResult = await env.FEED_RATE_LIMITER.limit({ key: instanceId });
  if (!limitResult.success) return json({ error: "rate_limit" }, 429);

  const url = new URL(request.url);
  const rawMarketplaces = (url.searchParams.get("marketplaces") || "amazon.fr").split(",");
  const requested = rawMarketplaces.map((value) => normalizeMarketplace(value));
  if (requested.some((value) => !value)) return json({ error: "bad_marketplaces" }, 400);
  const marketplaces = [...new Set(requested)];
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_MONITORING_SHARD_SIZE, Math.max(1, rawLimit))
    : DEFAULT_MONITORING_SHARD_SIZE;
  const placeholders = marketplaces.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT asin, url, name, marketplace
       FROM monitoring_products
      WHERE active = 1 AND marketplace IN (${placeholders})
      LIMIT 2000`,
  ).bind(...marketplaces).all();
  const assigned = (result.results || [])
    .map((item) => ({ ...item, monitor_only: true }))
    .sort((left, right) => (
      monitoringAssignmentScore(instanceId, left)
      - monitoringAssignmentScore(instanceId, right)
    ))
    .slice(0, limit);
  return new Response(JSON.stringify(assigned), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/extension/feedback
// Headers: X-Instance-Id, X-Ts, X-Sig
// Body: { asin, state, source, observedAt }
// ─────────────────────────────────────────────────────────────────────────
async function handleFeedback(request, env) {
  const instanceId = request.headers.get("X-Instance-Id");
  if (!instanceId || !/^[0-9a-f-]{32,40}$/i.test(instanceId)) {
    return json({ error: "bad_instance_id" }, 400);
  }

  const body = await readLimitedText(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const bodyText = body.text;
  const verified = await verifyExtensionHmac(request, bodyText, env, {
    scope: "instance",
    instanceId,
  });
  if (!verified.ok) {
    return json({ error: verified.error }, request.headers.get("X-Auth-Version") === "2" ? 401 : 400);
  }

  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { return json({ error: "bad_json" }, 400); }

  const normalized = normalizeFeedbackItem(payload);
  if (!normalized.ok) return json({ error: normalized.error }, 400);

  const instanceLimit = await env.FEEDBACK_RATE_LIMITER.limit({ key: instanceId });
  if (!instanceLimit.success) {
    return json({ error: "rate_limit" }, 429);
  }

  const statements = feedbackStatements(env, instanceId, [normalized.item]);
  await env.DB.batch(statements);

  return json({ ok: true });
}

async function handleFeedbackBatch(request, env) {
  const instanceId = request.headers.get("X-Instance-Id");
  if (!instanceId || !/^[0-9a-f-]{32,40}$/i.test(instanceId)) {
    return json({ error: "bad_instance_id" }, 400);
  }
  const body = await readLimitedText(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const verified = await verifyExtensionHmac(request, body.text, env, { scope: "instance", instanceId });
  if (!verified.ok) {
    return json({ error: verified.error }, request.headers.get("X-Auth-Version") === "2" ? 401 : 400);
  }
  let payload;
  try { payload = JSON.parse(body.text); }
  catch { return json({ error: "bad_json" }, 400); }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ error: "empty_items" }, 400);
  }
  if (payload.items.length > MAX_FEEDBACK_BATCH_ITEMS) {
    return json({ error: "too_many_items" }, 400);
  }
  const normalizedItems = [];
  for (const item of payload.items) {
    const normalized = normalizeFeedbackItem(item);
    if (!normalized.ok) return json({ error: normalized.error }, 400);
    normalizedItems.push(normalized.item);
  }
  const instanceLimit = await env.FEEDBACK_RATE_LIMITER.limit({ key: instanceId });
  if (!instanceLimit.success) return json({ error: "rate_limit" }, 429);
  const statements = feedbackStatements(env, instanceId, normalizedItems);
  await env.DB.batch(statements);
  return json({ ok: true, accepted: normalizedItems.length });
}

function normalizeFeedbackItem(payload) {
  const marketplace = payload?.marketplace == null
    ? "amazon.fr"
    : normalizeMarketplace(payload.marketplace);
  if (!marketplace) return { ok: false, error: "bad_marketplace" };
  if (!payload?.asin || !/^[A-Z0-9]{10}$/i.test(payload.asin)) {
    return { ok: false, error: "bad_asin" };
  }
  if (!["available", "already_requested", "accepted", "not_invitation", "stub_no_data"].includes(payload.state)) {
    return { ok: false, error: "bad_state" };
  }
  return {
    ok: true,
    item: {
      marketplace,
      asin: payload.asin.toUpperCase(),
      state: payload.state,
      source: payload.source || "",
      observedAt: Number(payload.observedAt) || null,
    },
  };
}

function feedbackStatements(env, instanceId, items) {
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3600) * 3600;
  const statements = [];
  for (const item of items) {
    statements.push(env.DB.prepare(
    `INSERT OR IGNORE INTO feedback_hourly
       (hour, instance_id, marketplace, asin, state, source,
        first_observed_at, last_observed_at, first_received_at, last_received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    hour,
    instanceId,
    item.marketplace,
    item.asin,
    item.state,
    item.source,
    item.observedAt,
    item.observedAt,
    now,
    now,
  ));

  if (RAW_FEEDBACK_STATES.has(item.state) || item.source === "auto_request") {
    statements.push(env.DB.prepare(
      `INSERT INTO extension_feedback
         (instance_id, marketplace, asin, state, source, observed_at, received_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      instanceId,
      item.marketplace,
      item.asin,
      item.state,
      item.source || null,
      item.observedAt,
      now,
      null,
    ));
  }
  }
  return statements;
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/extension/observations
// Anonyme : pas d'instance_id. Headers: X-Ts, X-Sig
// Body: { items: [{ asin, name, price, in_stock, stock_status, ... }], dayBucket }
// ─────────────────────────────────────────────────────────────────────────
async function handleObservations(request, env) {
  const body = await readLimitedText(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const bodyText = body.text;
  const verified = await verifyExtensionHmac(request, bodyText, env, {
    scope: "observations",
  });
  if (!verified.ok) {
    return json({ error: verified.error }, request.headers.get("X-Auth-Version") === "2" ? 401 : 400);
  }

  const observationLimit = await env.OBSERVATION_RATE_LIMITER.limit({
    key: request.headers.get("X-Credential-Id")
      || request.headers.get("CF-Connecting-IP")
      || "unknown",
  });
  if (!observationLimit.success) {
    return json({ error: "rate_limit" }, 429);
  }

  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { return json({ error: "bad_json" }, 400); }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ error: "empty_items" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  // Dédoublonner par marketplace + ASIN — garder le dernier item de chaque produit local.
  const seen = new Map();
  for (const it of payload.items.slice(0, 100)) {
    const asin = (it.external_id || it.asin || "").toUpperCase();
    const marketplace = marketplaceFromItem(it);
    if (marketplace && /^[A-Z0-9]{10}$/i.test(asin)) seen.set(`${marketplace}:${asin}`, { ...it, marketplace });
  }
  const acceptedItems = Array.from(seen.values());
  if (acceptedItems.length === 0) {
    return json({ ok: true, inserted: 0, deduped: payload.items.length });
  }

  const hour = Math.floor(now / 3600) * 3600;
  const stmts = acceptedItems.map((it) => env.DB.prepare(
    `INSERT INTO observations_hourly
       (hour, marketplace, asin, name, price_cents, in_stock, stock_status,
        image_url, day_bucket, first_received_at, last_received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hour, marketplace, asin) DO UPDATE SET
       name = excluded.name,
       price_cents = excluded.price_cents,
       in_stock = excluded.in_stock,
       stock_status = excluded.stock_status,
       image_url = excluded.image_url,
       day_bucket = excluded.day_bucket,
       last_received_at = excluded.last_received_at
     WHERE observations_hourly.name IS NOT excluded.name
        OR observations_hourly.price_cents IS NOT excluded.price_cents
        OR observations_hourly.in_stock IS NOT excluded.in_stock
        OR observations_hourly.stock_status IS NOT excluded.stock_status
        OR observations_hourly.image_url IS NOT excluded.image_url`,
  ).bind(
    hour,
    it.marketplace,
    (it.external_id || it.asin || "").toUpperCase(),
    it.name || null,
    normalizeObservationPrice(it.price),
    normalizeObservationStock(it.in_stock),
    it.stock_status || null,
    it.image_url || null,
    payload.dayBucket || null,
    now,
    now,
  ));
  await env.DB.batch(stmts);

  return json({
    ok: true,
    inserted: stmts.length,
    deduped: payload.items.length - acceptedItems.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/admin/upsert
// Pour le job d'alimentation qui pousse les produits en mode invitation.
// Headers: X-Admin-Token: <ADMIN_TOKEN secret>
// Body: { invitations: [{ asin, url, name, marketplace, first_seen, active }] }
// ─────────────────────────────────────────────────────────────────────────
async function handleAdminUpsert(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN || "")) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }
  if (!Array.isArray(payload.invitations)) {
    return json({ error: "expected_invitations_array" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const normalizedInvitations = payload.invitations
    .filter((inv) => inv?.asin)
    .map((inv) => ({
      ...inv,
      asin: String(inv.asin).toUpperCase(),
      marketplace: inv.marketplace == null ? "amazon.fr" : normalizeMarketplace(inv.marketplace),
      first_seen: inv.first_seen != null
        && inv.first_seen !== ""
        && Number.isFinite(Number(inv.first_seen))
        ? Number(inv.first_seen)
        : null,
    }));
  const hasMonitoringSnapshot = Array.isArray(payload.monitoring_products);
  const normalizedMonitoring = hasMonitoringSnapshot
    ? payload.monitoring_products
      .filter((item) => item?.asin)
      .map((item) => ({
        ...item,
        asin: String(item.asin).toUpperCase(),
        marketplace: item.marketplace == null
          ? "amazon.fr"
          : normalizeMarketplace(item.marketplace),
      }))
    : [];
  // Upsert : si alerter fournit first_seen, il devient la source canonique.
  // Sinon on conserve le first_seen déjà stocké, avec fallback sur now.
  if (normalizedInvitations.some((inv) => (
    !inv.marketplace
    || !/^[A-Z0-9]{10}$/.test(inv.asin)
    || !invitationUrlMatchesMarketplace(inv.url, inv.marketplace)
  ))) {
    return json({ error: "bad_invitation" }, 400);
  }
  if (normalizedMonitoring.some((item) => (
    !item.marketplace
    || !/^[A-Z0-9]{10}$/.test(item.asin)
    || !invitationUrlMatchesMarketplace(item.url, item.marketplace)
  ))) {
    return json({ error: "bad_monitoring_product" }, 400);
  }
  const rawMonitoringScopes = hasMonitoringSnapshot
    ? (Array.isArray(payload.monitoring_marketplaces)
      ? payload.monitoring_marketplaces
      : [...new Set(normalizedMonitoring.map((item) => item.marketplace))])
    : [];
  const monitoringScopes = rawMonitoringScopes.map((value) => normalizeMarketplace(value));
  if (monitoringScopes.some((marketplace) => !marketplace)) {
    return json({ error: "bad_monitoring_marketplaces" }, 400);
  }
  const rawScopes = Array.isArray(payload.marketplaces) ? payload.marketplaces : null;
  const scopes = rawScopes
    ? rawScopes.map((value) => normalizeMarketplace(value))
    : [...new Set(normalizedInvitations.map((inv) => inv.marketplace))];
  if (scopes.some((marketplace) => !marketplace)) {
    return json({ error: "bad_marketplaces" }, 400);
  }
  const stmts = normalizedInvitations.map((inv) => env.DB.prepare(
    `INSERT INTO invitations (asin, url, name, marketplace, first_seen, last_updated, active, is_mirror)
     VALUES (?, ?, ?, ?, COALESCE(?, (SELECT first_seen FROM invitations WHERE marketplace = ? AND asin = ?), ?), ?, ?, ?)
     ON CONFLICT(marketplace, asin) DO UPDATE SET
       first_seen = excluded.first_seen,
       url = excluded.url,
       name = excluded.name,
       marketplace = excluded.marketplace,
       last_updated = excluded.last_updated,
       active = excluded.active,
       is_mirror = excluded.is_mirror
     WHERE invitations.first_seen IS NOT excluded.first_seen
        OR invitations.url IS NOT excluded.url
        OR invitations.name IS NOT excluded.name
        OR invitations.marketplace IS NOT excluded.marketplace
        OR invitations.active IS NOT excluded.active
        OR invitations.is_mirror IS NOT excluded.is_mirror`,
  ).bind(
    inv.asin,
    inv.url,
    inv.name || null,
    inv.marketplace || "amazon.fr",
    inv.first_seen,
    inv.marketplace,
    inv.asin,
    now,
    now,
    inv.active === false ? 0 : 1,
    inv.is_mirror === true ? 1 : 0,
  ));
  for (let offset = 0; offset < stmts.length; offset += 100) {
    await env.DB.batch(stmts.slice(offset, offset + 100));
  }

  for (const marketplace of scopes) {
    const asins = normalizedInvitations.filter((inv) => inv.marketplace === marketplace).map((inv) => inv.asin);
    const statement = asins.length
      ? env.DB.prepare(`UPDATE invitations SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1 AND asin NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))`).bind(now, marketplace, JSON.stringify(asins))
      : env.DB.prepare("UPDATE invitations SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1").bind(now, marketplace);
    await statement.run();
  }

  const monitoringStatements = normalizedMonitoring.map((item) => env.DB.prepare(
    `INSERT INTO monitoring_products
       (asin, url, name, marketplace, last_updated, active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(marketplace, asin) DO UPDATE SET
       url = excluded.url,
       name = excluded.name,
       last_updated = excluded.last_updated,
       active = excluded.active
     WHERE monitoring_products.url IS NOT excluded.url
        OR monitoring_products.name IS NOT excluded.name
        OR monitoring_products.active IS NOT excluded.active`,
  ).bind(
    item.asin,
    item.url,
    item.name || null,
    item.marketplace,
    now,
    item.active === false ? 0 : 1,
  ));
  for (let offset = 0; offset < monitoringStatements.length; offset += 100) {
    await env.DB.batch(monitoringStatements.slice(offset, offset + 100));
  }

  if (hasMonitoringSnapshot) {
    for (const marketplace of monitoringScopes) {
      const asins = normalizedMonitoring
        .filter((item) => item.marketplace === marketplace)
        .map((item) => item.asin);
      const statement = asins.length
        ? env.DB.prepare(`UPDATE monitoring_products SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1 AND asin NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))`).bind(now, marketplace, JSON.stringify(asins))
        : env.DB.prepare("UPDATE monitoring_products SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1").bind(now, marketplace);
      await statement.run();
    }
  }

  return json({
    ok: true,
    upserted: stmts.length,
    monitoring_upserted: monitoringStatements.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/admin/sync
// Expose uniquement les nouvelles observations depuis le curseur local PrixTCG.
// Headers: X-Admin-Token: <ADMIN_TOKEN secret>
// Query:   ?since=<epoch_seconds>  (défaut: dernières 24h)
// ─────────────────────────────────────────────────────────────────────────
async function handleAdminSync(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN || "")) {
    return json({ error: "unauthorized" }, 401);
  }

  const sinceParam = new URL(request.url).searchParams.get("since");
  const since = sinceParam ? parseInt(sinceParam, 10) : Math.floor(Date.now() / 1000) - 86400;

  // Une seule lecture de la fenêtre incrémentale indexée. PrixTCG conserve
  // localement le dernier prix connu lorsqu'une observation n'en contient pas,
  // donc aucune seconde recherche corrélée par ASIN n'est nécessaire ici.
  const obsResult = await env.DB.prepare(
    `WITH observation_cutover AS (
       SELECT MIN(hour) AS first_hour FROM observations_hourly
     ), combined AS (
       SELECT asin, name, price_cents, in_stock, stock_status, image_url,
              marketplace, last_received_at AS last_seen
         FROM observations_hourly
        WHERE last_received_at > ?1
       UNION ALL
       SELECT asin, name, price_cents, in_stock, stock_status, image_url,
              marketplace, received_at AS last_seen
         FROM observations
        WHERE received_at > ?1
          AND received_at < COALESCE(
            (SELECT first_hour FROM observation_cutover),
            9223372036854775807
          )
     )
     SELECT asin, name, price_cents, in_stock, stock_status, image_url,
            marketplace, last_seen
       FROM (
         SELECT combined.*,
                ROW_NUMBER() OVER (
                  PARTITION BY marketplace, asin
                  ORDER BY last_seen DESC
                ) AS rn
           FROM combined
       )
      WHERE rn = 1
      ORDER BY last_seen DESC
      LIMIT 2000`,
  ).bind(since).all();

  return json({
    feedback: [],
    observations: obsResult.results || [],
    since,
    generated_at: Math.floor(Date.now() / 1000),
  });
}

async function purgeExpiredData(env) {
  const configuredDays = Number.parseInt(env.DATA_RETENTION_DAYS || "", 10);
  const retentionDays = Number.isFinite(configuredDays)
    ? Math.max(7, Math.min(90, configuredDays))
    : DEFAULT_RETENTION_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const cutoffHour = Math.floor(cutoff / 3600) * 3600;

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM extension_feedback
        WHERE id IN (
          SELECT id FROM extension_feedback
           WHERE received_at < ?
           ORDER BY received_at
           LIMIT 5000
        )`,
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM feedback_hourly WHERE hour < ?").bind(cutoffHour),
    env.DB.prepare(
      `DELETE FROM observations
        WHERE id IN (
          SELECT id FROM observations
           WHERE received_at < ?
           ORDER BY received_at
           LIMIT 5000
        )`,
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM observations_hourly WHERE hour < ?").bind(cutoffHour),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
// Agrégats anonymes horaires destinés au cockpit admin PrixTCG.
// Headers: X-Admin-Token: <ADMIN_TOKEN secret>
// Query:   ?hours=48  (1 h à 7 jours, 48 h par défaut)
//          &fresh=1   contourne une fois le cache admin et le remplace
// ─────────────────────────────────────────────────────────────────────────
async function handleAdminStats(request, env, ctx) {
  const token = request.headers.get("X-Admin-Token");
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN || "")) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const rawHours = Number.parseInt(url.searchParams.get("hours") || "", 10);
  const forceRefresh = ["1", "true"].includes(
    url.searchParams.get("fresh")?.toLowerCase() || "",
  );
  const hours = Number.isFinite(rawHours)
    ? Math.min(MAX_ADMIN_STATS_HOURS, Math.max(1, rawHours))
    : DEFAULT_ADMIN_STATS_HOURS;

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://stats-cache.amzinvite.internal/?hours=${hours}`);
  const cached = !forceRefresh && cache ? await cache.match(cacheKey) : null;
  if (cached) {
    return json(await cached.json(), 200, {
      "Cache-Control": "private, max-age=300",
      "X-Amzinvite-Cache": "HIT",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const currentHour = Math.floor(now / 3600) * 3600;
  const startHour = currentHour - (hours - 1) * 3600;
  const trailing24h = now - 24 * 3600;

  const [summaryResult, installsResult, feedbackResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH installs AS (
         SELECT instance_id,
                MIN(created_at) AS first_created,
                MAX(COALESCE(last_used_at, 0)) AS last_used
           FROM extension_credentials
          WHERE scope = 'instance'
            AND instance_id IS NOT NULL
          GROUP BY instance_id
       ), feedback_cutover AS (
         SELECT MIN(hour) AS first_hour FROM feedback_hourly
       ), feedback_24h_rows AS (
         SELECT instance_id, state, source
           FROM feedback_hourly
          WHERE last_received_at >= ?1
         UNION ALL
         SELECT instance_id, state, COALESCE(source, '')
           FROM extension_feedback
          WHERE received_at >= ?1
            AND received_at < COALESCE(
              (SELECT first_hour FROM feedback_cutover),
              9223372036854775807
            )
       ), feedback_24h AS (
         SELECT COUNT(DISTINCT instance_id) AS scanning_users_24h,
                COUNT(DISTINCT CASE WHEN source = 'auto_request' THEN instance_id END) AS auto_request_users_24h,
                COUNT(DISTINCT CASE WHEN state = 'accepted' THEN instance_id END) AS accepted_users_24h,
                COUNT(*) AS feedback_events_24h
           FROM feedback_24h_rows
       )
       SELECT
         (SELECT COUNT(*) FROM installs) AS installations_seen,
         (SELECT COUNT(*) FROM installs
           WHERE last_used - first_created > 3600) AS durable_installations_seen,
         (SELECT COUNT(*) FROM installs
           WHERE last_used - first_created <= 3600) AS unconfirmed_installations_seen,
         (SELECT COUNT(*) FROM installs WHERE first_created >= ?1) AS new_installations_24h,
         (SELECT COUNT(*) FROM installs
           WHERE first_created >= ?1
             AND last_used - first_created > 3600) AS new_durable_installations_24h,
         (SELECT COUNT(*) FROM extension_auth_activity WHERE last_seen >= ?1) AS feed_active_24h,
         feedback_24h.scanning_users_24h,
         feedback_24h.auto_request_users_24h,
         feedback_24h.accepted_users_24h,
         feedback_24h.feedback_events_24h,
         0 AS observations_24h,
         0 AS observed_asins_24h,
         0 AS feed_requests_24h
       FROM feedback_24h`,
    ).bind(trailing24h),
    env.DB.prepare(
      `WITH installs AS (
         SELECT instance_id,
                MIN(created_at) AS first_created,
                MAX(COALESCE(last_used_at, 0)) AS last_used
           FROM extension_credentials
          WHERE scope = 'instance'
            AND instance_id IS NOT NULL
          GROUP BY instance_id
       )
       SELECT CAST(first_created / 3600 AS INTEGER) * 3600 AS hour,
              COUNT(*) AS new_installations,
              COUNT(CASE WHEN last_used - first_created > 3600 THEN 1 END)
                AS new_durable_installations
         FROM installs
        WHERE first_created >= ?1
        GROUP BY hour
        ORDER BY hour`,
    ).bind(startHour),
    env.DB.prepare(
      `WITH feedback_cutover AS (
         SELECT MIN(hour) AS first_hour FROM feedback_hourly
       ), feedback_rows AS (
         SELECT hour, instance_id, state, source
           FROM feedback_hourly
          WHERE hour >= ?1
         UNION ALL
         SELECT CAST(received_at / 3600 AS INTEGER) * 3600,
                instance_id,
                state,
                COALESCE(source, '')
           FROM extension_feedback
          WHERE received_at >= ?1
            AND received_at < COALESCE(
              (SELECT first_hour FROM feedback_cutover),
              9223372036854775807
            )
       )
       SELECT hour,
              COUNT(DISTINCT instance_id) AS scanning_users,
              COUNT(*) AS feedback_events,
              COUNT(DISTINCT CASE WHEN source = 'auto_request' THEN instance_id END) AS auto_request_users,
              COUNT(DISTINCT CASE WHEN state = 'accepted' THEN instance_id END) AS accepted_users
         FROM feedback_rows
        GROUP BY hour
        ORDER BY hour`,
    ).bind(startHour),
  ]);

  const hourly = Array.from({ length: hours }, (_, index) => ({
    hour: startHour + index * 3600,
    new_installations: 0,
    new_durable_installations: 0,
    scanning_users: 0,
    feedback_events: 0,
    auto_request_users: 0,
    accepted_users: 0,
    observations: 0,
    distinct_asins: 0,
    feed_requests: 0,
  }));
  const byHour = new Map(hourly.map((row) => [row.hour, row]));
  const mergeRows = (result, fields) => {
    for (const source of result.results || []) {
      const target = byHour.get(Number(source.hour));
      if (!target) continue;
      for (const field of fields) target[field] = Number(source[field] || 0);
    }
  };
  mergeRows(installsResult, ["new_installations", "new_durable_installations"]);
  mergeRows(feedbackResult, ["scanning_users", "feedback_events", "auto_request_users", "accepted_users"]);

  const summarySource = summaryResult.results?.[0] || {};
  const summary = Object.fromEntries([
    "installations_seen",
    "durable_installations_seen",
    "unconfirmed_installations_seen",
    "new_installations_24h",
    "new_durable_installations_24h",
    "feed_active_24h",
    "scanning_users_24h",
    "auto_request_users_24h",
    "accepted_users_24h",
    "feedback_events_24h",
    "observations_24h",
    "observed_asins_24h",
    "feed_requests_24h",
  ].map((field) => [field, Number(summarySource[field] || 0)]));

  const payload = {
    generated_at: now,
    window_hours: hours,
    summary,
    hourly,
  };

  if (cache) {
    const cacheWrite = cache.put(cacheKey, json(payload, 200, {
      "Cache-Control": `public, max-age=${ADMIN_STATS_CACHE_TTL_SEC}`,
    }));
    if (ctx?.waitUntil) ctx.waitUntil(cacheWrite);
    else await cacheWrite;
  }

  return json(payload, 200, {
    "Cache-Control": forceRefresh ? "private, no-store" : "private, max-age=300",
    "X-Amzinvite-Cache": forceRefresh ? "BYPASS" : "MISS",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────

async function readLimitedText(request, maxBytes = MAX_EXTENSION_BODY_BYTES) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  return { ok: true, text };
}

async function checkFeedAuth(request, env, signedPath = FEED_PATH) {
  const instanceId = request.headers.get("X-Instance-Id");
  if (!instanceId || !/^[0-9a-f-]{32,40}$/i.test(instanceId)) {
    return { ok: false, error: "bad_instance_id" };
  }
  const url = new URL(request.url);
  const payload = url.search ? `${signedPath}${url.search}` : signedPath;
  const auth = await verifyExtensionHmac(request, payload, env, {
    scope: "instance",
    instanceId,
  });
  if (auth.ok) {
    await recordAuthActivity(env, instanceId, auth.version || 1);
  }
  return auth;
}

async function recordAuthActivity(env, instanceId, authVersion) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO extension_auth_activity (instance_id, auth_version, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       auth_version = excluded.auth_version,
       last_seen = excluded.last_seen
     WHERE extension_auth_activity.auth_version != excluded.auth_version
        OR extension_auth_activity.last_seen < ?`,
  ).bind(instanceId, authVersion, now, now - 3600).run();
}

async function verifyExtensionHmac(request, bodyText, env, { scope, instanceId = null }) {
  const authVersion = request.headers.get("X-Auth-Version");
  const credentialId = request.headers.get("X-Credential-Id");
  if (authVersion === "2" || credentialId) {
    if (authVersion !== "2" || !/^[0-9a-f-]{36}$/i.test(credentialId || "")) {
      return { ok: false, error: "bad_v2_headers" };
    }
    const credential = await env.DB.prepare(
      `SELECT secret, scope, instance_id, expires_at, revoked
       FROM extension_credentials
       WHERE credential_id = ?`,
    ).bind(credentialId).first();
    if (!credential || credential.revoked) {
      return { ok: false, error: "unknown_credential" };
    }
    if (credential.scope !== scope || (instanceId && credential.instance_id !== instanceId)) {
      return { ok: false, error: "credential_scope_mismatch" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (credential.expires_at != null && credential.expires_at <= now) {
      return { ok: false, error: "expired_credential" };
    }
    const verified = await verifyHmacWithSecret(request, bodyText, credential.secret);
    if (!verified.ok) return verified;
    await env.DB.prepare(
      `UPDATE extension_credentials
       SET last_used_at = ?
       WHERE credential_id = ?
         AND (last_used_at IS NULL OR last_used_at < ?)`,
    ).bind(now, credentialId, now - 3600).run();
    return { ok: true, version: 2 };
  }

  return { ok: false, error: "legacy_auth_disabled" };
}

async function verifyHmacWithSecret(request, bodyText, secret) {
  const sig = request.headers.get("X-Sig");
  const ts = request.headers.get("X-Ts");
  if (!sig || !ts) return { ok: false, error: "missing_hmac_headers" };

  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (Number.isNaN(tsNum) || Math.abs(nowSec - tsNum) > HMAC_MAX_DRIFT_SEC) {
    return { ok: false, error: "expired_timestamp" };
  }

  const expected = await hmacSha256Hex(secret, bodyText + ts);
  if (!constantTimeEqual(sig, expected)) {
    return { ok: false, error: "bad_signature" };
  }
  return { ok: true };
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256Hex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}
