-- Matérialisation incrémentale des faits utilisés par les statistiques de vague.
-- Les clés primaires dédupliquent naturellement les remontées répétées d'une
-- même installation et évitent de rescanner feedback_hourly à chaque snapshot.
CREATE TABLE IF NOT EXISTS wave_materialization_state (
  wave_id                TEXT PRIMARY KEY,
  started_at             INTEGER NOT NULL,
  ended_at               INTEGER NOT NULL,
  processed_through_hour INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wave_product_instances (
  wave_id      TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  signal_at    INTEGER NOT NULL,
  accepted_at  INTEGER,
  PRIMARY KEY (wave_id, instance_id, marketplace, asin)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_wave_product_instances_summary
  ON wave_product_instances(wave_id, marketplace, asin, accepted_at);

CREATE TABLE IF NOT EXISTS wave_active_instances (
  wave_id      TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  PRIMARY KEY (wave_id, instance_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS wave_eligible_instances (
  wave_id      TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  PRIMARY KEY (wave_id, instance_id, marketplace, asin)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_wave_eligible_instances_summary
  ON wave_eligible_instances(wave_id, marketplace, asin);
