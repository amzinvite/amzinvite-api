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

-- Amorcer l'heure de déploiement pour que le passage du brut vers l'agrégat
-- ne crée pas de trou dans les statistiques admin.
INSERT OR IGNORE INTO feedback_hourly (
  hour, instance_id, marketplace, asin, state, source,
  first_observed_at, last_observed_at, first_received_at, last_received_at
)
SELECT
  CAST(received_at / 3600 AS INTEGER) * 3600,
  instance_id,
  marketplace,
  asin,
  state,
  COALESCE(source, ''),
  MIN(observed_at),
  MAX(observed_at),
  MIN(received_at),
  MAX(received_at)
FROM extension_feedback
WHERE received_at >= CAST(unixepoch() / 3600 AS INTEGER) * 3600
GROUP BY
  CAST(received_at / 3600 AS INTEGER) * 3600,
  instance_id,
  marketplace,
  asin,
  state,
  COALESCE(source, '');
