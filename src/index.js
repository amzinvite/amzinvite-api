// amzinvite-api — Cloudflare Worker
//
// Endpoints exposés :
//   GET  /api/public/invitations       feed curé, requête signée HMAC (anti-scraping)
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
const MONITORING_PATH = "/api/extension/monitoring";
const DEFAULT_MONITORING_SHARD_SIZE = 20;
const MAX_MONITORING_SHARD_SIZE = 40;
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
      if (url.pathname === MONITORING_PATH && request.method === "GET") {
        return await handleMonitoringFeed(request, env);
      }
      if (url.pathname === "/api/extension/register" && request.method === "POST") {
        return await handleCredentialRegistration(request, env);
      }
      if (url.pathname === "/api/extension/feedback" && request.method === "POST") {
        return await handleFeedback(request, env);
      }
      if (url.pathname === "/api/extension/observations" && request.method === "POST") {
        return await handleObservations(request, env);
      }
      if (url.pathname === "/api/admin/upsert" && request.method === "POST") {
        return await handleAdminUpsert(request, env);
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
};

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

  const marketplace = payload.marketplace == null
    ? "amazon.fr"
    : normalizeMarketplace(payload.marketplace);
  if (!marketplace) return json({ error: "bad_marketplace" }, 400);
  if (!payload.asin || !/^[A-Z0-9]{10}$/i.test(payload.asin)) {
    return json({ error: "bad_asin" }, 400);
  }
  if (!["available", "already_requested", "accepted", "not_invitation", "stub_no_data"].includes(payload.state)) {
    return json({ error: "bad_state" }, 400);
  }

  const instanceLimit = await env.FEEDBACK_RATE_LIMITER.limit({ key: instanceId });
  if (!instanceLimit.success) {
    return json({ error: "rate_limit" }, 429);
  }

  await env.DB.prepare(
    `INSERT INTO extension_feedback (instance_id, marketplace, asin, state, source, observed_at, received_at, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    instanceId,
    marketplace,
    payload.asin.toUpperCase(),
    payload.state,
    payload.source || null,
    payload.observedAt || null,
    Math.floor(Date.now() / 1000),
    null,
  ).run();

  return json({ ok: true });
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

  const stmts = acceptedItems.map((it) => env.DB.prepare(
    `INSERT INTO observations (asin, name, price_cents, in_stock, stock_status, image_url, marketplace, day_bucket, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    (it.external_id || it.asin || "").toUpperCase(),
    it.name || null,
    normalizeObservationPrice(it.price),
    normalizeObservationStock(it.in_stock),
    it.stock_status || null,
    it.image_url || null,
    it.marketplace,
    payload.dayBucket || null,
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
  if (stmts.length) {
    await env.DB.batch(stmts);
  }

  for (const marketplace of scopes) {
    const asins = normalizedInvitations.filter((inv) => inv.marketplace === marketplace).map((inv) => inv.asin);
    const placeholders = asins.map(() => "?").join(", ");
    const statement = asins.length
      ? env.DB.prepare(`UPDATE invitations SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1 AND asin NOT IN (${placeholders})`).bind(now, marketplace, ...asins)
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
  if (monitoringStatements.length) await env.DB.batch(monitoringStatements);

  if (hasMonitoringSnapshot) {
    for (const marketplace of monitoringScopes) {
      const asins = normalizedMonitoring
        .filter((item) => item.marketplace === marketplace)
        .map((item) => item.asin);
      const placeholders = asins.map(() => "?").join(", ");
      const statement = asins.length
        ? env.DB.prepare(`UPDATE monitoring_products SET active = 0, last_updated = ? WHERE marketplace = ? AND active = 1 AND asin NOT IN (${placeholders})`).bind(now, marketplace, ...asins)
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
    `SELECT asin, name, price_cents, in_stock, stock_status, image_url, marketplace,
            received_at AS last_seen
       FROM (
         SELECT o.*,
                ROW_NUMBER() OVER (
                  PARTITION BY o.marketplace, o.asin
                  ORDER BY o.received_at DESC, o.id DESC
                ) AS rn
           FROM observations o
          WHERE o.received_at > ?
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
       ), feedback_24h AS (
         SELECT COUNT(DISTINCT instance_id) AS scanning_users_24h,
                COUNT(DISTINCT CASE WHEN source = 'auto_request' THEN instance_id END) AS auto_request_users_24h,
                COUNT(DISTINCT CASE WHEN state = 'accepted' THEN instance_id END) AS accepted_users_24h,
                COUNT(*) AS feedback_events_24h
           FROM extension_feedback
          WHERE received_at >= ?1
       )
       SELECT
         (SELECT COUNT(*) FROM installs) AS installations_seen,
         (SELECT COUNT(*) FROM installs WHERE first_created >= ?1) AS new_installations_24h,
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
         SELECT instance_id, MIN(created_at) AS first_created
           FROM extension_credentials
          WHERE scope = 'instance'
            AND instance_id IS NOT NULL
          GROUP BY instance_id
       )
       SELECT CAST(first_created / 3600 AS INTEGER) * 3600 AS hour,
              COUNT(*) AS new_installations
         FROM installs
        WHERE first_created >= ?1
        GROUP BY hour
        ORDER BY hour`,
    ).bind(startHour),
    env.DB.prepare(
      `SELECT CAST(received_at / 3600 AS INTEGER) * 3600 AS hour,
              COUNT(DISTINCT instance_id) AS scanning_users,
              COUNT(*) AS feedback_events,
              COUNT(DISTINCT CASE WHEN source = 'auto_request' THEN instance_id END) AS auto_request_users,
              COUNT(DISTINCT CASE WHEN state = 'accepted' THEN instance_id END) AS accepted_users
         FROM extension_feedback
        WHERE received_at >= ?1
        GROUP BY hour
        ORDER BY hour`,
    ).bind(startHour),
  ]);

  const hourly = Array.from({ length: hours }, (_, index) => ({
    hour: startHour + index * 3600,
    new_installations: 0,
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
  mergeRows(installsResult, ["new_installations"]);
  mergeRows(feedbackResult, ["scanning_users", "feedback_events", "auto_request_users", "accepted_users"]);

  const summarySource = summaryResult.results?.[0] || {};
  const summary = Object.fromEntries([
    "installations_seen",
    "new_installations_24h",
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
