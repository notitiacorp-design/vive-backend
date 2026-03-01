-- =============================================================================
-- VIVE Health Concierge App - Initial Migration
-- 001_initial.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

-- =============================================================================
-- UTILITY FUNCTIONS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Function: update updated_at timestamp automatically
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- REFERENCE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- health_metric_types (reference table for valid metric codes)
-- ---------------------------------------------------------------------------
CREATE TABLE public.health_metric_types (
  code         text NOT NULL,
  unit_default text NOT NULL,
  description  text,
  CONSTRAINT health_metric_types_pkey PRIMARY KEY (code)
);

COMMENT ON TABLE public.health_metric_types IS 'Reference table for valid health metric type codes';

-- Seed with common metric types
INSERT INTO public.health_metric_types (code, unit_default, description) VALUES
  ('heart_rate',          'bpm',   'Heart rate in beats per minute'),
  ('steps',              'count', 'Step count'),
  ('sleep_duration',     'min',   'Sleep duration in minutes'),
  ('hrv',                'ms',    'Heart rate variability in milliseconds'),
  ('spo2',               '%',     'Blood oxygen saturation'),
  ('respiratory_rate',   'brpm',  'Respiratory rate in breaths per minute'),
  ('body_temperature',   'c',     'Body temperature in Celsius'),
  ('active_energy',      'kcal',  'Active energy burned in kilocalories'),
  ('resting_energy',     'kcal',  'Resting energy burned in kilocalories'),
  ('weight',             'kg',    'Body weight in kilograms'),
  ('body_fat',           '%',     'Body fat percentage'),
  ('blood_pressure_sys', 'mmhg',  'Systolic blood pressure'),
  ('blood_pressure_dia', 'mmhg',  'Diastolic blood pressure'),
  ('glucose',            'mg/dl', 'Blood glucose level'),
  ('vo2_max',            'ml/kg/min', 'VO2 max'),
  ('mindful_minutes',    'min',   'Mindfulness minutes');

-- =============================================================================
-- TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id                    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email                 citext      NOT NULL,
  full_name             text,
  avatar_url            text,
  plan                  text        NOT NULL DEFAULT 'free'
                          CHECK (plan IN ('free', 'essential', 'premium')),
  onboarding_completed  boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_email_check CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$')
);

COMMENT ON TABLE public.profiles IS 'Extended user profile data linked to auth.users';

