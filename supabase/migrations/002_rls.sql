-- ============================================================
-- 002_rls.sql  -  Row Level Security policies for VIVE backend
-- ============================================================
-- Enable RLS on every table first, then define policies.
-- service_role always bypasses RLS (Supabase default).
-- auth.uid()  - UUID of the currently authenticated user
-- auth.role() - 'authenticated' | 'anon' | 'service_role'
-- ============================================================


-- ============================================================
-- HELPER: lecture securisee du role JWT (protege contre JSON invalide)
-- ============================================================
CREATE OR REPLACE FUNCTION safe_jwt_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_role   text;
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_role := (v_claims::jsonb)->>'role';
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;
  RETURN v_role;
END;
$$;


-- ============================================================
-- HELPER: fonction utilitaire pour verifier le role courant
-- ============================================================
CREATE OR REPLACE FUNCTION is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT current_setting('role', true) = 'service_role'
     OR safe_jwt_role() = 'service_role';
$$;


-- ============================================================
-- PROFILES
-- Users can read and update their own profile row.
-- INSERT is handled by a trigger (on auth.users), so no INSERT
-- policy is needed for regular users.
--
-- PROTECTION: plan et email sont des colonnes protegees.
-- Un trigger BEFORE UPDATE empeche l'utilisateur de les modifier.
-- email doit rester synchronise avec auth.users via trigger.
-- plan ne doit etre modifie que par service_role (webhook paiement).
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: owner can select"
  ON profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY "profiles: owner can update"
  ON profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Trigger qui protege les colonnes sensibles de profiles
-- contre toute modification directe par un utilisateur.
CREATE OR REPLACE FUNCTION protect_profiles_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  -- Seul service_role peut modifier plan et email
  IF current_setting('role', true) != 'service_role'
     AND safe_jwt_role() != 'service_role'
  THEN
    -- Forcer la preservation des colonnes protegees
    NEW.plan  := OLD.plan;
    NEW.email := OLD.email;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profiles_sensitive_columns ON profiles;
CREATE TRIGGER trg_protect_profiles_sensitive_columns
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_profiles_sensitive_columns();


-- ============================================================
-- SUBSCRIPTIONS
-- Users can view their own subscription record.
-- All mutations are performed by service_role (webhooks /
-- edge functions), so no user-facing write policies are needed.
-- ============================================================
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions: owner can select"
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE intentionally omitted for regular
-- users; service_role bypasses RLS automatically.


-- ============================================================
-- CONSENT_RECORDS
-- Users record their own consent and can audit what they
-- have consented to. No updates/deletes - consent is immutable.
-- ============================================================
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "consent_records: owner can insert"
  ON consent_records
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "consent_records: owner can select"
  ON consent_records
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE / DELETE intentionally omitted: consent records are immutable.


-- ============================================================
-- HEALTH_ACCESS_LOG
-- Append-only audit trail written by edge functions
-- (service_role). Users may view their own log entries;
-- no user-facing write access.
-- ============================================================
ALTER TABLE health_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "health_access_log: owner can select"
  ON health_access_log
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role only.


-- ============================================================
-- HEALTH_SAMPLES
-- Raw health samples uploaded from the mobile client.
-- Users INSERT and SELECT only their own samples.
--
-- PROTECTION:
--   1. Contrainte UNIQUE sur (user_id, sample_type, recorded_at)
--      pour eviter les doublons.
--   2. Trigger BEFORE INSERT qui limite le volume journalier
--      a 10 000 insertions par utilisateur par jour afin
--      d'eviter un DoS sur le stockage.
-- ============================================================
ALTER TABLE health_samples ENABLE ROW LEVEL SECURITY;

-- Contrainte de deduplication (idempotence des uploads)
ALTER TABLE health_samples
  DROP CONSTRAINT IF EXISTS uq_health_samples_user_type_time;
ALTER TABLE health_samples
  ADD CONSTRAINT uq_health_samples_user_type_time
  UNIQUE (user_id, sample_type, recorded_at);

-- Trigger de rate-limiting journalier par utilisateur
CREATE OR REPLACE FUNCTION check_health_samples_daily_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
  v_limit constant integer := 10000;
