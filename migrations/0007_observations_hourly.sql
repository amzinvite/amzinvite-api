CREATE TABLE IF NOT EXISTS observations_hourly (
  hour             INTEGER NOT NULL,
  marketplace      TEXT NOT NULL,
  asin             TEXT NOT NULL,
  name             TEXT,
  price_cents      INTEGER,
  in_stock         INTEGER,
  stock_status     TEXT,
  image_url        TEXT,
  day_bucket       TEXT,
  first_received_at INTEGER NOT NULL,
  last_received_at  INTEGER NOT NULL,
  PRIMARY KEY (hour, marketplace, asin)
) WITHOUT ROWID;

INSERT OR IGNORE INTO observations_hourly (
  hour, marketplace, asin, name, price_cents, in_stock, stock_status,
  image_url, day_bucket, first_received_at, last_received_at
)
SELECT
  CAST(received_at / 3600 AS INTEGER) * 3600,
  marketplace,
  asin,
  name,
  price_cents,
  in_stock,
  stock_status,
  image_url,
  day_bucket,
  received_at,
  received_at
FROM (
  SELECT o.*,
         ROW_NUMBER() OVER (
           PARTITION BY CAST(received_at / 3600 AS INTEGER), marketplace, asin
           ORDER BY received_at DESC, id DESC
         ) AS rn
    FROM observations o
   WHERE received_at >= CAST(unixepoch() / 3600 AS INTEGER) * 3600
)
WHERE rn = 1;
