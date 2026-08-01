-- Les requêtes actives filtrent les événements par received_at. Les autres
-- index amplifient chaque insertion sans accélérer le flux incrémental PrixTCG.
DROP INDEX IF EXISTS idx_feedback_asin;
DROP INDEX IF EXISTS idx_feedback_instance;
DROP INDEX IF EXISTS idx_observations_asin_day;

-- Le rate limiting est désormais assuré par les bindings natifs Workers.
DROP INDEX IF EXISTS idx_rate_events_updated_at;
