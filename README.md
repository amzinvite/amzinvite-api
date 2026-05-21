# amzinvite-backend

Cloudflare Worker + D1 qui sert le feed public et reçoit les feedbacks anonymes de l'extension amzinvite.

## Endpoints

| Méthode | Path | Auth | Description |
|---|---|---|---|
| `GET`  | `/api/public/invitations` | aucune | Liste des produits Amazon actuellement en mode invitation (cache 5 min) |
| `POST` | `/api/extension/feedback` | HMAC + Instance-Id | Détections d'état remontées par l'extension (opt-in user) |
| `POST` | `/api/extension/observations` | HMAC | Observations de prix/stock (opt-in user, anonyme) |
| `POST` | `/api/admin/upsert` | Admin-Token | Push depuis le scraper alerter |
| `GET`  | `/healthz` | aucune | Health check |

## Setup (première fois, ~15 min)

### 1. Installer wrangler

```bash
cd /Users/mathi/Documents/GitHub/amzinvite-backend
npm install
```

### 2. Login Cloudflare

```bash
npx wrangler login
```

Un navigateur s'ouvre, tu autorises wrangler à utiliser ton compte Cloudflare.

### 3. Créer la base D1

```bash
npx wrangler d1 create amzinvite-db
```

Ça affiche un **database_id** UUID. Copie-le et remplace `REPLACE_WITH_D1_ID` dans `wrangler.toml`.

### 4. Initialiser le schéma

```bash
npm run db:schema
```

Crée les tables `invitations`, `extension_feedback`, `observations` sur la D1 distante.

### 5. Configurer les secrets

Génère deux secrets aléatoires (mémorise-les, tu en auras besoin) :

```bash
# Pour HMAC_SECRET : 32+ chars random
openssl rand -hex 32
# → ex: 7f3a2b1c8e4d6f5a9c2b1d8e4f3a2b1c8e4d6f5a9c2b1d8e4f3a2b1c8e4d6f5a

# Pour ADMIN_TOKEN : 32+ chars random
openssl rand -hex 32
# → ex: 1a2b3c4d...
```

Configure-les comme secrets Cloudflare :

```bash
npx wrangler secret put HMAC_SECRET
# → colle le 1er hex

npx wrangler secret put ADMIN_TOKEN
# → colle le 2ème hex
```

### 6. Déployer

```bash
npm run deploy
```

Le worker est en ligne. URL : `https://amzinvite-api.<ton-subdomain>.workers.dev`

### 7. Test rapide

```bash
curl https://amzinvite-api.<ton-subdomain>.workers.dev/healthz
# → {"ok":true,"service":"amzinvite-api"}

curl https://amzinvite-api.<ton-subdomain>.workers.dev/api/public/invitations
# → [] (vide tant que le scraper n'a rien pushé)
```

## Mise à jour de l'extension amzinvite

Édite `/Users/mathi/Documents/GitHub/amzinvite/src/background.js` et remplace :

```js
const API_BASE = "https://amzinvite.example.com";
const HMAC_SECRET = "REPLACE_ME_BEFORE_BUILD";
```

par :

```js
const API_BASE = "https://amzinvite-api.<ton-subdomain>.workers.dev";
const HMAC_SECRET = "<le même HMAC_SECRET que côté worker>";
```

## Push depuis ton scraper alerter

Script Python à ajouter dans `alerter/scripts/publish_to_amzinvite.py` :

```python
import json, sqlite3, time, requests

DB_PATH = "data/alerter.db"
WORKER_URL = "https://amzinvite-api.<ton-subdomain>.workers.dev"
ADMIN_TOKEN = "<le ADMIN_TOKEN secret>"

db = sqlite3.connect(DB_PATH)
db.row_factory = sqlite3.Row

# 1) Produits actuellement en invitation
active_rows = db.execute("""
    SELECT p.external_id as asin, p.url, p.name, p.created_at
    FROM products p JOIN invitation_state s ON s.product_id = p.id
    WHERE p.stock_status = 'invitation' AND p.site = 'amazon'
""").fetchall()

# 2) Produits qui ne sont plus en invitation (on marque active=False)
inactive_rows = db.execute("""
    SELECT p.external_id as asin, p.url, p.name
    FROM products p
    WHERE p.stock_status != 'invitation' AND p.site = 'amazon'
      AND p.external_id IN (
        SELECT asin FROM products WHERE stock_status = 'invitation'  -- placeholder
      )
""").fetchall()

invitations = [
    {
        "asin": r["asin"],
        "url": r["url"],
        "name": r["name"],
        "marketplace": "amazon.fr",
        "first_seen": int(time.mktime(time.strptime(r["created_at"], "%Y-%m-%d %H:%M:%S"))) if r["created_at"] else None,
        "active": True,
    }
    for r in active_rows
]

r = requests.post(
    f"{WORKER_URL}/api/admin/upsert",
    headers={"X-Admin-Token": ADMIN_TOKEN},
    json={"invitations": invitations},
)
print(r.status_code, r.text)
```

Cron toutes les 10 min :

```bash
*/10 * * * * cd /Users/mathi/Documents/GitHub/alerter && /usr/bin/python3 scripts/publish_to_amzinvite.py >> logs/publish.log 2>&1
```

## Limites du free tier Cloudflare

| Ressource | Free tier | Ton scope |
|---|---|---|
| Workers requests | 100 000 / jour | ~50k pour 1000 users |
| D1 reads | 5 M / jour | très large |
| D1 writes | 100 000 / jour | très large |
| D1 storage | 5 GB | suffisant pour ~10M lignes feedback |
| CPU time | 10 ms / requête | OK (nos queries sont simples) |

Tu peux passer en payant ($5/mo) si jamais ça déborde.

## Logs en live

```bash
npm run tail
```

## Coût total estimé

**$0/mo** tant que tu restes dans le free tier (jusqu'à ~3000 users actifs).
