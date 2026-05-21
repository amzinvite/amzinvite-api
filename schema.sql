-- ─────────────────────────────────────────────────────────────────────────
-- Schéma D1 pour le backend amzinvite
-- ─────────────────────────────────────────────────────────────────────────
-- Trois tables, toutes anonymisées : aucune donnée perso utilisateur.

-- Le feed public : produits Amazon actuellement en mode invitation,
-- alimenté par le scraper alerter (via POST /api/admin/upsert).
CREATE TABLE IF NOT EXISTS invitations (
  asin           TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  name           TEXT,
  marketplace    TEXT DEFAULT 'amazon.fr',
  first_seen     INTEGER NOT NULL,    -- epoch seconds
  last_updated   INTEGER NOT NULL,
  active         INTEGER DEFAULT 1    -- 0 = sorti du mode invitation
);
CREATE INDEX IF NOT EXISTS idx_invitations_active ON invitations(active, last_updated DESC);

-- Feedback de détection d'état (opt-in côté extension, UUID anonyme)
CREATE TABLE IF NOT EXISTS extension_feedback (
  id             INTEGER PRIMARY KEY,
  instance_id    TEXT,                -- UUID anonyme côté extension
  asin           TEXT NOT NULL,
  state          TEXT NOT NULL,       -- available | already_requested | accepted | not_invitation
  source         TEXT,                -- bg_check | manual_visit | auto_request
  observed_at    INTEGER,
  received_at    INTEGER NOT NULL,
  ip_hash        TEXT                 -- sha256(IP), pour rate-limit
);
CREATE INDEX IF NOT EXISTS idx_feedback_asin ON extension_feedback(asin, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_instance ON extension_feedback(instance_id, received_at DESC);

-- Observations Amazon (opt-in séparé, ANONYMES, pas d'instance_id)
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
CREATE INDEX IF NOT EXISTS idx_observations_asin_day ON observations(asin, day_bucket);
