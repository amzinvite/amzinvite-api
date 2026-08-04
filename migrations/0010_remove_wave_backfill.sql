-- Le brut historique ne permet pas de garantir que toutes les vagues ont été
-- observées. On retire donc le backfill incomplet et on conserve uniquement
-- les vagues archivées automatiquement après la mise en place du cron.
DELETE FROM invitation_wave_products;
DELETE FROM invitation_waves;
