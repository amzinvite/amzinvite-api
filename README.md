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

## Détection des vagues

Les créneaux suivis utilisent le fuseau `Europe/Paris` : lundi à 22 h et
vendredi à 10 h. Le bootstrap attribue à chaque installation un premier scan
stable entre T+0 et T+29 minutes, avec environ 10 % de canaris pendant les deux
premières minutes. Les contrôles suivants restent espacés sur les 24 heures de
la vague.

Une vague publique s'ouvre après un signal `available` ou `accepted` provenant
de deux installations distinctes. Seuls les événements `accepted` alimentent
les compteurs de sélection et de validation.

## Licence

MIT
