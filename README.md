# amzinvite-backend

Backend Cloudflare Workers utilisé par l’extension Chrome amzinvite.

Il fournit les données nécessaires au suivi des invitations, reçoit les remontées communautaires anonymes et alimente les statistiques publiques du service.

## Développement

```bash
npm install
npm test
npm run dev
```

## Déploiement

```bash
npm run deploy
```

La configuration Cloudflare et les secrets nécessaires doivent être définis avant le déploiement.

## Confidentialité

Le service est conçu pour limiter les données collectées et leur durée de conservation. Il ne reçoit ni cookies Amazon, ni mot de passe, ni identité de compte Amazon.

## Licence

MIT
