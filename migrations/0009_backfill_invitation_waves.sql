CREATE TABLE _wave_backfill_events AS
WITH accepted_rows AS (
  SELECT instance_id, marketplace, asin,
         COALESCE(observed_at, received_at) AS accepted_at,
         LAG(COALESCE(observed_at, received_at)) OVER (
           PARTITION BY instance_id, marketplace, asin
           ORDER BY COALESCE(observed_at, received_at)
         ) AS previous_at
    FROM extension_feedback
   WHERE state = 'accepted'
), accepted_events AS (
  SELECT instance_id, marketplace, asin, accepted_at
    FROM accepted_rows
   WHERE previous_at IS NULL OR accepted_at - previous_at >= 129600
), ordered_events AS (
  SELECT *, LAG(accepted_at) OVER (ORDER BY accepted_at) AS previous_event
    FROM accepted_events
), grouped_events AS (
  SELECT *,
         SUM(CASE WHEN previous_event IS NULL OR accepted_at - previous_event >= 129600 THEN 1 ELSE 0 END)
           OVER (ORDER BY accepted_at) AS wave_group
    FROM ordered_events
), valid_groups AS (
  SELECT wave_group, MIN(accepted_at) AS started_at
    FROM grouped_events
   GROUP BY wave_group
  HAVING COUNT(DISTINCT instance_id) >= 2
)
SELECT CAST(v.started_at AS TEXT) AS wave_id, v.started_at,
       g.instance_id, g.marketplace, g.asin, g.accepted_at
  FROM valid_groups v
  JOIN grouped_events g ON g.wave_group = v.wave_group
 WHERE g.accepted_at < v.started_at + 86400;

INSERT OR REPLACE INTO invitation_waves (
  id, started_at, ended_at, finalized_at, installations, active_users,
  selected_users, validations, products, selection_rate
)
SELECT e.wave_id, e.started_at, e.started_at + 86400, unixepoch(),
       (SELECT COUNT(DISTINCT c.instance_id)
          FROM extension_credentials c
         WHERE c.scope = 'instance' AND c.instance_id IS NOT NULL
           AND c.created_at < e.started_at + 86400),
       (SELECT COUNT(DISTINCT f.instance_id)
          FROM extension_feedback f
         WHERE f.received_at >= e.started_at
           AND f.received_at < e.started_at + 86400),
       COUNT(DISTINCT e.instance_id), COUNT(*), COUNT(DISTINCT e.asin),
       CAST(COUNT(DISTINCT e.instance_id) AS REAL) /
         MAX(1, (SELECT COUNT(DISTINCT f.instance_id)
                   FROM extension_feedback f
                  WHERE f.received_at >= e.started_at
                    AND f.received_at < e.started_at + 86400))
  FROM _wave_backfill_events e
 WHERE e.started_at + 86400 <= unixepoch()
 GROUP BY e.wave_id, e.started_at;

INSERT OR REPLACE INTO invitation_wave_products (
  wave_id, marketplace, asin, name, image_url, selected_users,
  validations, eligible_users, selection_rate
)
SELECT e.wave_id, e.marketplace, e.asin,
       COALESCE(i.name, m.name, e.asin),
       (SELECT o.image_url
          FROM observations o
         WHERE o.marketplace = e.marketplace AND o.asin = e.asin
           AND o.image_url IS NOT NULL AND o.image_url <> ''
         ORDER BY o.received_at DESC LIMIT 1),
       COUNT(DISTINCT e.instance_id), COUNT(*),
       (SELECT COUNT(DISTINCT f.instance_id)
          FROM extension_feedback f
         WHERE f.marketplace = e.marketplace AND f.asin = e.asin
           AND f.state IN ('already_requested', 'accepted')
           AND f.received_at >= e.started_at - 86400
           AND f.received_at < e.started_at + 86400),
       CAST(COUNT(DISTINCT e.instance_id) AS REAL) /
         MAX(1, (SELECT COUNT(DISTINCT f.instance_id)
                   FROM extension_feedback f
                  WHERE f.marketplace = e.marketplace AND f.asin = e.asin
                    AND f.state IN ('already_requested', 'accepted')
                    AND f.received_at >= e.started_at - 86400
                    AND f.received_at < e.started_at + 86400))
  FROM _wave_backfill_events e
  LEFT JOIN invitations i
    ON i.marketplace = e.marketplace AND i.asin = e.asin
  LEFT JOIN monitoring_products m
    ON m.marketplace = e.marketplace AND m.asin = e.asin
 WHERE e.started_at + 86400 <= unixepoch()
 GROUP BY e.wave_id, e.started_at, e.marketplace, e.asin,
          COALESCE(i.name, m.name, e.asin);

DROP TABLE _wave_backfill_events;
