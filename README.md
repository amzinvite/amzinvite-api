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
| `GET` | `/api/public/invitations` | Feed public |
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

- `HMAC_SECRET`
- `ADMIN_TOKEN`

## Notes

- `wrangler.toml` doit être complété avant déploiement
- `schema.sql` contient le schéma D1
- l'extension doit pointer vers l'URL publique du worker déployé
