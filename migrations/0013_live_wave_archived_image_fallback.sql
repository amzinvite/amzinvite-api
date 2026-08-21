CREATE INDEX IF NOT EXISTS idx_wave_products_latest_image
  ON invitation_wave_products(marketplace, asin, wave_id DESC)
  WHERE image_url IS NOT NULL AND image_url <> '';
