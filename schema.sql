-- ─────────────────────────────────────────────────────────────────────────
-- Schéma D1 pour le backend amzinvite
-- ─────────────────────────────────────────────────────────────────────────
-- Tables anonymisées : aucune donnée perso utilisateur.

-- Le feed public : produits Amazon actuellement en mode invitation,
-- alimenté par le job de synchronisation du catalogue.
CREATE TABLE IF NOT EXISTS invitations (
  asin           TEXT NOT NULL,
  url            TEXT NOT NULL,
  name           TEXT,
  marketplace    TEXT DEFAULT 'amazon.fr',
  first_seen     INTEGER NOT NULL,    -- epoch seconds
  last_updated   INTEGER NOT NULL,
  active         INTEGER DEFAULT 1,   -- 0 = sorti du mode invitation
  is_mirror      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (marketplace, asin)
);
CREATE INDEX IF NOT EXISTS idx_invitations_active ON invitations(active, last_updated DESC);

-- Catalogue Amazon PrixTCG à observer en arrière-plan. Séparé du feed
-- invitation afin qu'un produit standard ne déclenche jamais d'auto-demande
-- ni de notification d'invitation dans l'extension.
CREATE TABLE IF NOT EXISTS monitoring_products (
  asin           TEXT NOT NULL,
  url            TEXT NOT NULL,
  name           TEXT,
  marketplace    TEXT NOT NULL DEFAULT 'amazon.fr',
  last_updated   INTEGER NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (marketplace, asin)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_products_active
  ON monitoring_products(active, marketplace, asin);

-- Feedback de détection d'état (opt-in côté extension, UUID anonyme)
CREATE TABLE IF NOT EXISTS extension_feedback (
  id             INTEGER PRIMARY KEY,
  instance_id    TEXT,                -- UUID anonyme côté extension
  marketplace    TEXT NOT NULL DEFAULT 'amazon.fr',
  asin           TEXT NOT NULL,
  state          TEXT NOT NULL,       -- available | already_requested | accepted | not_invitation
  source         TEXT,                -- bg_check | manual_visit | auto_request
  observed_at    INTEGER,
  received_at    INTEGER NOT NULL,
  ip_hash        TEXT                 -- historique, plus alimenté
);
CREATE INDEX IF NOT EXISTS idx_feedback_received_at ON extension_feedback(received_at DESC);

-- Feedback horaire dédupliqué : une ligne maximum par installation, produit,
-- état et source. La PK commence par l'heure pour servir directement les stats.
CREATE TABLE IF NOT EXISTS feedback_hourly (
  hour              INTEGER NOT NULL,
  instance_id       TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  asin              TEXT NOT NULL,
  state             TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT '',
  first_observed_at INTEGER,
  last_observed_at  INTEGER,
  first_received_at INTEGER NOT NULL,
  last_received_at  INTEGER NOT NULL,
  PRIMARY KEY (hour, instance_id, marketplace, asin, state, source)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_feedback_hourly_accepted_hour
  ON feedback_hourly(hour, instance_id, marketplace, asin)
  WHERE state = 'accepted';

-- Résumé léger des cycles : une ligne maximum par installation, heure et
-- portée. Le résumé voyage dans le batch de feedback existant.
CREATE TABLE IF NOT EXISTS scan_completions_hourly (
  hour              INTEGER NOT NULL,
  instance_id       TEXT NOT NULL,
  run_kind          TEXT NOT NULL CHECK (run_kind IN ('full', 'partial')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('completed', 'blocked', 'cancelled', 'failed')),
  successful        INTEGER NOT NULL DEFAULT 0,
  extension_version TEXT NOT NULL DEFAULT '',
  checked           INTEGER NOT NULL,
  expected          INTEGER NOT NULL,
  errors            INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  completed_at      INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  PRIMARY KEY (hour, instance_id, run_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_scan_completions_hourly_summary
  ON scan_completions_hourly(hour, run_kind, successful);

-- Archives publiques strictement agrégées des vagues d'invitations. Elles
-- survivent à la purge des événements anonymes individuels.
CREATE TABLE IF NOT EXISTS invitation_waves (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL UNIQUE,
  detected_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  finalized_at INTEGER NOT NULL,
  installations INTEGER NOT NULL,
  active_users INTEGER NOT NULL,
  selected_users INTEGER NOT NULL,
  validations INTEGER NOT NULL,
  products INTEGER NOT NULL,
  selection_rate REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitation_waves_started
  ON invitation_waves(started_at DESC);

-- Snapshot global des statistiques publiques. Le Cache API Workers étant
-- régional, cette ligne empêche chaque datacenter de recalculer les agrégats.
CREATE TABLE IF NOT EXISTS public_wave_snapshots (
  cache_key    TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invitation_wave_products (
  wave_id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  asin TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  selected_users INTEGER NOT NULL,
  validations INTEGER NOT NULL,
  eligible_users INTEGER NOT NULL,
  selection_rate REAL NOT NULL,
  PRIMARY KEY (wave_id, marketplace, asin),
  FOREIGN KEY (wave_id) REFERENCES invitation_waves(id) ON DELETE CASCADE
);

-- Credentials HMAC aléatoires v2. Les credentials "instance" sont liés à
-- l'UUID anonyme ; ceux d'"observations" sont courts et non rattachés.
CREATE TABLE IF NOT EXISTS extension_credentials (
  credential_id TEXT PRIMARY KEY,
  secret        TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('instance', 'observations')),
  instance_id   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_extension_credentials_instance
  ON extension_credentials(instance_id, scope, revoked);
CREATE INDEX IF NOT EXISTS idx_extension_credentials_expiry
  ON extension_credentials(expires_at, revoked);
CREATE INDEX IF NOT EXISTS idx_extension_credentials_scope_created
  ON extension_credentials(scope, created_at DESC, instance_id);

-- Dernière version d'auth vue par instance, pour décider objectivement quand
-- le fallback legacy peut être coupé.
CREATE TABLE IF NOT EXISTS extension_auth_activity (
  instance_id  TEXT PRIMARY KEY,
  auth_version INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extension_auth_activity_rollout
  ON extension_auth_activity(auth_version, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_extension_auth_activity_last_seen
  ON extension_auth_activity(last_seen DESC);

-- Observations Amazon (partage anonyme, pas d'instance_id)
CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY,
  asin           TEXT NOT NULL,
  name           TEXT,
  price_cents    INTEGER,
  in_stock       INTEGER,
  stock_status   TEXT,
  image_url      TEXT,
  marketplace    TEXT,
  day_bucket     TEXT,                -- YYYY-MM-DD, pour rate-limit
  received_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_received_at ON observations(received_at DESC);

-- Dernière observation utile par produit et par heure. Une remontée identique
-- ne réécrit aucune ligne ; un changement de prix ou de stock met la ligne à jour.
CREATE TABLE IF NOT EXISTS observations_hourly (
  hour              INTEGER NOT NULL,
  marketplace       TEXT NOT NULL,
  asin              TEXT NOT NULL,
  name              TEXT,
  price_cents       INTEGER,
  in_stock          INTEGER,
  stock_status      TEXT,
  image_url         TEXT,
  day_bucket        TEXT,
  first_received_at INTEGER NOT NULL,
  last_received_at  INTEGER NOT NULL,
  PRIMARY KEY (hour, marketplace, asin)
) WITHOUT ROWID;

-- Historique des anciens compteurs D1. Le Worker utilise désormais les
-- bindings Rate Limiting natifs et n'écrit plus dans cette table.
CREATE TABLE IF NOT EXISTS rate_events (
  key            TEXT NOT NULL,
  bucket         INTEGER NOT NULL,
  count          INTEGER DEFAULT 1,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