CREATE UNIQUE INDEX idx_profiles_email      ON public.profiles (email);
CREATE INDEX idx_profiles_plan             ON public.profiles (plan);
CREATE INDEX idx_profiles_created_at       ON public.profiles (created_at);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE public.subscriptions (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan                    text        NOT NULL CHECK (plan IN ('free', 'essential', 'premium')),
  status                  text        NOT NULL CHECK (status IN ('active', 'cancelled', 'expired', 'trial', 'past_due')),
  revenuecat_customer_id  text,
  current_period_end      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.subscriptions IS 'Subscription records per user, managed via RevenueCat';

CREATE INDEX idx_subscriptions_user_id            ON public.subscriptions (user_id);
CREATE INDEX idx_subscriptions_status             ON public.subscriptions (status);
CREATE INDEX idx_subscriptions_revenuecat         ON public.subscriptions (revenuecat_customer_id);
CREATE INDEX idx_subscriptions_current_period_end ON public.subscriptions (current_period_end);
-- Partial unique index: only one active subscription per user at a time
CREATE UNIQUE INDEX idx_subscriptions_user_active
  ON public.subscriptions (user_id)
  WHERE status = 'active';

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- consent_records
-- ---------------------------------------------------------------------------
CREATE TABLE public.consent_records (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  consent_type  text        NOT NULL,
  version       text        NOT NULL,
  granted       boolean     NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  ip_hash       text        CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{64}$'),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_records_pkey PRIMARY KEY (id),
  CONSTRAINT consent_records_type_check CHECK (
    consent_type IN (
      'gdpr_data_processing',
      'hipaa_authorization',
      'marketing',
      'analytics',
      'terms_of_service',
      'privacy_policy'
    )
  )
);

COMMENT ON TABLE public.consent_records IS 'Audit trail for user consent (GDPR/HIPAA)';

CREATE INDEX idx_consent_records_user_id      ON public.consent_records (user_id);
CREATE INDEX idx_consent_records_consent_type ON public.consent_records (consent_type);
CREATE INDEX idx_consent_records_granted_at   ON public.consent_records (granted_at);

CREATE TRIGGER trg_consent_records_updated_at
  BEFORE UPDATE ON public.consent_records
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- health_access_log
-- ---------------------------------------------------------------------------
CREATE TABLE public.health_access_log (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  accessor    text        NOT NULL,
  purpose     text        NOT NULL,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_access_log_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.health_access_log IS 'Audit log for health data access (HIPAA compliance)';

CREATE INDEX idx_health_access_log_user_id     ON public.health_access_log (user_id);
CREATE INDEX idx_health_access_log_accessed_at ON public.health_access_log (accessed_at);
CREATE INDEX idx_health_access_log_accessor    ON public.health_access_log (accessor);

-- ---------------------------------------------------------------------------
-- health_samples
-- ---------------------------------------------------------------------------
CREATE TABLE public.health_samples (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source      text        NOT NULL,
  metric_type text        NOT NULL REFERENCES public.health_metric_types(code),
  start_ts    timestamptz NOT NULL,
  end_ts      timestamptz,
  value       numeric     NOT NULL,
  unit        text        NOT NULL,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_samples_pkey PRIMARY KEY (id),
  CONSTRAINT health_samples_unique UNIQUE (user_id, source, metric_type, start_ts),
  CONSTRAINT health_samples_end_after_start CHECK (end_ts IS NULL OR end_ts >= start_ts),
  CONSTRAINT health_samples_metadata_size CHECK (pg_column_size(metadata) < 10240)
);

COMMENT ON TABLE public.health_samples IS 'Raw health data samples from HealthKit / wearables';

CREATE INDEX idx_health_samples_user_id      ON public.health_samples (user_id);
CREATE INDEX idx_health_samples_metric_type  ON public.health_samples (metric_type);
CREATE INDEX idx_health_samples_start_ts     ON public.health_samples (start_ts);
CREATE INDEX idx_health_samples_source       ON public.health_samples (source);
CREATE INDEX idx_health_samples_created_at   ON public.health_samples (created_at);
CREATE INDEX idx_health_samples_user_metric  ON public.health_samples (user_id, metric_type, start_ts DESC);
-- Partial index for recent data queries (dashboard, charts)
CREATE INDEX idx_health_samples_recent
  ON public.health_samples (user_id, metric_type, start_ts DESC)
  WHERE start_ts >= now() - INTERVAL '90 days';

CREATE TRIGGER trg_health_samples_updated_at
  BEFORE UPDATE ON public.health_samples
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- health_daily_aggregates
-- ---------------------------------------------------------------------------
CREATE TABLE public.health_daily_aggregates (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date         date        NOT NULL,
  metric_type  text        NOT NULL REFERENCES public.health_metric_types(code),
  value        numeric     NOT NULL,
  unit         text        NOT NULL,
  sample_count int         NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_daily_aggregates_pkey PRIMARY KEY (id),
  CONSTRAINT health_daily_aggregates_unique UNIQUE (user_id, date, metric_type)
);

COMMENT ON TABLE public.health_daily_aggregates IS 'Pre-computed daily aggregates of health samples';

CREATE INDEX idx_health_daily_user_id     ON public.health_daily_aggregates (user_id);
CREATE INDEX idx_health_daily_date        ON public.health_daily_aggregates (date);
CREATE INDEX idx_health_daily_metric_type ON public.health_daily_aggregates (metric_type);
CREATE INDEX idx_health_daily_user_date   ON public.health_daily_aggregates (user_id, date DESC);

-- Trigger covers both INSERT and UPDATE to keep updated_at accurate
CREATE TRIGGER trg_health_daily_aggregates_updated_at
  BEFORE INSERT OR UPDATE ON public.health_daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- jarvis_states
-- ---------------------------------------------------------------------------
CREATE TABLE public.jarvis_states (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_state    text        NOT NULL DEFAULT 'onboarding'
                     CHECK (current_state IN ('onboarding', 'assessment', 'active', 'paused', 'complete')),
  bottleneck       text,
  active_objective text,
  last_analysis    timestamptz,
  context          jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jarvis_states_pkey PRIMARY KEY (id),
  CONSTRAINT jarvis_states_user_id_key UNIQUE (user_id)
);

COMMENT ON TABLE public.jarvis_states IS 'JARVIS AI concierge state machine per user';

CREATE INDEX idx_jarvis_states_user_id       ON public.jarvis_states (user_id);
CREATE INDEX idx_jarvis_states_current_state ON public.jarvis_states (current_state);

CREATE TRIGGER trg_jarvis_states_updated_at
  BEFORE UPDATE ON public.jarvis_states
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- missions
-- ---------------------------------------------------------------------------
CREATE TABLE public.missions (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  description text,
  category    text        NOT NULL,
  difficulty  text        NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard', 'expert')),
  xp_reward   int         NOT NULL DEFAULT 0 CHECK (xp_reward >= 0),
  due_date    date,
  status      text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missions_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.missions IS 'Gamified missions assigned to users by JARVIS';

CREATE INDEX idx_missions_user_id    ON public.missions (user_id);
CREATE INDEX idx_missions_status     ON public.missions (status);
CREATE INDEX idx_missions_due_date   ON public.missions (due_date);
CREATE INDEX idx_missions_category   ON public.missions (category);
CREATE INDEX idx_missions_created_at ON public.missions (created_at);
CREATE INDEX idx_missions_user_status ON public.missions (user_id, status);

CREATE TRIGGER trg_missions_updated_at
  BEFORE UPDATE ON public.missions
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- check_ins
-- ---------------------------------------------------------------------------
CREATE TABLE public.check_ins (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date          date        NOT NULL DEFAULT CURRENT_DATE,
  energy_score  int         NOT NULL CHECK (energy_score BETWEEN 1 AND 10),
  sleep_quality int         NOT NULL CHECK (sleep_quality BETWEEN 1 AND 10),
  stress_level  int         NOT NULL CHECK (stress_level BETWEEN 1 AND 10),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_ins_pkey PRIMARY KEY (id),
  CONSTRAINT check_ins_user_date_unique UNIQUE (user_id, date)
);

COMMENT ON TABLE public.check_ins IS 'Daily wellness check-ins from users';

CREATE INDEX idx_check_ins_user_id    ON public.check_ins (user_id);
CREATE INDEX idx_check_ins_date       ON public.check_ins (date);
CREATE INDEX idx_check_ins_created_at ON public.check_ins (created_at);
CREATE INDEX idx_check_ins_user_date  ON public.check_ins (user_id, date DESC);

CREATE TRIGGER trg_check_ins_updated_at
  BEFORE UPDATE ON public.check_ins
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- modules
-- ---------------------------------------------------------------------------
CREATE TABLE public.modules (
  id          uuid    NOT NULL DEFAULT gen_random_uuid(),
  name        text    NOT NULL,
  category    text    NOT NULL,
  description text,
  objective   text,
  stock       int     NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT modules_pkey PRIMARY KEY (id),
  CONSTRAINT modules_name_unique UNIQUE (name)
);

COMMENT ON TABLE public.modules IS 'Physical product modules available for VIVE boxes';

CREATE INDEX idx_modules_category ON public.modules (category);
CREATE INDEX idx_modules_active   ON public.modules (active);

CREATE TRIGGER trg_modules_updated_at
  BEFORE UPDATE ON public.modules
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- box_orders
-- ---------------------------------------------------------------------------
CREATE TABLE public.box_orders (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  month_year        text        NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'validation', 'locked', 'shipped', 'delivered', 'cancelled')),
  mode              text        NOT NULL DEFAULT 'validation'
                      CHECK (mode IN ('validation', 'automatic')),
  hero_module_id    uuid        REFERENCES public.modules(id) ON DELETE SET NULL,
  mystery_module_id uuid        REFERENCES public.modules(id) ON DELETE SET NULL,
  validated_at      timestamptz,
  locked_at         timestamptz,
  shipped_at        timestamptz,
  tracking_number   text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT box_orders_pkey PRIMARY KEY (id),
  CONSTRAINT box_orders_user_month_unique UNIQUE (user_id, month_year),
  CONSTRAINT box_orders_month_year_format CHECK (month_year ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

COMMENT ON TABLE public.box_orders IS 'Monthly VIVE box orders per user';

CREATE INDEX idx_box_orders_user_id        ON public.box_orders (user_id);
CREATE INDEX idx_box_orders_status         ON public.box_orders (status);
CREATE INDEX idx_box_orders_month_year     ON public.box_orders (month_year);
CREATE INDEX idx_box_orders_hero_module    ON public.box_orders (hero_module_id);
CREATE INDEX idx_box_orders_mystery_module ON public.box_orders (mystery_module_id);
CREATE INDEX idx_box_orders_shipped_at     ON public.box_orders (shipped_at);

CREATE TRIGGER trg_box_orders_updated_at
  BEFORE UPDATE ON public.box_orders
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- swap_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE public.swap_tokens (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  month_year text        NOT NULL,
  used       boolean     NOT NULL DEFAULT false,
  used_at    timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swap_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT swap_tokens_user_month_unique UNIQUE (user_id, month_year),
  CONSTRAINT swap_tokens_month_year_format CHECK (month_year ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

COMMENT ON TABLE public.swap_tokens IS 'One swap token per user per month for box module replacement';

CREATE INDEX idx_swap_tokens_user_id    ON public.swap_tokens (user_id);
CREATE INDEX idx_swap_tokens_month_year ON public.swap_tokens (month_year);
CREATE INDEX idx_swap_tokens_used       ON public.swap_tokens (used);

CREATE TRIGGER trg_swap_tokens_updated_at
  BEFORE UPDATE ON public.swap_tokens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- xp_events
-- ---------------------------------------------------------------------------
CREATE TABLE public.xp_events (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     int         NOT NULL CHECK (amount <> 0),
  reason     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT xp_events_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.xp_events IS 'Immutable log of XP gain/loss events';

CREATE INDEX idx_xp_events_user_id    ON public.xp_events (user_id);
CREATE INDEX idx_xp_events_created_at ON public.xp_events (created_at);
CREATE INDEX idx_xp_events_reason     ON public.xp_events (reason);

-- ---------------------------------------------------------------------------
-- user_levels
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_levels (
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_xp      int  NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  current_level int  NOT NULL DEFAULT 1 CHECK (current_level >= 1),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_levels_pkey PRIMARY KEY (user_id)
);

COMMENT ON TABLE public.user_levels IS 'Aggregated XP and computed level per user';

CREATE INDEX idx_user_levels_current_level ON public.user_levels (current_level);
CREATE INDEX idx_user_levels_total_xp      ON public.user_levels (total_xp);

CREATE TRIGGER trg_user_levels_updated_at
  BEFORE UPDATE ON public.user_levels
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- streaks
-- ---------------------------------------------------------------------------
CREATE TABLE public.streaks (
  user_id        uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_streak int     NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak int     NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_checkin   date,
  freeze_used    boolean NOT NULL DEFAULT false,
  CONSTRAINT streaks_pkey PRIMARY KEY (user_id)
);

COMMENT ON TABLE public.streaks IS 'Daily check-in streak tracking per user';

CREATE INDEX idx_streaks_current_streak ON public.streaks (current_streak);
CREATE INDEX idx_streaks_last_checkin   ON public.streaks (last_checkin);

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
CREATE TABLE public.jobs (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  type          text        NOT NULL,
  user_id       uuid,
  payload       jsonb,
  status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'retrying')),
  attempts      int         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  CONSTRAINT jobs_pkey PRIMARY KEY (id),
  CONSTRAINT jobs_payload_size CHECK (pg_column_size(payload) < 65536)
);

COMMENT ON TABLE public.jobs IS 'Async background job queue';

CREATE INDEX idx_jobs_status      ON public.jobs (status);
CREATE INDEX idx_jobs_type        ON public.jobs (type);
CREATE INDEX idx_jobs_user_id     ON public.jobs (user_id);
CREATE INDEX idx_jobs_created_at  ON public.jobs (created_at);
CREATE INDEX idx_jobs_status_type ON public.jobs (status, type);
-- Partial index for efficient queue polling
CREATE INDEX idx_jobs_pending_created
  ON public.jobs (scheduled_for ASC, type)
  WHERE status IN ('pending', 'retrying');

-- =============================================================================
-- TRIGGER FUNCTIONS & TRIGGERS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Function: Compute level from total XP
-- Level thresholds: level = floor(sqrt(total_xp / 100)) + 1, capped logic
-- Level N requires N^2 * 100 XP cumulative
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_compute_level(p_total_xp int)
RETURNS int
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(1, FLOOR(SQRT(GREATEST(p_total_xp, 0)::numeric / 100)) + 1)::int;
$$;

-- ---------------------------------------------------------------------------
-- Function: Aggregate XP into user_levels on xp_events INSERT
-- Uses a single atomic UPSERT to avoid race conditions between concurrent
-- XP inserts for the same user. The INSERT ... ON CONFLICT DO UPDATE
-- performs an atomic read-modify-write at the row level, eliminating
-- the TOCTOU race that existed with the previous INSERT+UPDATE two-step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_aggregate_xp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total int;
BEGIN
  -- Single atomic upsert: inserts a fresh row or adds NEW.amount to existing total.
  -- The DO UPDATE expression references the current committed value of total_xp
  -- (excluded.total_xp is NEW row value; user_levels.total_xp is the locked row value),
  -- guaranteeing serialized, loss-free accumulation under concurrency.
  INSERT INTO public.user_levels (user_id, total_xp, current_level, updated_at)
  VALUES (
    NEW.user_id,
    GREATEST(0, NEW.amount),
    fn_compute_level(GREATEST(0, NEW.amount)),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET
      total_xp      = GREATEST(0, user_levels.total_xp + NEW.amount),
      current_level = fn_compute_level(GREATEST(0, user_levels.total_xp + NEW.amount)),
      updated_at    = now()
  RETURNING total_xp INTO v_new_total;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_xp_events_aggregate
  AFTER INSERT ON public.xp_events
  FOR EACH ROW EXECUTE FUNCTION fn_aggregate_xp();

-- ---------------------------------------------------------------------------
-- Function: Update streak on check_in INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_update_streak()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_checkin   date;
  v_current_streak int;
  v_longest_streak int;
  v_freeze_used    boolean;
  v_new_streak     int;
BEGIN
  -- Ensure a streak row exists
  INSERT INTO public.streaks (user_id, current_streak, longest_streak, last_checkin, freeze_used)
  VALUES (NEW.user_id, 0, 0, NULL, false)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT current_streak, longest_streak, last_checkin, freeze_used
  INTO v_current_streak, v_longest_streak, v_last_checkin, v_freeze_used
  FROM public.streaks
  WHERE user_id = NEW.user_id;

  -- Avoid double-counting same-day check-ins (UNIQUE constraint handles it at DB level,
  -- but guard here for safety)
  IF v_last_checkin = NEW.date THEN
    RETURN NEW;
  END IF;

  IF v_last_checkin IS NULL THEN
    -- First ever check-in
    v_new_streak := 1;
  ELSIF NEW.date = v_last_checkin + 1 THEN
    -- Consecutive day (integer addition on date type)
    v_new_streak := v_current_streak + 1;
  ELSIF NEW.date = v_last_checkin + 2 AND NOT v_freeze_used THEN
    -- Missed one day but freeze token available: preserve streak
    v_new_streak := v_current_streak + 1;
    v_freeze_used := true;
  ELSE
    -- Streak broken, reset
    v_new_streak := 1;
    v_freeze_used := false;
  END IF;

  UPDATE public.streaks
  SET
    current_streak = v_new_streak,
    longest_streak = GREATEST(v_longest_streak, v_new_streak),
    last_checkin   = NEW.date,
    freeze_used    = v_freeze_used
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_ins_update_streak
  AFTER INSERT ON public.check_ins
  FOR EACH ROW EXECUTE FUNCTION fn_update_streak();

-- ---------------------------------------------------------------------------
-- Function: Auto-create profile row when a new auth.users row is inserted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, plan, onboarding_completed)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NULL),
    'free',
    false
  )
  ON CONFLICT (id) DO NOTHING;

  -- Initialise user_levels and streaks rows eagerly
  INSERT INTO public.user_levels (user_id, total_xp, current_level)
  VALUES (NEW.id, 0, 1)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.streaks (user_id, current_streak, longest_streak, freeze_used)
  VALUES (NEW.id, 0, 0, false)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_auth_users_create_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_access_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_samples          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_daily_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jarvis_states           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modules                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.box_orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swap_tokens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_levels             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streaks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_metric_types     ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RLS Policies: health_metric_types (read-only for all authenticated users)
-- ---------------------------------------------------------------------------
CREATE POLICY health_metric_types_select_authenticated ON public.health_metric_types
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- RLS Policies: profiles
-- ---------------------------------------------------------------------------
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- RLS Policies: subscriptions
-- Insertions are reserved for service_role (RevenueCat webhook Edge Function)
-- Users can only read their own subscriptions
-- ---------------------------------------------------------------------------
CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Block direct user inserts; service_role bypasses RLS automatically
CREATE POLICY subscriptions_insert_service_only ON public.subscriptions
  FOR INSERT WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- RLS Policies: consent_records
-- ---------------------------------------------------------------------------
CREATE POLICY consent_records_select_own ON public.consent_records
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY consent_records_insert_own ON public.consent_records
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: health_access_log
-- ---------------------------------------------------------------------------
CREATE POLICY health_access_log_select_own ON public.health_access_log
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY health_access_log_insert_own ON public.health_access_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: health_samples
-- ---------------------------------------------------------------------------
CREATE POLICY health_samples_select_own ON public.health_samples
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY health_samples_insert_own ON public.health_samples
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY health_samples_update_own ON public.health_samples
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY health_samples_delete_own ON public.health_samples
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: health_daily_aggregates
-- ---------------------------------------------------------------------------
CREATE POLICY health_daily_aggregates_select_own ON public.health_daily_aggregates
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY health_daily_aggregates_upsert_own ON public.health_daily_aggregates
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY health_daily_aggregates_update_own ON public.health_daily_aggregates
  FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: jarvis_states
-- ---------------------------------------------------------------------------
CREATE POLICY jarvis_states_select_own ON public.jarvis_states
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY jarvis_states_upsert_own ON public.jarvis_states
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY jarvis_states_update_own ON public.jarvis_states
  FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: missions
-- INSERT and DELETE are reserved for service_role (JARVIS Edge Functions)
-- Users can only read non-deleted missions and update status
-- WITH CHECK on UPDATE prevents users from clearing deleted_at (un-deleting)
-- ---------------------------------------------------------------------------
CREATE POLICY missions_select_own ON public.missions
  FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);

-- Block direct user inserts; service_role (JARVIS) bypasses RLS
CREATE POLICY missions_insert_service_only ON public.missions
  FOR INSERT WITH CHECK (false);

-- USING: row must be owned and not soft-deleted before update
-- WITH CHECK: update must not result in a row where deleted_at is set
--             (prevents un-deleting service-soft-deleted missions)
CREATE POLICY missions_update_own ON public.missions
  FOR UPDATE USING (auth.uid() = user_id AND deleted_at IS NULL)
  WITH CHECK (auth.uid() = user_id AND deleted_at IS NULL);

-- Block hard deletes from users; soft-delete via update deleted_at instead
CREATE POLICY missions_delete_service_only ON public.missions
  FOR DELETE USING (false);

-- ---------------------------------------------------------------------------
-- RLS Policies: check_ins
-- ---------------------------------------------------------------------------
CREATE POLICY check_ins_select_own ON public.check_ins
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY check_ins_insert_own ON public.check_ins
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY check_ins_update_own ON public.check_ins
  FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: modules (read-only for all authenticated users)
-- ---------------------------------------------------------------------------
CREATE POLICY modules_select_authenticated ON public.modules
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- RLS Policies: box_orders
-- INSERT restricted to 'pending' status only to prevent users from
-- self-creating orders in advanced states (shipped, delivered, etc.)
-- ---------------------------------------------------------------------------
CREATE POLICY box_orders_select_own ON public.box_orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY box_orders_insert_own ON public.box_orders
  FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'pending');

