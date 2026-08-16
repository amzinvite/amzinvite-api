-- La route des vagues ne s'intéresse qu'aux validations acceptées pour son
-- premier agrégat. Cet index partiel reste petit et évite de relire toute la
-- table feedback_hourly à chaque actualisation.
CREATE INDEX IF NOT EXISTS idx_feedback_hourly_accepted_hour
  ON feedback_hourly(hour, instance_id, marketplace, asin)
  WHERE state = 'accepted';
