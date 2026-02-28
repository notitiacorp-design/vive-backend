-- ============================================================
-- 002_rls.sql  â  Row Level Security policies for VIVE backend
-- ============================================================
-- Enable RLS on every table first, then define policies.
-- service_role always bypasses RLS (Supabase default).
-- auth.uid()  â UUID of the currently authenticated user
-- auth.role() â 'authenticated' | 'anon' | 'service_role'
-- ============================================================


-- ============================================================
-- PROFILES
-- Users can read and update their own profile row.
-- INSERT is handled by a trigger (on auth.users), so no INSERT
-- policy is needed for regular users.
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


-- ============================================================
-- CONSENT_RECORDS
-- Users record their own consent and can audit what they
-- have consented to. No updates/deletes â consent is immutable.
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


-- ============================================================
-- HEALTH_SAMPLES
-- Raw health samples uploaded from the mobile client.
-- Users INSERT and SELECT only their own samples.
-- ============================================================
ALTER TABLE health_samples ENABLE ROW LEVEL SECURITY;

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


-- ============================================================
-- JARVIS_STATES
-- Each user has a single Jarvis AI state row.
-- Users can read and update their own state;
-- service_role handles initial creation.
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


-- ============================================================
-- MISSIONS
-- Missions are created by service_role (scheduled jobs /
-- edge functions). Users can read their own missions and
-- mark them as complete via UPDATE.
-- ============================================================
ALTER TABLE missions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "missions: owner can select"
  ON missions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "missions: owner can update"
  ON missions
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


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


-- ============================================================
-- MODULES
-- Public content catalog. Any authenticated user can browse
-- all modules. Only service_role (admin tooling / migrations)
-- may mutate module records.
-- ============================================================
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "modules: authenticated users can select"
  ON modules
  FOR SELECT
  TO authenticated
  USING (true);

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


-- ============================================================
-- SWAP_TOKENS
-- One-time-use tokens that let users swap a supplement.
-- Users can view and consume (UPDATE) their own tokens.
-- Tokens are generated by service_role.
-- ============================================================
ALTER TABLE swap_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "swap_tokens: owner can select"
  ON swap_tokens
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "swap_tokens: owner can update"
  ON swap_tokens
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


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
