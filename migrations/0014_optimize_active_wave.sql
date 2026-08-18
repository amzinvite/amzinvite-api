-- Le calcul public ne lit désormais que la vague active. Ces index partiels
-- limitent en plus les scans aux signaux et images réellement utilisés.
CREATE INDEX IF NOT EXISTS idx_feedback_hourly_wave_signals
  ON feedback_hourly(hour, state, instance_id, marketplace, asin)
  WHERE state IN ('available', 'accepted');

CREATE INDEX IF NOT EXISTS idx_observations_hourly_wave_images
  ON observations_hourly(hour, marketplace, asin, last_received_at DESC)
  WHERE image_url IS NOT NULL AND image_url <> '';