BEGIN
  -- Ne s'applique pas au service_role
  IF current_setting('role', true) = 'service_role'
     OR safe_jwt_role() = 'service_role'
  THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)
    INTO v_count
    FROM health_samples
   WHERE user_id   = NEW.user_id
     AND recorded_at >= CURRENT_DATE
     AND recorded_at <  CURRENT_DATE + INTERVAL '1 day';

  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'daily_health_samples_limit_exceeded: max % insertions per day per user', v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_health_samples_daily_limit ON health_samples;
CREATE TRIGGER trg_check_health_samples_daily_limit
  BEFORE INSERT ON health_samples
  FOR EACH ROW
  EXECUTE FUNCTION check_health_samples_daily_limit();

CREATE POLICY "health_samples: owner can insert"
  ON health_samples
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "health_samples: owner can select"
  ON health_samples
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());


-- ============================================================
-- HEALTH_DAILY_AGGREGATES
-- Pre-computed daily roll-ups produced by edge functions.
-- Users may read their own aggregates; writes are
-- exclusively via service_role.
-- ============================================================
ALTER TABLE health_daily_aggregates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "health_daily_aggregates: owner can select"
  ON health_daily_aggregates
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role only.


-- ============================================================
-- JARVIS_STATES
-- Each user has a single Jarvis AI state row.
-- Users can read and update their own state;
-- service_role handles initial creation and system columns.
--
-- PROTECTION: colonnes systeme (computed_level, total_sessions,
-- last_computed_at, xp_total) ne peuvent etre modifiees
-- que par service_role. Le trigger BEFORE UPDATE restaure
-- ces valeurs de facon statique si le role est 'authenticated'.
-- ============================================================
ALTER TABLE jarvis_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jarvis_states: owner can select"
  ON jarvis_states
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "jarvis_states: owner can update"
  ON jarvis_states
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Trigger qui protege les colonnes systeme de jarvis_states.
-- Les colonnes protegees sont referencees statiquement.
CREATE OR REPLACE FUNCTION protect_jarvis_states_system_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Seul service_role peut modifier les colonnes systeme
  IF current_setting('role', true) != 'service_role'
     AND safe_jwt_role() != 'service_role'
  THEN
    -- Restaurer les colonnes systeme depuis OLD (references statiques)
    NEW.computed_level   := OLD.computed_level;
    NEW.xp_total         := OLD.xp_total;
    NEW.total_sessions   := OLD.total_sessions;
    NEW.last_computed_at := OLD.last_computed_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_jarvis_states_system_columns ON jarvis_states;
CREATE TRIGGER trg_protect_jarvis_states_system_columns
  BEFORE UPDATE ON jarvis_states
  FOR EACH ROW
  EXECUTE FUNCTION protect_jarvis_states_system_columns();


-- ============================================================
-- MISSIONS
-- Missions are created by service_role (scheduled jobs /
-- edge functions). Users can read their own missions and
-- mark them as complete via UPDATE.
--
-- PROTECTION: seules les colonnes status et completed_at
-- peuvent etre mises a jour par l'utilisateur. Les colonnes
-- sensibles (type, reward_xp, user_id) sont verifiees dans
-- un trigger afin qu'elles ne puissent pas etre alterees.
-- ============================================================
ALTER TABLE missions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "missions: owner can select"
  ON missions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- La policy UPDATE autorise uniquement la modification
-- des colonnes de completion (status, completed_at).
-- Les autres colonnes sensibles sont verifiees via un trigger.
CREATE POLICY "missions: owner can update status only"
  ON missions
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Trigger qui empeche l'utilisateur de modifier les colonnes
-- sensibles d'une mission.
CREATE OR REPLACE FUNCTION protect_missions_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Seul service_role peut modifier les colonnes metier
  IF current_setting('role', true) != 'service_role'
     AND safe_jwt_role() != 'service_role'
  THEN
    -- Verifier que les colonnes sensibles n'ont pas change
    IF NEW.user_id    IS DISTINCT FROM OLD.user_id    THEN
      RAISE EXCEPTION 'permission_denied: cannot modify user_id on missions'
        USING ERRCODE = 'P0002';
    END IF;
    IF NEW.type       IS DISTINCT FROM OLD.type       THEN
      RAISE EXCEPTION 'permission_denied: cannot modify type on missions'
        USING ERRCODE = 'P0002';
    END IF;
    IF NEW.reward_xp  IS DISTINCT FROM OLD.reward_xp  THEN
      RAISE EXCEPTION 'permission_denied: cannot modify reward_xp on missions'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_missions_sensitive_columns ON missions;
