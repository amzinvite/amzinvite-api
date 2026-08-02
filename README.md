# amzinvite-backend

Backend public de amzinvite, basé sur Cloudflare Workers et D1.

Le endpoint admin `GET /api/admin/stats?hours=48`, protégé par
`X-Admin-Token`, expose des agrégats anonymes heure par heure sur une fenêtre
bornée à sept jours. Son résultat est calculé au maximum une fois toutes les
30 minutes par datacenter Cloudflare. Il alimente le cockpit PrixTCG sans
exposer les identifiants d'instance ni les empreintes réseau.

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
| `GET` | `/api/admin/sync` | Nouvelles observations depuis le curseur local PrixTCG |
| `GET` | `/api/admin/stats` | Statistiques horaires mises en cache 30 minutes (`fresh=1` force un recalcul admin) |
| `GET` | `/healthz` | Health check |

## Déploiement

1. Installer les dépendances avec `npm install`
2. Créer la base D1
3. Reporter l'identifiant D1 dans `wrangler.toml`
4. Définir les secrets Cloudflare nécessaires
5. Déployer avec Wrangler

## Secrets

- `ADMIN_TOKEN`

## Authentification extension

L'extension utilise l'authentification v2 : chaque installation enrôle un
credential HMAC aléatoire via `/api/extension/register`, stocké localement dans
Chrome. Le feed public exige une requête signée v2 et les anciennes signatures
legacy sont refusées.

Contrôler l'adoption via `extension_auth_activity` :
`SELECT auth_version, COUNT(*) FROM extension_auth_activity WHERE last_seen > unixepoch() - 604800 GROUP BY auth_version`.

Les observations utilisent un credential distinct, sans `instance_id`, qui
expire après 48 heures. Elles ne sont donc pas rattachées durablement à une
installation. Les credentials courts expirés sont purgés automatiquement lors
du prochain enrôlement. PrixTCG conserve son curseur de synchronisation dans sa
base locale et le Worker ne lit que la fenêtre incrémentale indexée. Le filtrage
des observations utiles est ensuite effectué localement selon les TCG pris en
charge ; aucune recherche D1 supplémentaire par ASIN n'est effectuée.

Les limites de débit utilisent les bindings Rate Limiting de Workers. La table
historique `rate_events` reste présente pour compatibilité, mais n'est plus
alimentée. Les index D1 qui ne servent pas aux lectures incrémentales sont
retirés afin qu'un feedback ou une observation ne multiplie pas les écritures.

## Notes

- `wrangler.toml` doit être complété avant déploiement
- `schema.sql` contient le schéma D1
- l'extension doit pointer vers l'URL publique du worker déployé
