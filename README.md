# amzinvite-backend

Backend public de amzinvite, basé sur Cloudflare Workers et D1.

## Rôle

Ce service :

- expose le feed public des produits Amazon actuellement en mode invitation
- reçoit les remontées anonymes de l'extension
- reçoit les mises à jour du catalogue depuis un outil d'administration ou de synchronisation

## Endpoints

| Méthode | Path | Description |
|---|---|---|
| `GET` | `/api/public/invitations` | Feed curé (requête signée HMAC, non cachable) |
| `POST` | `/api/extension/register` | Enrôlement d'un credential HMAC aléatoire v2 |
| `POST` | `/api/extension/feedback` | Détections anonymes envoyées par l'extension |
| `POST` | `/api/extension/observations` | Observations anonymes envoyées par l'extension |
| `POST` | `/api/admin/upsert` | Synchronisation du catalogue |
| `GET` | `/healthz` | Health check |

## Déploiement

1. Installer les dépendances avec `npm install`
2. Créer la base D1
3. Reporter l'identifiant D1 dans `wrangler.toml`
4. Définir les secrets Cloudflare nécessaires
5. Déployer avec Wrangler

## Secrets

- `HMAC_SECRET` (legacy uniquement pendant la migration)
- `ADMIN_TOKEN`

## Migration de l'authentification extension

1. Exécuter `npm run db:migrate:auth-v2`.
2. Déployer le Worker avec `EXTENSION_LEGACY_AUTH_ENABLED = "true"`.
3. Publier l'extension v2 : elle enrôle une clé aléatoire par installation.
4. Contrôler l'adoption via `extension_auth_activity` :
   `SELECT auth_version, COUNT(*) FROM extension_auth_activity WHERE last_seen > unixepoch() - 604800 GROUP BY auth_version`.
5. Passer `EXTENSION_LEGACY_AUTH_ENABLED` à `"false"` et redéployer.
6. Retirer `HMAC_SECRET` du Worker et le fallback legacy de l'extension.

Les observations utilisent un credential distinct, sans `instance_id`, qui
expire après 48 heures. Elles ne sont donc pas rattachées durablement à une
installation. Les credentials courts expirés sont purgés automatiquement lors
du prochain enrôlement.

## Notes

- `wrangler.toml` doit être complété avant déploiement
- `schema.sql` contient le schéma D1
- l'extension doit pointer vers l'URL publique du worker déployé