CREATE TRIGGER trg_protect_missions_sensitive_columns
  BEFORE UPDATE ON missions
  FOR EACH ROW
  EXECUTE FUNCTION protect_missions_sensitive_columns();


-- ============================================================
-- CHECK_INS
-- Users submit daily/event check-ins from the mobile app
-- and can review their own history.
-- ============================================================
ALTER TABLE check_ins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "check_ins: owner can insert"
  ON check_ins
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "check_ins: owner can select"
  ON check_ins
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE / DELETE intentionally omitted: check-ins are immutable.


-- ============================================================
-- MODULES
-- Content catalog. Authenticated users can browse modules
-- selon leur plan actif.
-- La colonne required_plan sur modules definit le plan minimum
-- requis pour acceder au module:
--   NULL ou 'free' => accessible a tous les authentifies
--   autres valeurs => necessite un abonnement actif correspondant
-- ============================================================
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "modules: authenticated users can select"
  ON modules
  FOR SELECT
  TO authenticated
  USING (
    required_plan IS NULL
    OR required_plan = 'free'
    OR EXISTS (
      SELECT 1
        FROM subscriptions s
       WHERE s.user_id = auth.uid()
         AND s.plan    = modules.required_plan
         AND s.status  = 'active'
    )
  );

-- INSERT / UPDATE / DELETE intentionally omitted for regular
-- users; service_role bypasses RLS automatically.


-- ============================================================
-- BOX_ORDERS
-- Physical supplement box orders. Users view their own
-- orders. Creation is handled by service_role (payment
-- webhook edge function).
-- ============================================================
ALTER TABLE box_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "box_orders: owner can select"
  ON box_orders
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role only.


-- ============================================================
-- SWAP_TOKENS
-- One-time-use tokens that let users swap a supplement.
-- La consommation du token (marquage used=true) est geree
-- EXCLUSIVEMENT par service_role via une edge function.
-- Aucune policy UPDATE n'est accordee aux utilisateurs afin
-- d'eviter toute manipulation d'etat (reactivation, extension
-- d'expiration, modification du swap_type).
-- ============================================================
ALTER TABLE swap_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "swap_tokens: owner can select"
  ON swap_tokens
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE intentionally omitted for authenticated users.
-- Token consumption is handled exclusively by service_role
-- edge functions to prevent state manipulation attacks.


-- ============================================================
-- XP_EVENTS
-- Immutable ledger of XP-earning events written by
-- edge functions / triggers (service_role). Users can
-- view their own XP history.
-- ============================================================
ALTER TABLE xp_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "xp_events: owner can select"
  ON xp_events
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role only.


-- ============================================================
-- USER_LEVELS
-- Computed level derived from XP; updated by triggers.
-- Users may read their own level row; no direct writes.
-- ============================================================
ALTER TABLE user_levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_levels: owner can select"
  ON user_levels
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role / triggers only.


-- ============================================================
-- STREAKS
-- Streak counters updated by triggers / edge functions.
-- Users can view their own streak data; mutations are
-- handled internally by the system.
-- ============================================================
ALTER TABLE streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "streaks: owner can select"
  ON streaks
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT / UPDATE / DELETE reserved for service_role / triggers only.


-- ============================================================
-- JOBS
-- Internal background-job queue consumed exclusively by
-- service_role workers. No user-facing policies are defined;
-- service_role bypasses RLS, and authenticated/anon roles
-- are denied access implicitly by enabling RLS with no
-- permissive policies for those roles.
-- ============================================================
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated or anon roles.
-- service_role accesses this table outside of RLS.