CREATE POLICY box_orders_update_own ON public.box_orders
  FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: swap_tokens
-- ---------------------------------------------------------------------------
CREATE POLICY swap_tokens_select_own ON public.swap_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY swap_tokens_insert_own ON public.swap_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY swap_tokens_update_own ON public.swap_tokens
  FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: xp_events
-- INSERT is reserved for service_role (triggers and Edge Functions only)
-- Users can only read their own XP history
-- ---------------------------------------------------------------------------
CREATE POLICY xp_events_select_own ON public.xp_events
  FOR SELECT USING (auth.uid() = user_id);

-- Block direct user inserts to prevent XP self-attribution
CREATE POLICY xp_events_insert_service_only ON public.xp_events
  FOR INSERT WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- RLS Policies: user_levels
-- ---------------------------------------------------------------------------
CREATE POLICY user_levels_select_own ON public.user_levels
  FOR SELECT USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: streaks
-- ---------------------------------------------------------------------------
CREATE POLICY streaks_select_own ON public.streaks
  FOR SELECT USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RLS Policies: jobs
-- user_id IS NULL jobs are system jobs reserved for service_role only
-- Authenticated users can only read/insert their own jobs (with non-null user_id)
-- ---------------------------------------------------------------------------
CREATE POLICY jobs_select_own ON public.jobs
  FOR SELECT USING (auth.uid() = user_id);

-- System jobs (user_id IS NULL) must be created via service_role only (bypasses RLS)
CREATE POLICY jobs_insert_own ON public.jobs
  FOR INSERT WITH CHECK (auth.uid()::uuid = user_id);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
