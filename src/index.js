// amzinvite-api — Cloudflare Worker
//
// 5 endpoints exposés :
//   GET  /api/public/invitations       feed curé, requête signée HMAC (anti-scraping)
//   POST /api/extension/register       délivre un credential HMAC aléatoire
//   POST /api/extension/feedback       feedback signé HMAC, depuis l'extension
//   POST /api/extension/observations   observations anonymes, depuis l'extension
//   POST /api/admin/upsert             alimenté par le job d'alimentation du catalogue
//
// Secrets requis (wrangler secret put …) :
//   HMAC_SECRET   : doit matcher HMAC_SECRET dans background.js de l'extension
//   ADMIN_TOKEN   : pour le endpoint /api/admin/upsert

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Instance-Id, X-Auth-Version, X-Credential-Id, X-Ts, X-Sig, X-Admin-Token",
  "Access-Control-Max-Age": "86400",
};

const HMAC_MAX_DRIFT_SEC = 300; // ±5 min
const FEED_SIG_PAYLOAD = "/api/public/invitations"; // doit matcher l'extension
const MAX_EXTENSION_BODY_BYTES = 128 * 1024;
const RATE_LIMIT_FEEDBACK_PER_INSTANCE_HOUR = 500;
const RATE_LIMIT_OBSERVATIONS_PER_IP_MINUTE = 60;
const RATE_LIMIT_OBSERVATIONS_PER_ASIN_MINUTE = 120;
const RATE_LIMIT_PUBLIC_FEED_PER_IP_MINUTE = 60;
const RATE_LIMIT_REGISTRATIONS_PER_IP_HOUR = 20;
const OBSERVATION_CREDENTIAL_TTL_SEC = 48 * 60 * 60;
const RECENT_OBSERVATION_PRICE_MAX_AGE_SEC = 60 * 60;

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

  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "");
  const hourBucket = Math.floor(Date.now() / 3600000);
  const registrationLimit = await consumeRateLimit(
    env,
    `ip:credential_registration:${ipHash}`,
    hourBucket,
    RATE_LIMIT_REGISTRATIONS_PER_IP_HOUR,
  );
  if (!registrationLimit.ok) {
    return json({ error: "rate_limit" }, 429);
  }

  const credentialId = crypto.randomUUID();
  const secret = randomBase64Url(32);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = scope === "observations" ? now + OBSERVATION_CREDENTIAL_TTL_SEC : null;
  // Le prochain enrôlement purge les credentials courts déjà expirés. Les
  // clients renouvellent 6 h avant l'échéance, donc aucune clé active n'est
  // supprimée et la table ne croît pas indéfiniment.
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
  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "");
  const minuteBucket = Math.floor(Date.now() / 60000);
  const ipLimit = await consumeRateLimit(
    env,
    `ip:public_feed:${ipHash}`,
    minuteBucket,
    RATE_LIMIT_PUBLIC_FEED_PER_IP_MINUTE,
  );
  if (!ipLimit.ok) {
    return json({ error: "rate_limit" }, 429);
  }

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

  const result = await env.DB.prepare(
    `SELECT asin, url, name, marketplace, first_seen
     FROM invitations
     WHERE active = 1
     ORDER BY first_seen DESC
     LIMIT 200`,
  ).all();
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

  if (!payload.asin || !/^[A-Z0-9]{10}$/i.test(payload.asin)) {
    return json({ error: "bad_asin" }, 400);
  }
  if (!["available", "already_requested", "accepted", "not_invitation", "stub_no_data"].includes(payload.state)) {
    return json({ error: "bad_state" }, 400);
  }

  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "");

  const hourBucket = Math.floor(Date.now() / 3600000);
  const instanceLimit = await consumeRateLimit(
    env,
    `instance:feedback:${instanceId}`,
    hourBucket,
    RATE_LIMIT_FEEDBACK_PER_INSTANCE_HOUR,
  );
  if (!instanceLimit.ok) {
    return json({ error: "rate_limit" }, 429);
  }

  await env.DB.prepare(
    `INSERT INTO extension_feedback (instance_id, asin, state, source, observed_at, received_at, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    instanceId,
    payload.asin.toUpperCase(),
    payload.state,
    payload.source || null,
    payload.observedAt || null,
    Math.floor(Date.now() / 1000),
    ipHash,
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

  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { return json({ error: "bad_json" }, 400); }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ error: "empty_items" }, 400);
  }

  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "");
  const minuteBucket = Math.floor(Date.now() / 60000);
  const ipLimit = await consumeRateLimit(
    env,
    `ip:observations:${ipHash}`,
    minuteBucket,
    RATE_LIMIT_OBSERVATIONS_PER_IP_MINUTE,
  );
  if (!ipLimit.ok) {
    return json({ error: "rate_limit" }, 429);
  }

  const now = Math.floor(Date.now() / 1000);
  // Dédoublonner par ASIN — garder le dernier item de chaque ASIN
  const seen = new Map();
  for (const it of payload.items.slice(0, 100)) {
    const asin = (it.external_id || it.asin || "").toUpperCase();
    if (/^[A-Z0-9]{10}$/i.test(asin)) seen.set(asin, it);
  }
  const dedupedItems = Array.from(seen.values());
  const acceptedItems = [];
  let asinThrottled = 0;
  for (const it of dedupedItems) {
    const asin = (it.external_id || it.asin || "").toUpperCase();
    const asinLimit = await consumeRateLimit(
      env,
      `asin:observations:${asin}`,
      minuteBucket,
      RATE_LIMIT_OBSERVATIONS_PER_ASIN_MINUTE,
    );
    if (asinLimit.ok) {
      acceptedItems.push(it);
    } else {
      asinThrottled++;
    }
  }
  if (acceptedItems.length === 0) {
    return json({ ok: true, inserted: 0, deduped: payload.items.length - dedupedItems.length, throttled: asinThrottled });
  }

  // D1 batch insert
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
    it.site || "amazon",
    payload.dayBucket || null,
    now,
  ));
  await env.DB.batch(stmts);

  return json({ ok: true, inserted: stmts.length, deduped: payload.items.length - dedupedItems.length, throttled: asinThrottled });
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
      first_seen: Number.isFinite(Number(inv.first_seen)) ? Number(inv.first_seen) : null,
    }));
  // Upsert : si alerter fournit first_seen, il devient la source canonique.
  // Sinon on conserve le first_seen déjà stocké, avec fallback sur now.
  const stmts = normalizedInvitations.map((inv) => env.DB.prepare(
    `INSERT INTO invitations (asin, url, name, marketplace, first_seen, last_updated, active)
     VALUES (?, ?, ?, ?, COALESCE(?, (SELECT first_seen FROM invitations WHERE asin = ?), ?), ?, ?)
     ON CONFLICT(asin) DO UPDATE SET
       first_seen = excluded.first_seen,
       url = excluded.url,
       name = excluded.name,
       last_updated = excluded.last_updated,
       active = excluded.active`,
  ).bind(
    inv.asin,
    inv.url,
    inv.name || null,
    inv.marketplace || "amazon.fr",
    inv.first_seen,
    inv.asin,
    now,
    now,
    inv.active === false ? 0 : 1,
  ));
  if (stmts.length) {
    await env.DB.batch(stmts);
  }

  const asinPlaceholders = normalizedInvitations.map(() => "?").join(", ");
  const deactivateMissing = normalizedInvitations.length
    ? env.DB.prepare(
      `UPDATE invitations
       SET active = 0, last_updated = ?
       WHERE active = 1
         AND asin NOT IN (${asinPlaceholders})`,
    ).bind(now, ...normalizedInvitations.map((inv) => inv.asin))
    : env.DB.prepare(
      `UPDATE invitations
       SET active = 0, last_updated = ?
       WHERE active = 1`,
    ).bind(now);
  await deactivateMissing.run();

  return json({ ok: true, upserted: stmts.length });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/admin/sync
// Expose les feedbacks et observations agrégés pour consommation par alerter.
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

  // Feedback : la plus récente par asin (une seule ligne, même si timestamps égaux)
  const feedbackResult = await env.DB.prepare(
    `SELECT asin, last_seen FROM (
       SELECT f.asin, f.observed_at as last_seen,
              ROW_NUMBER() OVER (PARTITION BY f.asin ORDER BY f.observed_at DESC, f.id DESC) as rn
       FROM extension_feedback f
       WHERE f.received_at > ?
     ) WHERE rn = 1
     ORDER BY last_seen DESC
     LIMIT 2000`,
  ).bind(since).all();

  // Observations : la plus récente par ASIN. Une observation de fiche sans
  // prix ne doit pas effacer le prix listing reçu quelques instants avant :
  // reprendre le dernier prix non nul du même ASIN, limité à une heure.
  const obsResult = await env.DB.prepare(
    `WITH ranked AS (
       SELECT o.asin, o.name, o.price_cents, o.in_stock, o.stock_status, o.image_url, o.marketplace,
              o.received_at as last_seen,
              ROW_NUMBER() OVER (PARTITION BY o.asin ORDER BY o.received_at DESC, o.id DESC) as rn
       FROM observations o
       WHERE o.received_at > ?
     ), latest AS (
       SELECT * FROM ranked WHERE rn = 1
     )
     SELECT latest.asin, latest.name,
            COALESCE(
              latest.price_cents,
              (SELECT priced.price_cents
                 FROM observations priced
                WHERE priced.asin = latest.asin
                  AND priced.price_cents IS NOT NULL
                  AND priced.received_at <= latest.last_seen
                  AND priced.received_at >= latest.last_seen - ${RECENT_OBSERVATION_PRICE_MAX_AGE_SEC}
                ORDER BY priced.received_at DESC, priced.id DESC
                LIMIT 1)
            ) AS price_cents,
            latest.in_stock, latest.stock_status, latest.image_url,
            latest.marketplace, latest.last_seen
       FROM latest
      ORDER BY latest.last_seen DESC
     LIMIT 2000`,
  ).bind(since).all();

  return json({
    feedback: feedbackResult.results || [],
    observations: obsResult.results || [],
    since,
    generated_at: Math.floor(Date.now() / 1000),
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

async function consumeRateLimit(env, key, bucket, limit) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO rate_events (key, bucket, count, updated_at)
     VALUES (?, ?, 0, ?)`,
  ).bind(key, bucket, now).run();
  await env.DB.prepare(
    `UPDATE rate_events
     SET count = count + 1, updated_at = ?
     WHERE key = ? AND bucket = ?`,
  ).bind(now, key, bucket).run();
  const row = await env.DB.prepare(
    `SELECT count FROM rate_events WHERE key = ? AND bucket = ?`,
  ).bind(key, bucket).first();
  return { ok: (row?.count || 0) <= limit, count: row?.count || 0 };
}

async function checkFeedAuth(request, env) {
  const instanceId = request.headers.get("X-Instance-Id");
  if (!instanceId || !/^[0-9a-f-]{32,40}$/i.test(instanceId)) {
    return { ok: false, error: "bad_instance_id" };
  }
  const auth = await verifyExtensionHmac(request, FEED_SIG_PAYLOAD, env, {
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

  if (env.EXTENSION_LEGACY_AUTH_ENABLED === "false") {
    return { ok: false, error: "legacy_auth_disabled" };
  }
  const legacy = await verifyHmacWithSecret(request, bodyText, env.HMAC_SECRET || "");
  return legacy.ok ? { ...legacy, version: 1 } : legacy;
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

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
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
