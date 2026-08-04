# amzinvite-backend

Backend public de amzinvite, basé sur Cloudflare Workers et D1.

Le endpoint admin `GET /api/admin/stats?hours=48`, protégé par
`X-Admin-Token`, expose des agrégats anonymes heure par heure sur une fenêtre
bornée à sept jours. Son résultat est calculé au maximum une fois toutes les
30 minutes par datacenter Cloudflare. Il alimente le cockpit PrixTCG sans
exposer les identifiants d'instance ni les empreintes réseau.

Le compteur distingue les enrôlements techniques bruts des installations
durables. Une instance devient durable uniquement après avoir réutilisé son
credential plus d'une heure après son premier enrôlement. Cette confirmation
différée écarte les UUID éphémères qu'un démarrage concurrent d'une ancienne
version de l'extension a pu produire, sans supprimer l'historique D1.

## Rôle

Ce service :

- expose le feed public des produits Amazon actuellement en mode invitation
- distribue un lot stable du catalogue Amazon PrixTCG à chaque installation
  pour sa surveillance silencieuse en arrière-plan
- reçoit les remontées anonymes de l'extension
- reçoit les mises à jour du catalogue depuis un outil d'administration ou de synchronisation

## Endpoints

| Méthode | Path | Description |
|---|---|---|
| `GET` | `/api/public/invitations?marketplaces=amazon.fr,amazon.com.be` | Feed curé par marketplace (sans filtre : FR historique), requête signée HMAC exacte et non cachable |
| `GET` | `/api/extension/monitoring?marketplaces=amazon.fr&limit=20` | Lot stable de produits à surveiller, signé avec le credential de l'installation et borné à 40 URLs |
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

Les produits, feedbacks et observations sont identifiés par
`(marketplace, asin)`. Seules `amazon.fr` et `amazon.com.be` sont acceptées.
Les anciens payloads sans marketplace restent interprétés comme France. Un
upsert admin peut fournir `marketplaces` pour déclarer explicitement les
snapshots remplacés : un snapshot Belgique vide ne désactive ainsi aucune ligne
France.

Les feedbacks répétitifs sont dédupliqués par heure dans `feedback_hourly` sur
`(instance, marketplace, asin, état, source)`. Seuls les états `available`,
`accepted` et la source `auto_request` restent également conservés en brut.
Les statistiques admin combinent automatiquement l'ancien historique brut et
les agrégats créés depuis la migration.

Les observations utilisent également un agrégat horaire par marketplace et
ASIN. Une remontée identique ne provoque aucune réécriture, tandis qu'un
changement de prix ou de stock remplace la valeur de l'heure. Un cron quotidien
purge par défaut les données brutes et horaires âgées de plus de 14 jours ; il
peut être neutralisé avec `DATA_RETENTION_ENABLED=false`.

Le même upsert accepte `monitoring_products` et `monitoring_marketplaces` pour
remplacer le catalogue silencieux par marketplace. Ce catalogue est séparé des
invitations : il n'autorise ni notification ni auto-demande dans l'extension.
La route de monitoring choisit le lot par hachage stable du credential afin de
répartir la couverture sans enregistrer l'identité d'une installation en D1.

## Notes

- `wrangler.toml` doit être complété avant déploiement
- `schema.sql` contient le schéma D1
- l'extension doit pointer vers l'URL publique du worker déployé
