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
