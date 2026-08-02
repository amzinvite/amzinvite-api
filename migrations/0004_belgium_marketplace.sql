PRAGMA foreign_keys = OFF;

CREATE TABLE invitations_v2 (
  asin         TEXT NOT NULL,
  url          TEXT NOT NULL,
  name         TEXT,
  marketplace  TEXT NOT NULL DEFAULT 'amazon.fr',
  first_seen   INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  active       INTEGER DEFAULT 1,
  is_mirror    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (marketplace, asin)
);

INSERT INTO invitations_v2
  (asin, url, name, marketplace, first_seen, last_updated, active, is_mirror)
SELECT asin, url, name, COALESCE(NULLIF(marketplace, ''), 'amazon.fr'),
       first_seen, last_updated, active, 0
  FROM invitations;

DROP TABLE invitations;
ALTER TABLE invitations_v2 RENAME TO invitations;
CREATE INDEX idx_invitations_active
  ON invitations(marketplace, active, last_updated DESC);

ALTER TABLE extension_feedback
  ADD COLUMN marketplace TEXT NOT NULL DEFAULT 'amazon.fr';

UPDATE observations
   SET marketplace = 'amazon.fr'
 WHERE marketplace IS NULL OR marketplace = '' OR marketplace = 'amazon';

CREATE INDEX idx_feedback_marketplace_asin
  ON extension_feedback(marketplace, asin, observed_at DESC);
CREATE INDEX idx_observations_marketplace_asin_received
  ON observations(marketplace, asin, received_at DESC);

PRAGMA foreign_keys = ON;
