-- Matérialise le payload public des vagues dans D1 afin que les cache misses
-- régionaux ne relancent jamais l'agrégation complète de feedback_hourly.
CREATE TABLE IF NOT EXISTS public_wave_snapshots (
  cache_key     TEXT PRIMARY KEY,
  payload       TEXT NOT NULL,
  generated_at  INTEGER NOT NULL
);
