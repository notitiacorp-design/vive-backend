# VIVE â Backend du Concierge SantÃ©

> Backend Supabase alimentant l'application mobile VIVE, un concierge santÃ© intelligent combinant suivi de bien-Ãªtre, gestion des abonnements et recommandations personnalisÃ©es par IA.

---

## Table des matiÃ¨res

1. [Architecture gÃ©nÃ©rale](#architecture-gÃ©nÃ©rale)
2. [Stack technique](#stack-technique)
3. [Structure du projet](#structure-du-projet)
4. [Setup local](#setup-local)
5. [DÃ©ploiement](#dÃ©ploiement)
6. [RÃ©fÃ©rence des Edge Functions](#rÃ©fÃ©rence-des-edge-functions)
7. [SchÃ©ma de base de donnÃ©es](#schÃ©ma-de-base-de-donnÃ©es)
8. [Configuration des Webhooks](#configuration-des-webhooks)
9. [SÃ©curitÃ©](#sÃ©curitÃ©)
10. [Licence](#licence)

---

## Architecture gÃ©nÃ©rale

```
âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
â                        APPLICATION MOBILE                           â
â                     (iOS / Android â VIVE App)                      â
ââââââââââââââââââââââââââââââ¬âââââââââââââââââââââââââââââââââââââââââ
                             â  HTTPS / REST / Realtime
                             â¼
âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
â                        SUPABASE PLATFORM                            â
â                                                                     â
â   ââââââââââââââââââââ        âââââââââââââââââââââââââââââââââââ  â
â   â   Supabase Auth  âââââââââºâ        Edge Functions (Deno)    â  â
â   â  (JWT / OAuth2)  â        â                                 â  â
â   ââââââââââ¬ââââââââââ        â  âââââââââââââââââââââââââââââ  â  â
â            â                  â  â  /ai-recommendations       â  â  â
â            â  RLS Policies    â  â  /health-summary           â  â  â
â            â¼                  â  â  /revenuecat-webhook       â  â  â
â   ââââââââââââââââââââ        â  â  /stripe-webhook           â  â  â
â   â   PostgreSQL DB  âââââââââºâ  â  /cron-daily               â  â  â
â   â                  â        â  â  /user-onboarding          â  â  â
â   â  - users         â        â  â  /push-notifications       â  â  â
â   â  - health_logs   â        â  âââââââââââââââââââââââââââââ  â  â
â   â  - subscriptions â        ââââââââââââ¬âââââââââââââââââââââââ  â
â   â  - goals         â                   â                         â
â   â  - ai_insights   â        ââââââââââââ¼âââââââââââââââââââââââ  â
â   ââââââââââââââââââââ        â       Supabase Storage          â  â
â                               â   (avatars, rapports PDF, ...)  â  â
â                               âââââââââââââââââââââââââââââââââââ  â
âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
          â²                          â²                    â²
          â Webhooks                 â Webhooks           â API
          â                         â                    â
âââââââââââ´âââââââ        âââââââââââ´âââââââ   ââââââââââ´ââââââââ
â   RevenueCat   â        â     Stripe     â   â    OpenAI API  â
â  (Abonnements  â        â  (Paiements &  â   â  (GPT-4o /     â
â   In-App)      â        â   Facturation) â   â  Embeddings)   â
ââââââââââââââââââ        ââââââââââââââââââ   ââââââââââââââââââ
```

---

## Stack technique

| Composant | Technologie | Version recommandÃ©e |
|---|---|---|
| Base de donnÃ©es | PostgreSQL (via Supabase) | 15+ |
| Authentification | Supabase Auth (JWT, OAuth2) | â |
| Fonctions serverless | Edge Functions (Deno) | Deno 1.40+ |
| ORM / RequÃªtes | Supabase Client (`@supabase/supabase-js`) | 2.x |
| SÃ©curitÃ© donnÃ©es | Row Level Security (RLS) | â |
| Stockage fichiers | Supabase Storage (S3-compatible) | â |
| TÃ¢ches planifiÃ©es | `pg_cron` (PostgreSQL extension) | â |
| Abonnements mobiles | RevenueCat Webhooks | v2 |
| Paiements web | Stripe (Webhooks + Checkout) | API 2024+ |
| Intelligence artificielle | OpenAI API (GPT-4o, Embeddings) | â |
| CI/CD | GitHub Actions | â |
| Conteneurisation locale | Docker Desktop | 24+ |
| CLI | Supabase CLI | 1.150+ |

---

## Structure du projet

```
vive-backend/
âââ .github/
â   âââ workflows/
â       âââ deploy.yml              # Pipeline CI/CD dÃ©ploiement automatique
â       âââ tests.yml               # Tests d'intÃ©gration
â
âââ supabase/
â   âââ config.toml                 # Configuration Supabase CLI
â   âââ seed.sql                    # DonnÃ©es de seed pour le dÃ©veloppement
â   â
â   âââ migrations/                 # Migrations PostgreSQL ordonnÃ©es
â   â   âââ 20240101000000_init_schema.sql
â   â   âââ 20240115000000_add_health_logs.sql
â   â   âââ 20240120000000_add_subscriptions.sql
â   â   âââ 20240125000000_add_ai_insights.sql
â   â   âââ 20240201000000_add_goals.sql
â   â   âââ 20240210000000_enable_rls.sql
â   â   âââ 20240215000000_add_pg_cron.sql
â   â   âââ 20240220000000_add_push_tokens.sql
â   â
â   âââ functions/                  # Edge Functions Deno
â   â   âââ _shared/                # Modules partagÃ©s entre les fonctions
â   â   â   âââ cors.ts             # Headers CORS communs
â   â   â   âââ auth.ts             # Validation JWT et helpers d'auth
â   â   â   âââ supabase-client.ts  # Initialisation du client Supabase Admin
â   â   â   âââ openai-client.ts    # Initialisation du client OpenAI
â   â   â   âââ errors.ts           # Gestion centralisÃ©e des erreurs
â   â   â   âââ types.ts            # Types TypeScript partagÃ©s
â   â   â
â   â   âââ ai-recommendations/
â   â   â   âââ index.ts            # GÃ©nÃ©ration de recommandations IA personnalisÃ©es
â   â   â
â   â   âââ health-summary/
â   â   â   âââ index.ts            # SynthÃ¨se hebdomadaire / mensuelle santÃ©
â   â   â
â   â   âââ revenuecat-webhook/
â   â   â   âââ index.ts            # Traitement des Ã©vÃ©nements RevenueCat
â   â   â
â   â   âââ stripe-webhook/
â   â   â   âââ index.ts            # Traitement des Ã©vÃ©nements Stripe
â   â   â
â   â   âââ cron-daily/
â   â   â   âââ index.ts            # TÃ¢che quotidienne planifiÃ©e (rappels, agrÃ©gats)
â   â   â
â   â   âââ user-onboarding/
â   â   â   âââ index.ts            # Initialisation profil utilisateur aprÃ¨s inscription
â   â   â
â   â   âââ push-notifications/
â   â       âââ index.ts            # Envoi de notifications push ciblÃ©es
â   â
â   âââ storage/
â       âââ buckets.sql             # DÃ©finition des buckets Storage et leurs policies
â
âââ tests/
â   âââ integration/
â   â   âââ webhooks.test.ts
â   â   âââ ai-recommendations.test.ts
â   âââ unit/
â       âââ auth.test.ts
â       âââ errors.test.ts
â
âââ scripts/
â   âââ setup-local.sh              # Script d'initialisation environnement local
â   âââ reset-db.sh                 # Reset complet de la base de donnÃ©es locale
â
âââ docs/
â   âââ api-reference.md            # Documentation API dÃ©taillÃ©e
â   âââ database-schema.md          # SchÃ©ma de la base de donnÃ©es
â   âââ webhook-events.md           # RÃ©fÃ©rence des Ã©vÃ©nements webhooks
â
âââ .env.local.example              # Exemple de fichier d'environnement
âââ .gitignore
âââ deno.json                       # Configuration et import map Deno
âââ README.md
```

---

## Setup local

### PrÃ©requis

Assurez-vous d'avoir installÃ© les outils suivants avant de commencer :

| Outil | Version minimale | Lien d'installation |
|---|---|---|
| **Supabase CLI** | 1.150.0 | [docs.supabase.com/guides/cli](https://docs.supabase.com/guides/cli) |
| **Deno** | 1.40.0 | [deno.land](https://deno.land/#installation) |
| **Docker Desktop** | 24.0 | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | 2.40+ | [git-scm.com](https://git-scm.com/) |

VÃ©rifiez les installations :

```bash
supabase --version
deno --version
docker --version
```

---

### 1. Cloner le dÃ©pÃ´t

```bash
git clone https://github.com/votre-organisation/vive-backend.git
cd vive-backend
```

---

### 2. Initialiser et lier Supabase

Si vous dÃ©marrez un nouveau projet Supabase depuis zÃ©ro :

```bash
# Initialiser la configuration locale Supabase
supabase init
```

Pour lier le projet local Ã  votre projet Supabase distant (recommandÃ©) :

```bash
# Se connecter Ã  votre compte Supabase
supabase login

# Lier au projet distant (rÃ©cupÃ©rez le Project ID depuis le tableau de bord Supabase)
supabase link --project-ref <VOTRE_PROJECT_REF>
```

> ð¡ Votre `PROJECT_REF` est disponible dans **Supabase Dashboard â Settings â General â Reference ID**.

---

### 3. Configurer les variables d'environnement

Copiez le fichier d'exemple et renseignez vos valeurs :

```bash
cp .env.local.example .env.local
```

Contenu du fichier `.env.local` :

```dotenv
# âââ Supabase ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# URL de votre projet Supabase (ex: https://xyzabc.supabase.co)
SUPABASE_URL=https://<PROJECT_REF>.supabase.co

# ClÃ© de service Supabase (droits admin â NE JAMAIS exposer cÃ´tÃ© client)
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# âââ OpenAI ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# ClÃ© API OpenAI pour les fonctionnalitÃ©s IA (GPT-4o, Embeddings)
OPENAI_API_KEY=sk-proj-...

# âââ RevenueCat ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# Secret de validation des webhooks RevenueCat
# Disponible dans RevenueCat Dashboard â Webhooks â Webhook Secret
REVENUECAT_WEBHOOK_SECRET=rc_whsec_...

# âââ Stripe ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# Secret de validation des webhooks Stripe
# GÃ©nÃ©rÃ© lors de la configuration d'un endpoint webhook dans Stripe Dashboard
STRIPE_WEBHOOK_SECRET=whsec_...

# âââ TÃ¢ches planifiÃ©es âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
# Secret partagÃ© pour sÃ©curiser les appels aux fonctions cron
CRON_SECRET=un-secret-aleatoire-et-long-genere-localement
```

> â ï¸ **Important :** Ne commitez jamais le fichier `.env.local` dans votre dÃ©pÃ´t Git. Il est dÃ©jÃ  listÃ© dans `.gitignore`.

---

### 4. Appliquer les migrations

DÃ©marrez les services Supabase locaux (requiert Docker) :

```bash
supabase start
```

Appliquez toutes les migrations sur la base de donnÃ©es locale :

```bash
supabase db push
```

Pour charger les donnÃ©es de seed (optionnel, pour le dÃ©veloppement) :

```bash
supabase db reset
# La commande db reset applique les migrations ET le seed.sql automatiquement
```

VÃ©rifiez l'Ã©tat des services locaux :

```bash
supabase status
```

Vous devriez voir les URLs locales de l'API, du Studio, d'Inbucket (emails), etc.

---

### 5. DÃ©marrer les Edge Functions localement

```bash
# Servir toutes les Edge Functions avec rechargement automatique
supabase functions serve --env-file .env.local

# Servir une fonction spÃ©cifique
supabase functions serve ai-recommendations --env-file .env.local

# Servir avec inspection Deno (debug)
supabase functions serve --env-file .env.local --inspect
```

Les fonctions sont disponibles localement sur :
```
http://127.0.0.1:54321/functions/v1/<nom-de-la-fonction>
```

**Tester une fonction localement :**

```bash
curl -i --location --request POST \
  'http://127.0.0.1:54321/functions/v1/health-summary' \
  --header 'Authorization: Bearer <VOTRE_JWT_LOCAL>' \
  --header 'Content-Type: application/json' \
  --data '{"period": "weekly"}'
```

---

## DÃ©ploiement

### 1. DÃ©ployer les Edge Functions

```bash
# DÃ©ployer toutes les fonctions
supabase functions deploy

# DÃ©ployer une fonction spÃ©cifique
supabase functions deploy ai-recommendations
supabase functions deploy revenuecat-webhook
supabase functions deploy stripe-webhook
supabase functions deploy cron-daily
supabase functions deploy user-onboarding
supabase functions deploy push-notifications
supabase functions deploy health-summary
```

---

### 2. Configurer les secrets de production

```bash
# DÃ©finir les secrets un par un
supabase secrets set OPENAI_API_KEY=sk-proj-...
supabase secrets set REVENUECAT_WEBHOOK_SECRET=rc_whsec_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set CRON_SECRET=votre-cron-secret-production

# Ou charger depuis un fichier .env (recommandÃ© pour CI/CD)
supabase secrets set --env-file .env.production

# VÃ©rifier les secrets configurÃ©s
supabase secrets list
```

---

### 3. Configurer l'URL du Webhook RevenueCat

1. Connectez-vous au [Dashboard RevenueCat](https://app.revenuecat.com)
2. Naviguez vers **Project Settings â Integrations â Webhooks**
3. Cliquez sur **Add a new webhook**
4. Configurez les champs suivants :

```
Webhook URL  : https://<PROJECT_REF>.supabase.co/functions/v1/revenuecat-webhook
Secret       : <valeur de REVENUECAT_WEBHOOK_SECRET>
API Version  : V2
```

5. SÃ©lectionnez les Ã©vÃ©nements Ã  recevoir (voir section [Webhooks](#configuration-des-webhooks))
6. Cliquez sur **Save** puis **Send test event** pour valider

---

### 4. Configurer l'URL du Webhook Stripe

```bash
# Via Stripe CLI (recommandÃ© pour les tests)
stripe listen --forward-to https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook
```

Ou via le Dashboard Stripe :

1. AccÃ©dez Ã  [Stripe Dashboard â Developers â Webhooks](https://dashboard.stripe.com/webhooks)
2. Cliquez sur **Add endpoint**
3. Configurez les champs suivants :

```
Endpoint URL : https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook
Version      : 2024-06-20 (derniÃ¨re version stable)
```

4. SÃ©lectionnez les Ã©vÃ©nements Stripe Ã  Ã©couter (voir section [Webhooks](#configuration-des-webhooks))
5. RÃ©cupÃ©rez le **Signing Secret** gÃ©nÃ©rÃ© et mettez Ã  jour `STRIPE_WEBHOOK_SECRET`

---

### 5. Configurer `pg_cron` pour les tÃ¢ches planifiÃ©es

Activez l'extension `pg_cron` dans votre projet Supabase :

1. Allez dans **Supabase Dashboard â Database â Extensions**
2. Recherchez `pg_cron` et activez-la

Ou via SQL dans l'Ã©diteur Supabase :

```sql
-- Activer pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Planifier la tÃ¢che quotidienne (tous les jours Ã  08h00 UTC)
SELECT cron.schedule(
  'vive-daily-cron',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body := jsonb_build_object('triggered_by', 'pg_cron', 'timestamp', now())
  );
  $$
);

-- VÃ©rifier les jobs planifiÃ©s
SELECT * FROM cron.job;

-- Consulter l'historique d'exÃ©cution
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
```

> ð¡ L'extension `pg_net` est nÃ©cessaire pour les appels HTTP depuis `pg_cron`. Elle est activÃ©e par dÃ©faut sur Supabase.

---

## RÃ©fÃ©rence des Edge Functions

| Nom de la fonction | MÃ©thode HTTP | Description | Authentification requise |
|---|---|---|---|
| `ai-recommendations` | `POST` | GÃ©nÃ¨re des recommandations santÃ© personnalisÃ©es via GPT-4o basÃ©es sur les logs utilisateur | â JWT Bearer |
| `health-summary` | `POST` | Produit une synthÃ¨se analytique des donnÃ©es de santÃ© sur une pÃ©riode donnÃ©e (hebdomadaire / mensuelle) | â JWT Bearer |
| `user-onboarding` | `POST` | Initialise le profil santÃ©, les prÃ©fÃ©rences et les objectifs lors de la premiÃ¨re connexion | â JWT Bearer |
| `push-notifications` | `POST` | Envoie des notifications push ciblÃ©es via APNs / FCM (rappels, insights, alertes) | â Service Role |
| `revenuecat-webhook` | `POST` | ReÃ§oit et traite les Ã©vÃ©nements d'abonnements RevenueCat (activation, renouvellement, annulation) | ð Webhook Secret |
| `stripe-webhook` | `POST` | ReÃ§oit et traite les Ã©vÃ©nements de paiement Stripe (checkout, factures, litiges) | ð Webhook Signature |
| `cron-daily` | `POST` | TÃ¢che planifiÃ©e quotidienne : envoi de rappels, calcul d'agrÃ©gats, nettoyage de donnÃ©es | ð Cron Secret |

### DÃ©tail des endpoints

#### `POST /functions/v1/ai-recommendations`

```json
// Corps de la requÃªte
{
  "user_id": "uuid",
  "context": "weekly_review",
  "health_goals": ["sleep", "hydration", "stress"]
}

// RÃ©ponse 200
{
  "recommendations": [
    {
      "category": "sleep",
      "title": "AmÃ©liorer la qualitÃ© du sommeil",
      "description": "BasÃ© sur vos 7 derniers jours...",
      "priority": "high",
      "action_items": ["...", "..."]
    }
  ],
  "generated_at": "2024-03-15T08:00:00Z",
  "model_used": "gpt-4o"
}
```

#### `POST /functions/v1/health-summary`

```json
// Corps de la requÃªte
{
  "period": "weekly",
  "start_date": "2024-03-08",
  "end_date": "2024-03-15"
}

// RÃ©ponse 200
{
  "summary": {
    "period": "weekly",
    "metrics": {
      "avg_sleep_hours": 7.2,
      "avg_water_ml": 1850,
      "avg_stress_level": 4.1,
      "workout_sessions": 3
    },
    "score": 72,
    "trend": "improving"
  }
}
```

---

## SchÃ©ma de base de donnÃ©es

### Vue d'ensemble des tables

| Table | Description | ClÃ©s principales |
|---|---|---|
| `users` | Profils utilisateurs Ã©tendus (complÃ¨te `auth.users`) | `id` (FK â `auth.users`) |
| `user_preferences` | PrÃ©fÃ©rences de l'application (langue, notifications, thÃ¨me) | `user_id` |
| `health_logs` | Journaux de santÃ© quotidiens (sommeil, eau, stress, humeur, activitÃ©) | `id`, `user_id`, `logged_at` |
| `goals` | Objectifs santÃ© dÃ©finis par l'utilisateur avec suivi de progression | `id`, `user_id`, `category` |
| `ai_insights` | Insights et recommandations gÃ©nÃ©rÃ©s par l'IA, horodatÃ©s | `id`, `user_id`, `created_at` |
| `subscriptions` | Statut des abonnements actifs (source, plan, dates de validitÃ©) | `id`, `user_id`, `provider` |
| `subscription_events` | Historique complet des Ã©vÃ©nements d'abonnement (audit trail) | `id`, `subscription_id` |
| `push_tokens` | Tokens APNs / FCM des appareils pour les notifications push | `id`, `user_id`, `platform` |
| `notifications_log` | Historique des notifications envoyÃ©es et leur statut de livraison | `id`, `user_id`, `sent_at` |
| `cron_executions` | Journal d'exÃ©cution des tÃ¢ches planifiÃ©es `cron-daily` | `id`, `executed_at`, `status` |

### DÃ©tail des tables principales

```sql
-- Profil utilisateur Ã©tendu
CREATE TABLE public.users (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name    TEXT,
  avatar_url      TEXT,
  date_of_birth   DATE,
  gender          TEXT CHECK (gender IN ('male', 'female', 'non_binary', 'prefer_not_to_say')),
  height_cm       NUMERIC(5,2),
  weight_kg       NUMERIC(5,2),
  timezone        TEXT DEFAULT 'UTC',
  onboarded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Journaux de santÃ©
CREATE TABLE public.health_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  logged_at       DATE NOT NULL DEFAULT CURRENT_DATE,
  sleep_hours     NUMERIC(4,2),
  sleep_quality   INTEGER CHECK (sleep_quality BETWEEN 1 AND 10),
  water_ml        INTEGER,
  stress_level    INTEGER CHECK (stress_level BETWEEN 1 AND 10),
  mood_score      INTEGER CHECK (mood_score BETWEEN 1 AND 10),
  energy_level    INTEGER CHECK (energy_level BETWEEN 1 AND 10),
  workout_minutes INTEGER,
  workout_type    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, logged_at)
);

-- Objectifs santÃ©
CREATE TABLE public.goals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  target_value    NUMERIC,
  current_value   NUMERIC DEFAULT 0,
  unit            TEXT,
  deadline        DATE,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'cancelled')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Abonnements
CREATE TABLE public.subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('revenuecat', 'stripe')),
  provider_user_id    TEXT,
  product_id          TEXT NOT NULL,
  plan_name           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('active', 'expired', 'cancelled', 'paused', 'grace_period', 'billing_retry')),
  current_period_start TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  trial_end           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- Insights IA
CREATE TABLE public.ai_insights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  context         TEXT,
  recommendations JSONB NOT NULL,
  model_used      TEXT DEFAULT 'gpt-4o',
  tokens_used     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Configuration des Webhooks

### ÃvÃ©nements RevenueCat

| ÃvÃ©nement RevenueCat | Type | Action effectuÃ©e dans VIVE |
|---|---|---|
| `INITIAL_PURCHASE` | Achat | CrÃ©ation abonnement, activation accÃ¨s Premium |
| `RENEWAL` | Renouvellement | Mise Ã  jour `current_period_end`, envoi notification |
| `CANCELLATION` | Annulation | Mise Ã  jour statut `cancel_at_period_end = true` |
| `UNCANCELLATION` | RÃ©activation | Remise Ã  `cancel_at_period_end = false` |
| `BILLING_ISSUE` | ProblÃ¨me paiement | Passage au statut `billing_retry`, notification utilisateur |
| `PRODUCT_CHANGE` | Changement de plan | Mise Ã  jour `product_id` et `plan_name` |
| `EXPIRATION` | Expiration | Statut `expired`, rÃ©vocation accÃ¨s Premium |
| `TRANSFER` | Transfert compte | RÃ©association de l'abonnement au nouvel utilisateur |
| `TRIAL_STARTED` | DÃ©but essai | Enregistrement `trial_end`, accÃ¨s temporaire |
| `TRIAL_CONVERTED` | Essai â Payant | Conversion vers abonnement actif |
| `TRIAL_CANCELLED` | Annulation essai | Fin d'accÃ¨s Ã  la date `trial_end` |

### ÃvÃ©nements Stripe

| ÃvÃ©nement Stripe | Action effectuÃ©e dans VIVE |
|---|---|
| `checkout.session.completed` | CrÃ©ation abonnement aprÃ¨s paiement initial rÃ©ussi |
| `customer.subscription.created` | Initialisation de l'enregistrement d'abonnement |
| `customer.subscription.updated` | Mise Ã  jour statut, pÃ©riode, annulation en fin de pÃ©riode |
| `customer.subscription.deleted` | Suppression / expiration de l'abonnement |
| `invoice.payment_succeeded` | Renouvellement confirmÃ©, mise Ã  jour `current_period_end` |
| `invoice.payment_failed` | Passage en `billing_retry`, notification de l'utilisateur |
| `customer.subscription.trial_will_end` | Notification prÃ©ventive 3 jours avant fin d'essai |
| `charge.dispute.created` | Alerte interne, suspension prÃ©ventive si fraude avÃ©rÃ©e |

### Validation des signatures de webhook

Chaque webhook est validÃ© avant traitement :

```typescript
// Exemple de validation RevenueCat (Edge Function)
const signature = req.headers.get('X-RevenueCat-Signature');
const body = await req.text();
const expectedSig = await hmacSHA256(body, Deno.env.get('REVENUECAT_WEBHOOK_SECRET'));

if (!timingSafeEqual(signature, expectedSig)) {
  return new Response('Unauthorized', { status: 401 });
}

// Exemple de validation Stripe
const stripeSignature = req.headers.get('Stripe-Signature');
const isValid = await stripe.webhooks.constructEventAsync(
  body, stripeSignature, Deno.env.get('STRIPE_WEBHOOK_SECRET')
);
```

---

## SÃ©curitÃ©

### Row Level Security (RLS)

Toutes les tables contenant des donnÃ©es utilisateur ont RLS activÃ©. Les utilisateurs ne peuvent accÃ©der qu'Ã  leurs propres donnÃ©es.

```sql
-- Exemple de policies RLS sur health_logs
ALTER TABLE public.health_logs ENABLE ROW LEVEL SECURITY;

-- Lecture : uniquement ses propres logs
CREATE POLICY "users_read_own_health_logs"
  ON public.health_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Ãcriture : uniquement ses propres logs
CREATE POLICY "users_insert_own_health_logs"
  ON public.health_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Modification : uniquement ses propres logs
CREATE POLICY "users_update_own_health_logs"
  ON public.health_logs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Suppression : uniquement ses propres logs
CREATE POLICY "users_delete_own_health_logs"
  ON public.health_logs FOR DELETE
  USING (auth.uid() = user_id);

-- Les fonctions Edge avec service_role contournent le RLS (comportement attendu et sÃ©curisÃ©)
```

### Validation JWT

- Toutes les Edge Functions exposÃ©es aux utilisateurs valident le token JWT Supabase dans l'en-tÃªte `Authorization: Bearer <token>`
- Le token est vÃ©rifiÃ© avec `SUPABASE_JWT_SECRET` (gÃ©rÃ© automatiquement par la plateforme Supabase)
- Les tokens expirÃ©s sont rejetÃ©s avec une rÃ©ponse `401 Unauthorized`
- Le `user_id` extrait du JWT est utilisÃ© pour toutes les requÃªtes en base (jamais passÃ© en paramÃ¨tre non validÃ©)

```typescript
// Validation JWT dans _shared/auth.ts
export async function validateUser(req: Request): Promise<User> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Token manquant');
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) throw new UnauthorizedError('Token invalide ou expirÃ©');
  return user;
}
```

### Signatures des Webhooks

| Webhook | MÃ©canisme de validation | En-tÃªte HTTP |
|---|---|---|
| RevenueCat | HMAC-SHA256 avec secret partagÃ© | `X-RevenueCat-Signature` |
| Stripe | ECDSA / HMAC via SDK Stripe | `Stripe-Signature` |
| Cron interne | Bearer token secret partagÃ© | `Authorization` |

- Toutes les comparaisons de signatures utilisent des fonctions Ã  **temps constant** (`timingSafeEqual`) pour prÃ©venir les attaques par timing
- Les webhooks non validÃ©s reÃ§oivent systÃ©matiquement une rÃ©ponse `401` sans dÃ©tail d'erreur

### Chiffrement des donnÃ©es de santÃ©

> ð **Note de conformitÃ© :** Les donnÃ©es de santÃ© (logs, objectifs, insights) sont des donnÃ©es sensibles relevant potentiellement du RGPD et du HIPAA selon les marchÃ©s cibles.

**Mesures en place :**

- **En transit :** Toutes les communications utilisent TLS 1.3 (enforced par Supabase)
- **Au repos :** Le stockage PostgreSQL de Supabase est chiffrÃ© at-rest (AES-256) au niveau de l'infrastructure
- **Chiffrement applicatif (recommandÃ© pour production) :** Les colonnes particuliÃ¨rement sensibles (`notes`, donnÃ©es biomÃ©triques) peuvent Ãªtre chiffrÃ©es au niveau applicatif avec `pgcrypto` avant insertion
- **Anonymisation :** Lors de l'envoi Ã  OpenAI, les donnÃ©es sont pseudonymisÃ©es (remplacement de l'UUID par un identifiant de session temporaire)
- **Politique de rÃ©tention :** DÃ©finissez une politique de rÃ©tention des donnÃ©es dans `cron-daily` (suppression des logs > N mois selon consentement utilisateur)

```sql
-- Exemple de chiffrement applicatif avec pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Chiffrer une valeur sensible avant stockage
INSERT INTO health_logs (user_id, notes)
VALUES (
  auth.uid(),
  pgp_sym_encrypt('Notes sensibles ici', current_setting('app.encryption_key'))
);

-- DÃ©chiffrer lors de la lecture
SELECT pgp_sym_decrypt(notes::bytea, current_setting('app.encryption_key'))
FROM health_logs WHERE user_id = auth.uid();
```

### Bonnes pratiques gÃ©nÃ©rales

- ð **Rotation des secrets :** Faites tourner `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` et les secrets webhook rÃ©guliÃ¨rement (tous les 90 jours recommandÃ©s)
- ð« **Principe du moindre privilÃ¨ge :** Les Edge Functions utilisent le client `service_role` uniquement quand nÃ©cessaire ; prÃ©fÃ©rez le client authentifiÃ© avec le JWT utilisateur
- ð **Audit logging :** La table `subscription_events` constitue un audit trail complet des Ã©vÃ©nements financiers
- ð **Monitoring :** Activez les alertes Supabase sur les tentatives d'authentification Ã©chouÃ©es et les pics d'utilisation inhabituels
- ð **CORS :** Les origines autorisÃ©es sont strictement dÃ©finies dans `_shared/cors.ts` (pas de wildcard `*` en production)

---

## Licence

```
MIT License

Copyright (c) 2024 VIVE Health Technologies

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<div align="center">

Fait avec â¤ï¸ par l'Ã©quipe **VIVE Health Technologies**

[Documentation API](./docs/api-reference.md) Â· [SchÃ©ma BDD](./docs/database-schema.md) Â· [RÃ©fÃ©rence Webhooks](./docs/webhook-events.md)

</div>
