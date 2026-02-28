/**
 * VIVE Backend â Shared Type Definitions
 * =======================================
 * Single source of truth for every entity that flows through the VIVE
 * platform: database rows, API contracts, webhook payloads, and helpers.
 *
 * Conventions
 * -----------
 * - "Row" types mirror the database columns exactly (snake_case, nullable
 *   columns are `T | null`).
 * - "Insert" types make generated / defaulted columns optional.
 * - "Update" types make every column optional except the primary key.
 * - API request / response types use camelCase and are intentionally
 *   decoupled from the database shapes so the two can evolve independently.
 */

// ---------------------------------------------------------------------------
// 0. Utility helpers
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string as stored in / returned from the database. */
export type ISOTimestamp = string;

/** UUID v4 string. */
export type UUID = string;

/** Generic paginated response envelope. */
export interface Paginated<T> {
  data: T[];
  /** Total number of rows matching the query (before pagination). */
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

/** Standard API error shape. */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Standard API success envelope. */
export interface ApiResponse<T = void> {
  success: true;
  data: T;
}

/** Standard API failure envelope. */
export interface ApiFailure {
  success: false;
  error: ApiError;
}

export type ApiResult<T = void> = ApiResponse<T> | ApiFailure;

// ---------------------------------------------------------------------------
// 1. Enums
// ---------------------------------------------------------------------------

/**
 * Subscription tiers available in VIVE.
 * - `free`      â no payment required, limited features.
 * - `essential` â monthly/annual paid tier with core AI features.
 * - `premium`   â top tier with full concierge & hardware access.
 */
export type Plan = 'free' | 'essential' | 'premium';

/**
 * Lifecycle states for a user's subscription.
 */
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'paused'
  | 'cancelled'
  | 'expired'
  | 'incomplete';

/**
 * Lifecycle states for a Mission.
 */
export type MissionStatus =
  | 'draft'
  | 'active'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'archived';

/**
 * Subjective difficulty rating assigned to a Mission.
 */
export type MissionDifficulty = 'easy' | 'medium' | 'hard' | 'elite';

/**
 * High-level category that a Mission belongs to.
 */
export type MissionCategory =
  | 'fitness'
  | 'nutrition'
  | 'sleep'
  | 'mindfulness'
  | 'recovery'
  | 'biohacking'
  | 'social'
  | 'productivity'
  | 'custom';

/**
 * Fulfilment states for a VIVE Box hardware order.
 */
export type BoxOrderStatus =
  | 'pending'
  | 'payment_pending'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'return_requested'
  | 'returned'
  | 'cancelled'
  | 'refunded';

/**
 * Whether the user is receiving an initial Box or swapping an existing one.
 */
export type BoxOrderMode = 'initial' | 'swap';

/**
 * Async background job types.
 */
export type JobType =
  | 'health_aggregation'
  | 'jarvis_briefing'
  | 'mission_generation'
  | 'box_selection'
  | 'streak_recalculation'
  | 'level_recalculation'
  | 'subscription_sync'
  | 'notification_dispatch'
  | 'data_export'
  | 'cleanup';

/**
 * Async background job lifecycle states.
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retrying';

/**
 * Health metric identifiers (mirrors Apple HealthKit / Google Fit quantity
 * types where applicable).
 */
export type MetricType =
  // Activity
  | 'steps'
  | 'active_energy_burned'
  | 'basal_energy_burned'
  | 'exercise_time'
  | 'stand_hours'
  | 'flights_climbed'
  | 'distance_walking_running'
  | 'distance_cycling'
  // Heart
  | 'heart_rate'
  | 'resting_heart_rate'
  | 'heart_rate_variability'
  | 'vo2_max'
  // Sleep
  | 'sleep_duration'
  | 'sleep_deep'
  | 'sleep_rem'
  | 'sleep_awake'
  | 'sleep_efficiency'
  // Body
  | 'body_mass'
  | 'body_fat_percentage'
  | 'bmi'
  | 'lean_body_mass'
  | 'waist_circumference'
  // Nutrition
  | 'dietary_energy'
  | 'dietary_protein'
  | 'dietary_carbohydrates'
  | 'dietary_fat'
  | 'dietary_water'
  // Vitals
  | 'blood_oxygen'
  | 'blood_glucose'
  | 'blood_pressure_systolic'
  | 'blood_pressure_diastolic'
  | 'respiratory_rate'
  | 'body_temperature'
  // Mindfulness
  | 'mindful_minutes'
  // Wearable / misc
  | 'hrv_sdnn'
  | 'skin_temperature'
  | 'noise_exposure';

/**
 * Bottleneck categories that Jarvis can identify for a user.
 * Used to personalise mission generation and box selection.
 */
export type Bottleneck =
  | 'poor_sleep'
  | 'low_activity'
  | 'high_stress'
  | 'poor_nutrition'
  | 'low_recovery'
  | 'high_resting_hr'
  | 'low_hrv'
  | 'low_vo2_max'
  | 'irregular_schedule'
  | 'low_hydration'
  | 'excessive_sedentary'
  | 'unknown';

// ---------------------------------------------------------------------------
// 2. Database Row Types
// ---------------------------------------------------------------------------

// ---- 2.1 Profile ----------------------------------------------------------

/**
 * Core user profile.
 * One-to-one with `auth.users` in Supabase; `id` equals the auth UID.
 */
export interface ProfileRow {
  id: UUID;
  /** Display name chosen by the user. */
  display_name: string | null;
  /** Public avatar URL (CDN). */
  avatar_url: string | null;
  /** User's date of birth for age-gated features. */
  date_of_birth: string | null; // DATE string 'YYYY-MM-DD'
  /** Biological sex for metabolic calculations. */
  biological_sex: 'male' | 'female' | 'other' | null;
  /** Height in centimetres. */
  height_cm: number | null;
  /** Weight in kilograms. */
  weight_kg: number | null;
  /** Current plan assigned to the user. */
  plan: Plan;
  /** IANA timezone string e.g. "Europe/London". */
  timezone: string;
  /** Preferred locale for localisation e.g. "en-GB". */
  locale: string;
  /** Whether the user has completed onboarding. */
  onboarding_complete: boolean;
  /** Soft-delete / account suspension flag. */
  is_active: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type ProfileInsert = Omit<ProfileRow, 'created_at' | 'updated_at'> &
  Partial<Pick<ProfileRow, 'plan' | 'timezone' | 'locale' | 'onboarding_complete' | 'is_active'>>;

export type ProfileUpdate = Partial<Omit<ProfileRow, 'id' | 'created_at'>> &
  Pick<ProfileRow, 'id'>;

// ---- 2.2 Subscription -----------------------------------------------------

/**
 * Tracks the user's active subscription, sourced from RevenueCat / Stripe.
 */
export interface SubscriptionRow {
  id: UUID;
  user_id: UUID;
  /** Current plan reflected by this subscription. */
  plan: Plan;
  status: SubscriptionStatus;
  /** RevenueCat customer / subscriber ID. */
  revenuecat_customer_id: string | null;
  /** Active RevenueCat entitlement identifier. */
  revenuecat_entitlement_id: string | null;
  /** Stripe customer ID (web checkout flow). */
  stripe_customer_id: string | null;
  /** Active Stripe subscription ID. */
  stripe_subscription_id: string | null;
  /** Active Stripe price ID. */
  stripe_price_id: string | null;
  /** When the current billing period started. */
  current_period_start: ISOTimestamp | null;
  /** When the current billing period ends / renews. */
  current_period_end: ISOTimestamp | null;
  /** Whether the subscription will auto-renew. */
  auto_renew: boolean;
  /** ISO-4217 currency code e.g. "GBP". */
  currency: string | null;
  /** Price charged per period in minor units (pence / cents). */
  unit_amount: number | null;
  /** Billing interval: 'month' | 'year'. */
  interval: 'month' | 'year' | null;
  /** When trial period ends (null if no trial). */
  trial_end: ISOTimestamp | null;
  /** Raw provider event payload for audit purposes. */
  raw_payload: Record<string, unknown> | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type SubscriptionInsert = Omit<SubscriptionRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<SubscriptionRow, 'id'>>;

export type SubscriptionUpdate = Partial<Omit<SubscriptionRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<SubscriptionRow, 'id'>;

// ---- 2.3 ConsentRecord ----------------------------------------------------

/**
 * GDPR / HIPAA consent log.
 * A new row is inserted every time the user changes a consent preference;
 * the current state is determined by the most recent row per `consent_type`.
 */
export interface ConsentRecordRow {
  id: UUID;
  user_id: UUID;
  /** Logical name for the consent category. */
  consent_type:
    | 'health_data_processing'
    | 'marketing_communications'
    | 'data_sharing_research'
    | 'third_party_integrations'
    | 'terms_of_service'
    | 'privacy_policy';
  granted: boolean;
  /** Semver of the document the user consented to e.g. "2.1.0". */
  document_version: string;
  /** IP address of the request at consent time (hashed / anonymised). */
  ip_address: string | null;
  /** User-agent string at consent time. */
  user_agent: string | null;
  /** Platform that captured the consent event. */
  platform: 'ios' | 'android' | 'web' | 'backend';
  created_at: ISOTimestamp;
}

export type ConsentRecordInsert = Omit<ConsentRecordRow, 'id' | 'created_at'> &
  Partial<Pick<ConsentRecordRow, 'id'>>;

// ConsentRecord is append-only; no Update type.

// ---- 2.4 HealthAccessLog --------------------------------------------------

/**
 * Audit trail for every read / write of a user's health data.
 * Required for HIPAA access logging.
 */
export interface HealthAccessLogRow {
  id: UUID;
  user_id: UUID;
  /** The service or user that accessed the data. */
  accessor_id: string;
  accessor_type: 'user' | 'service' | 'admin';
  /** CRUD operation performed. */
  action: 'read' | 'write' | 'delete' | 'export';
  /** Which metrics were accessed. */
  metric_types: MetricType[];
  /** Rough date range queried. */
  date_range_start: ISOTimestamp | null;
  date_range_end: ISOTimestamp | null;
  /** HTTP request IP (hashed). */
  ip_address: string | null;
  /** Unique request ID for cross-service tracing. */
  request_id: string | null;
  created_at: ISOTimestamp;
}

export type HealthAccessLogInsert = Omit<HealthAccessLogRow, 'id' | 'created_at'> &
  Partial<Pick<HealthAccessLogRow, 'id'>>;

// ---- 2.5 HealthSample -----------------------------------------------------

/**
 * A single, point-in-time health measurement.
 * High-volume table; queries are always scoped to `(user_id, metric_type, sampled_at)`.
 */
export interface HealthSampleRow {
  id: UUID;
  user_id: UUID;
  metric_type: MetricType;
  /** Numeric value in SI / canonical unit for the metric type. */
  value: number;
  /** Human-readable unit label e.g. "bpm", "kcal", "kg". */
  unit: string;
  /** Precise timestamp the sample was recorded by the source device. */
  sampled_at: ISOTimestamp;
  /** Data source identifier e.g. "com.apple.health", "fitbit". */
  source: string | null;
  /** Source bundle / app ID for de-duplication. */
  source_bundle_id: string | null;
  /** Provider-native sample UUID for idempotent upserts. */
  external_id: string | null;
  /** Confidence score 0â1 where the source provides it. */
  confidence: number | null;
  /** Additional provider-specific metadata. */
  metadata: Record<string, unknown> | null;
  created_at: ISOTimestamp;
}

export type HealthSampleInsert = Omit<HealthSampleRow, 'id' | 'created_at'> &
  Partial<Pick<HealthSampleRow, 'id'>>;

export type HealthSampleUpdate = Partial<Omit<HealthSampleRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<HealthSampleRow, 'id'>;

// ---- 2.6 HealthDailyAggregate ---------------------------------------------

/**
 * Pre-computed daily rollup for a single metric.
 * Generated by the `health_aggregation` background job.
 * Unique constraint on `(user_id, metric_type, date)`.
 */
export interface HealthDailyAggregateRow {
  id: UUID;
  user_id: UUID;
  metric_type: MetricType;
  /** Calendar date in 'YYYY-MM-DD' format, in the user's timezone. */
  date: string;
  value_sum: number | null;
  value_avg: number | null;
  value_min: number | null;
  value_max: number | null;
  /** Number of raw samples that contributed to this aggregate. */
  sample_count: number;
  /** Canonical unit for the metric. */
  unit: string;
  /** User's timezone at aggregation time. */
  timezone: string;
  /** Timestamp of the last aggregation run for this row. */
  aggregated_at: ISOTimestamp;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type HealthDailyAggregateInsert = Omit<
  HealthDailyAggregateRow,
  'id' | 'created_at' | 'updated_at'
> &
  Partial<Pick<HealthDailyAggregateRow, 'id'>>;

export type HealthDailyAggregateUpdate = Partial<
  Omit<HealthDailyAggregateRow, 'id' | 'user_id' | 'created_at'>
> &
  Pick<HealthDailyAggregateRow, 'id'>;

// ---- 2.7 JarvisState -------------------------------------------------------

/**
 * Persistent AI state for the Jarvis coaching engine.
 * One row per user; upserted after every briefing cycle.
 */
export interface JarvisStateRow {
  id: UUID;
  user_id: UUID;
  /** Identified performance bottlenecks, ordered by severity. */
  bottlenecks: Bottleneck[];
  /**
   * Free-form coaching context that persists across sessions.
   * Injected into the system prompt to maintain continuity.
   */
  coaching_context: string | null;
  /** Serialised short-term memory / conversation summary for the LLM. */
  memory_summary: string | null;
  /** UTC date of the last morning briefing generated. */
  last_briefing_date: string | null; // 'YYYY-MM-DD'
  /** ISO timestamp of the next scheduled briefing. */
  next_briefing_at: ISOTimestamp | null;
  /** Cumulative token usage for cost tracking. */
  total_tokens_used: number;
  /** Provider + model identifier used for the last inference call. */
  model_version: string | null;
  /** Arbitrary key-value store for experimental feature flags / state. */
  extra: Record<string, unknown> | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type JarvisStateInsert = Omit<JarvisStateRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<JarvisStateRow, 'id' | 'total_tokens_used'>>;

export type JarvisStateUpdate = Partial<Omit<JarvisStateRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<JarvisStateRow, 'id'>;

// ---- 2.8 Mission -----------------------------------------------------------

/**
 * A discrete, time-bounded health challenge assigned to a user.
 */
export interface MissionRow {
  id: UUID;
  user_id: UUID;
  title: string;
  description: string | null;
  category: MissionCategory;
  difficulty: MissionDifficulty;
  status: MissionStatus;
  /** XP awarded on successful completion. */
  xp_reward: number;
  /** Target metric type if the mission is quantitative. */
  target_metric: MetricType | null;
  /** Numeric target value for the metric. */
  target_value: number | null;
  /** Unit label for the target e.g. "steps", "hours". */
  target_unit: string | null;
  /** Current progress value (updated on each HealthSync). */
  progress_value: number | null;
  /** Date the mission should start. 'YYYY-MM-DD' */
  start_date: string;
  /** Date the mission expires. 'YYYY-MM-DD' */
  end_date: string;
  /** Timestamp the user completed the mission. */
  completed_at: ISOTimestamp | null;
  /** Whether Jarvis generated this mission (vs manual / template). */
  ai_generated: boolean;
  /** The Jarvis reasoning behind selecting this mission. */
  ai_rationale: string | null;
  /** Reference to the module this mission belongs to (if any). */
  module_id: UUID | null;
  /** Arbitrary structured data for complex mission types. */
  metadata: Record<string, unknown> | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type MissionInsert = Omit<MissionRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<MissionRow, 'id' | 'status' | 'xp_reward' | 'ai_generated'>>;

export type MissionUpdate = Partial<Omit<MissionRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<MissionRow, 'id'>;

// ---- 2.9 CheckIn -----------------------------------------------------------

/**
 * A user's daily self-reported wellbeing check-in.
 */
export interface CheckInRow {
  id: UUID;
  user_id: UUID;
  /** Calendar date of the check-in. 'YYYY-MM-DD' */
  date: string;
  /** Subjective energy score 1â10. */
  energy_score: number | null;
  /** Subjective mood score 1â10. */
  mood_score: number | null;
  /** Subjective stress score 1â10 (higher = more stressed). */
  stress_score: number | null;
  /** Perceived sleep quality 1â10. */
  sleep_quality_score: number | null;
  /** Free-text journal entry. */
  notes: string | null;
  /** Emoji or short tag e.g. "ð´", "ðª". */
  emoji_tag: string | null;
  /** Flags this check-in as contributing to the daily streak. */
  counts_for_streak: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type CheckInInsert = Omit<CheckInRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<CheckInRow, 'id' | 'counts_for_streak'>>;

export type CheckInUpdate = Partial<Omit<CheckInRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<CheckInRow, 'id'>;

// ---- 2.10 Module -----------------------------------------------------------

/**
 * A structured, multi-week health programme (e.g. "30-Day Sleep Reset").
 * Contains an ordered set of Missions.
 */
export interface ModuleRow {
  id: UUID;
  /** Display title of the module. */
  title: string;
  description: string | null;
  category: MissionCategory;
  /** Estimated duration in days. */
  duration_days: number;
  /** Minimum plan required to access this module. */
  required_plan: Plan;
  /** Ordered list of mission template IDs or inline configs. */
  mission_template_ids: UUID[];
  /** Cover image URL. */
  cover_image_url: string | null;
  /** Total XP a user can earn by completing the module. */
  total_xp: number;
  /** Whether this module is publicly visible in the catalogue. */
  is_published: boolean;
  /** Sort weight for catalogue ordering (lower = higher). */
  sort_order: number;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type ModuleInsert = Omit<ModuleRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<ModuleRow, 'id' | 'is_published' | 'sort_order' | 'total_xp'>>;

export type ModuleUpdate = Partial<Omit<ModuleRow, 'id' | 'created_at'>> &
  Pick<ModuleRow, 'id'>;

// ---- 2.11 BoxOrder ---------------------------------------------------------

/**
 * A VIVE Box hardware order (initial dispatch or swap).
 */
export interface BoxOrderRow {
  id: UUID;
  user_id: UUID;
  mode: BoxOrderMode;
  status: BoxOrderStatus;
  /** The specific device / kit SKUs included in this box. */
  device_skus: string[];
  /** Jarvis-generated rationale for the device selection. */
  selection_rationale: string | null;
  /** Shipping address captured at order time. */
  shipping_address: ShippingAddress | null;
  /** Carrier name e.g. "DHL", "Royal Mail". */
  carrier: string | null;
  /** Carrier tracking number. */
  tracking_number: string | null;
  /** Carrier tracking URL. */
  tracking_url: string | null;
  /** Estimated delivery date. 'YYYY-MM-DD' */
  estimated_delivery_date: string | null;
  /** Actual delivery timestamp. */
  delivered_at: ISOTimestamp | null;
  /** Stripe PaymentIntent ID if an additional charge was required. */
  stripe_payment_intent_id: string | null;
  /** Associated SwapToken ID if this is a swap order. */
  swap_token_id: UUID | null;
  /** Internal fulfilment notes. */
  notes: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

/** Structured shipping address embedded in BoxOrderRow. */
export interface ShippingAddress {
  full_name: string;
  line1: string;
  line2: string | null;
  city: string;
  state_province: string | null;
  postal_code: string;
  country_code: string; // ISO 3166-1 alpha-2
  phone: string | null;
}

export type BoxOrderInsert = Omit<BoxOrderRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<BoxOrderRow, 'id' | 'status'>>;

export type BoxOrderUpdate = Partial<Omit<BoxOrderRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<BoxOrderRow, 'id'>;

// ---- 2.12 SwapToken --------------------------------------------------------

/**
 * One-time-use token that authorises a box swap within a billing period.
 * Issued by the backend when a qualifying condition is met.
 */
export interface SwapTokenRow {
  id: UUID;
  user_id: UUID;
  /** Whether the token has been consumed. */
  used: boolean;
  /** The BoxOrder that consumed this token (null until redeemed). */
  used_by_order_id: UUID | null;
  /** Timestamp at which the token was redeemed. */
  used_at: ISOTimestamp | null;
  /** Token expires at this timestamp even if unused. */
  expires_at: ISOTimestamp;
  /** Human-readable reason the token was issued. */
  issued_reason: string | null;
  created_at: ISOTimestamp;
}

export type SwapTokenInsert = Omit<SwapTokenRow, 'id' | 'created_at'> &
  Partial<Pick<SwapTokenRow, 'id' | 'used'>>;

export type SwapTokenUpdate = Partial<Omit<SwapTokenRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<SwapTokenRow, 'id'>;

// ---- 2.13 XpEvent ----------------------------------------------------------

/**
 * Append-only ledger of every XP award or deduction.
 */
export interface XpEventRow {
  id: UUID;
  user_id: UUID;
  /** Positive for award, negative for deduction. */
  delta: number;
  /** Source action that triggered the XP change. */
  source:
    | 'mission_completed'
    | 'check_in'
    | 'streak_bonus'
    | 'module_completed'
    | 'referral'
    | 'admin_adjustment'
    | 'onboarding'
    | 'challenge';
  /** Reference to the entity that triggered the event. */
  source_id: UUID | null;
  /** Running total after this event (denormalised for quick reads). */
  balance_after: number;
  /** Human-readable description for the activity feed. */
  description: string | null;
  created_at: ISOTimestamp;
}

export type XpEventInsert = Omit<XpEventRow, 'id' | 'created_at'> &
  Partial<Pick<XpEventRow, 'id'>>;

// XpEvent is append-only; no Update type.

// ---- 2.14 UserLevel --------------------------------------------------------

/**
 * Current level and XP totals for a user.
 * One row per user; updated after every XpEvent.
 */
export interface UserLevelRow {
  id: UUID;
  user_id: UUID;
  /** Current level number (1-based). */
  level: number;
  /** Human-readable level title e.g. "Apprentice Biohacker". */
  level_title: string | null;
  /** Total XP accumulated across all time. */
  total_xp: number;
  /** XP earned within the current level (resets on level-up). */
  current_level_xp: number;
  /** XP required to reach the next level. */
  next_level_xp: number;
  /** Timestamp of the most recent level-up event. */
  last_level_up_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type UserLevelInsert = Omit<UserLevelRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<UserLevelRow, 'id' | 'level' | 'total_xp' | 'current_level_xp'>>;

export type UserLevelUpdate = Partial<Omit<UserLevelRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<UserLevelRow, 'id'>;

// ---- 2.15 Streak -----------------------------------------------------------

/**
 * Daily engagement streak tracking for a user.
 */
export interface StreakRow {
  id: UUID;
  user_id: UUID;
  /** Current unbroken streak length in days. */
  current_streak: number;
  /** Longest streak ever achieved. */
  longest_streak: number;
  /** Date of the last qualifying activity. 'YYYY-MM-DD' */
  last_activity_date: string | null;
  /** Total number of days the user has had any qualifying activity. */
  total_active_days: number;
  /**
   * Number of streak-freeze tokens remaining.
   * A freeze can be used to preserve a streak when the user misses a day.
   */
  freeze_tokens: number;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type StreakInsert = Omit<StreakRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<StreakRow, 'id' | 'current_streak' | 'longest_streak' | 'total_active_days' | 'freeze_tokens'>>;

export type StreakUpdate = Partial<Omit<StreakRow, 'id' | 'user_id' | 'created_at'>> &
  Pick<StreakRow, 'id'>;

// ---- 2.16 Job --------------------------------------------------------------

/**
 * Persistent record of an async background job.
 */
export interface JobRow {
  id: UUID;
  type: JobType;
  status: JobStatus;
  /** User the job is scoped to (null for system-wide jobs). */
  user_id: UUID | null;
  /** Serialised input payload for the job. */
  payload: Record<string, unknown> | null;
  /** Serialised output / result of the job. */
  result: Record<string, unknown> | null;
  /** Error message if the job failed. */
  error_message: string | null;
  /** Full error stack trace for debugging. */
  error_stack: string | null;
  /** Number of execution attempts so far. */
  attempt_count: number;
  /** Maximum allowed attempts before marking as permanently failed. */
  max_attempts: number;
  /** Timestamp after which the job should be picked up by a worker. */
  scheduled_at: ISOTimestamp;
  /** Timestamp when a worker last started processing this job. */
  started_at: ISOTimestamp | null;
  /** Timestamp when the job finished (success or terminal failure). */
  finished_at: ISOTimestamp | null;
  /** Worker instance that processed (or is processing) this job. */
  worker_id: string | null;
  /** Optional idempotency key to prevent duplicate job creation. */
  idempotency_key: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export type JobInsert = Omit<JobRow, 'id' | 'created_at' | 'updated_at'> &
  Partial<
    Pick<
      JobRow,
      | 'id'
      | 'status'
      | 'attempt_count'
      | 'max_attempts'
      | 'scheduled_at'
    >
  >;

export type JobUpdate = Partial<Omit<JobRow, 'id' | 'created_at'>> &
  Pick<JobRow, 'id'>;

// ---------------------------------------------------------------------------
// 3. Supabase-style Database schema helper
// ---------------------------------------------------------------------------

/**
 * Top-level database schema type.
 * Mirrors the generated output of `supabase gen types typescript`.
 * Pass this as the generic argument to the Supabase client:
 * `createClient<Database>(url, key)`
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: ProfileInsert;
        Update: ProfileUpdate;
      };
      subscriptions: {
        Row: SubscriptionRow;
        Insert: SubscriptionInsert;
        Update: SubscriptionUpdate;
      };
      consent_records: {
        Row: ConsentRecordRow;
        Insert: ConsentRecordInsert;
        Update: never; // append-only
      };
      health_access_logs: {
        Row: HealthAccessLogRow;
        Insert: HealthAccessLogInsert;
        Update: never; // append-only
      };
      health_samples: {
        Row: HealthSampleRow;
        Insert: HealthSampleInsert;
        Update: HealthSampleUpdate;
      };
      health_daily_aggregates: {
        Row: HealthDailyAggregateRow;
        Insert: HealthDailyAggregateInsert;
        Update: HealthDailyAggregateUpdate;
      };
      jarvis_state: {
        Row: JarvisStateRow;
        Insert: JarvisStateInsert;
        Update: JarvisStateUpdate;
      };
      missions: {
        Row: MissionRow;
        Insert: MissionInsert;
        Update: MissionUpdate;
      };
      check_ins: {
        Row: CheckInRow;
        Insert: CheckInInsert;
        Update: CheckInUpdate;
      };
      modules: {
        Row: ModuleRow;
        Insert: ModuleInsert;
        Update: ModuleUpdate;
      };
      box_orders: {
        Row: BoxOrderRow;
        Insert: BoxOrderInsert;
        Update: BoxOrderUpdate;
      };
      swap_tokens: {
        Row: SwapTokenRow;
        Insert: SwapTokenInsert;
        Update: SwapTokenUpdate;
      };
      xp_events: {
        Row: XpEventRow;
        Insert: XpEventInsert;
        Update: never; // append-only
      };
      user_levels: {
        Row: UserLevelRow;
        Insert: UserLevelInsert;
        Update: UserLevelUpdate;
      };
      streaks: {
        Row: StreakRow;
        Insert: StreakInsert;
        Update: StreakUpdate;
      };
      jobs: {
        Row: JobRow;
        Insert: JobInsert;
        Update: JobUpdate;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      plan: Plan;
      subscription_status: SubscriptionStatus;
      mission_status: MissionStatus;
      mission_difficulty: MissionDifficulty;
      mission_category: MissionCategory;
      box_order_status: BoxOrderStatus;
      box_order_mode: BoxOrderMode;
      job_type: JobType;
      job_status: JobStatus;
      metric_type: MetricType;
      bottleneck: Bottleneck;
    };
  };
}

// Convenience type aliases for table row access.
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

// ---------------------------------------------------------------------------
// 4. API Request / Response Types
// ---------------------------------------------------------------------------

// ---- 4.1 Health Sync -------------------------------------------------------

/**
 * A single health sample as sent from the mobile client.
 * Uses camelCase; the backend normalises to snake_case before persisting.
 */
export interface HealthSamplePayload {
  metricType: MetricType;
  value: number;
  unit: string;
  /** Client-side timestamp in ISO-8601 format. */
  sampledAt: ISOTimestamp;
  source: string;
  sourceBundleId?: string;
  /** Provider-native UUID used for idempotent upserts. */
  externalId?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Batch health-sync request body.
 * The client sends all new samples since the last successful sync.
 */
export interface HealthSyncRequest {
  /** Samples sorted ascending by `sampledAt`. */
  samples: HealthSamplePayload[];
  /** ISO timestamp of the client's last successful sync. */
  lastSyncedAt: ISOTimestamp | null;
  /** Client platform for logging purposes. */
  platform: 'ios' | 'android';
  /** App version e.g. "1.4.2". */
  appVersion: string;
}

/**
 * Response returned after a successful health sync.
 */
export interface HealthSyncResponse {
  /** Number of samples actually persisted (after de-duplication). */
  samplesAccepted: number;
  /** Number of samples skipped due to duplicates or validation errors. */
  samplesSkipped: number;
  /** ISO timestamp to use as `lastSyncedAt` on the next sync. */
  syncedAt: ISOTimestamp;
  /** Whether the sync triggered a new Jarvis briefing job. */
  briefingTriggered: boolean;
}

// ---- 4.2 Jarvis Briefing ---------------------------------------------------

/**
 * A single actionable insight surfaced in the briefing.
 */
export interface JarvisInsight {
  id: string;
  type: 'observation' | 'warning' | 'encouragement' | 'tip' | 'milestone';
  title: string;
  body: string;
  /** Metric that triggered this insight (if applicable). */
  relatedMetric: MetricType | null;
  /** Severity / prominence weight for rendering. */
  priority: 'low' | 'medium' | 'high';
}

/**
 * Daily morning briefing response delivered to the mobile app.
 */
export interface JarvisBriefingResponse {
  /** Personalised greeting incorporating time of day and user name. */
  greeting: string;
  /** Short executive summary paragraph. */
  summary: string;
  insights: JarvisInsight[];
  /** Bottlenecks identified from recent health data. */
  bottlenecks: Bottleneck[];
  /** Missions recommended or activated as a result of this briefing. */
  recommendedMissions: MissionRow[];
  /** UTC date this briefing was generated for. 'YYYY-MM-DD' */
  briefingDate: string;
  /** Model / version used for generation (for client-side analytics). */
  modelVersion: string;
  /** Tokens consumed generating this briefing (internal telemetry). */
  tokensUsed: number;
  generatedAt: ISOTimestamp;
}

// ---- 4.3 Box Selection -----------------------------------------------------

/**
 * A single device / kit considered during AI box selection.
 */
export interface DeviceOption {
  /** Product SKU. */
  sku: string;
  name: string;
  description: string;
  /** Metrics this device measures. */
  measuredMetrics: MetricType[];
  /** Recommended retail price in minor units (pence/cents). */
  rrpMinorUnits: number;
  currency: string;
  imageUrl: string | null;
  inStock: boolean;
}

/**
 * Jarvis-recommended box configuration for the user.
 */
export interface BoxSelectionResponse {
  /** Ordered list of selected device SKUs (primary first). */
  selectedSkus: string[];
  /** Full device details for each selected SKU. */
  devices: DeviceOption[];
  /** Natural-language explanation of why these devices were chosen. */
  rationale: string;
  /** Bottlenecks this selection targets. */
  targetedBottlenecks: Bottleneck[];
  /** Whether the user has an active swap token they can use. */
  swapAvailable: boolean;
  /** Active swap token ID (null if `swapAvailable` is false). */
  swapTokenId: UUID | null;
  generatedAt: ISOTimestamp;
}

// ---- 4.4 Misc API helpers --------------------------------------------------

/** Request body for creating a new CheckIn. */
export interface CreateCheckInRequest {
  date: string; // 'YYYY-MM-DD'
  energyScore?: number;
  moodScore?: number;
  stressScore?: number;
  sleepQualityScore?: number;
  notes?: string;
  emojiTag?: string;
}

/** Request body for creating / updating a Mission. */
export interface UpsertMissionRequest {
  title: string;
  description?: string;
  category: MissionCategory;
  difficulty: MissionDifficulty;
  xpReward?: number;
  targetMetric?: MetricType;
  targetValue?: number;
  targetUnit?: string;
  startDate: string;
  endDate: string;
  moduleId?: UUID;
  metadata?: Record<string, unknown>;
}

/** Request body for placing a BoxOrder. */
export interface PlaceBoxOrderRequest {
  mode: BoxOrderMode;
  /** Pre-selected SKUs; if omitted the backend uses Jarvis selection. */
  deviceSkus?: string[];
  shippingAddress: ShippingAddress;
  /** Swap token to consume for a swap order. */
  swapTokenId?: UUID;
}

// ---------------------------------------------------------------------------
// 5. RevenueCat Webhook Types
// ---------------------------------------------------------------------------

/**
 * RevenueCat event types sent via webhook.
 * @see https://www.revenuecat.com/docs/webhooks
 */
export type RevenueCatEventType =
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'UNCANCELLATION'
  | 'NON_RENEWING_PURCHASE'
  | 'SUBSCRIPTION_PAUSED'
  | 'EXPIRATION'
  | 'BILLING_ISSUE'
  | 'PRODUCT_CHANGE'
  | 'TRANSFER'
  | 'SUBSCRIPTION_EXTENDED';

/**
 * Core subscriber / event attributes included in every RevenueCat webhook.
 */
export interface RevenueCatSubscriberAttributes {
  /** RevenueCat app user ID (maps to our `user_id`). */
  app_user_id: string;
  /** Additional aliases / anonymous IDs for the subscriber. */
  aliases: string[];
  /** Platform the purchase was made on. */
  store: 'APP_STORE' | 'PLAY_STORE' | 'STRIPE' | 'PROMOTIONAL' | 'AMAZON';
  /** ISO 3166-1 alpha-2 country code derived from the store. */
  country_code: string | null;
}

/**
 * Shared fields present on every RevenueCat webhook event object.
 */
export interface RevenueCatEventBase {
  id: string;
  type: RevenueCatEventType;
  event_timestamp_ms: number;
  app_id: string;
  app_user_id: string;
  /** Aliases / other app user IDs for this subscriber. */
  aliases: string[];
  original_app_user_id: string;
  product_id: string;
  entitlement_ids: string[] | null;
  period_type: 'NORMAL' | 'TRIAL' | 'INTRO';
  purchased_at_ms: number;
  grace_period_expires_at_ms: number | null;
  expiration_at_ms: number | null;
  store: RevenueCatSubscriberAttributes['store'];
  environment: 'PRODUCTION' | 'SANDBOX';
  is_family_share: boolean;
  presented_offering_id: string | null;
  transaction_id: string;
  original_transaction_id: string;
  country_code: string | null;
  currency: string | null;
  /** Price in the stated currency. */
  price: number | null;
  /** Price in USD (always available from RevenueCat). */
  price_in_purchased_currency: number | null;
  subscriber_attributes: Record<string, { value: string; updated_at_ms: number }>;
}

/** INITIAL_PURCHASE event. */
export interface RevenueCatInitialPurchaseEvent extends RevenueCatEventBase {
  type: 'INITIAL_PURCHASE';
}

/** RENEWAL event. */
export interface RevenueCatRenewalEvent extends RevenueCatEventBase {
  type: 'RENEWAL';
  is_trial_conversion: boolean;
}

/** CANCELLATION event. */
export interface RevenueCatCancellationEvent extends RevenueCatEventBase {
  type: 'CANCELLATION';
  cancel_reason:
    | 'UNSUBSCRIBE'
    | 'BILLING_ERROR'
    | 'DEVELOPER_INITIATED'
    | 'PRICE_INCREASE'
    | 'CUSTOMER_SUPPORT'
    | 'UNKNOWN';
}

/** EXPIRATION event. */
export interface RevenueCatExpirationEvent extends RevenueCatEventBase {
  type: 'EXPIRATION';
  expiration_reason:
    | 'UNSUBSCRIBE'
    | 'BILLING_ERROR'
    | 'DEVELOPER_INITIATED'
    | 'PRICE_INCREASE'
    | 'CUSTOMER_SUPPORT'
    | 'UNKNOWN';
}

/** BILLING_ISSUE event. */
export interface RevenueCatBillingIssueEvent extends RevenueCatEventBase {
  type: 'BILLING_ISSUE';
  grace_period_expires_at_ms: number | null;
}

/** PRODUCT_CHANGE event. */
export interface RevenueCatProductChangeEvent extends RevenueCatEventBase {
  type: 'PRODUCT_CHANGE';
  new_product_id: string;
}

/** SUBSCRIPTION_PAUSED event (Google Play only). */
export interface RevenueCatSubscriptionPausedEvent extends RevenueCatEventBase {
  type: 'SUBSCRIPTION_PAUSED';
  auto_resume_at_ms: number | null;
}

/** TRANSFER event. */
export interface RevenueCatTransferEvent {
  id: string;
  type: 'TRANSFER';
  event_timestamp_ms: number;
  app_id: string;
  transferred_from: string[];
  transferred_to: string[];
  store: RevenueCatSubscriberAttributes['store'];
  environment: 'PRODUCTION' | 'SANDBOX';
}

/** SUBSCRIPTION_EXTENDED event. */
export interface RevenueCatSubscriptionExtendedEvent extends RevenueCatEventBase {
  type: 'SUBSCRIPTION_EXTENDED';
}

/** Discriminated union of all RevenueCat webhook events. */
export type RevenueCatEvent =
  | RevenueCatInitialPurchaseEvent
  | RevenueCatRenewalEvent
  | RevenueCatCancellationEvent
  | RevenueCatExpirationEvent
  | RevenueCatBillingIssueEvent
  | RevenueCatProductChangeEvent
  | RevenueCatSubscriptionPausedEvent
  | RevenueCatTransferEvent
  | RevenueCatSubscriptionExtendedEvent;

/**
 * Top-level RevenueCat webhook POST body.
 */
export interface RevenueCatWebhookPayload {
  /** API version of the payload e.g. "1.0". */
  api_version: string;
  event: RevenueCatEvent;
}

// ---------------------------------------------------------------------------
// 6. Stripe Webhook Types (simplified)
// ---------------------------------------------------------------------------

/**
 * Stripe event types relevant to VIVE's subscription flow.
 * @see https://stripe.com/docs/api/events/types
 */
export type StripeEventType =
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'customer.subscription.trial_will_end'
  | 'customer.subscription.paused'
  | 'customer.subscription.resumed'
  | 'invoice.payment_succeeded'
  | 'invoice.payment_failed'
  | 'invoice.upcoming'
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'checkout.session.completed'
  | 'checkout.session.expired'
  | 'customer.created'
  | 'customer.updated'
  | 'customer.deleted';

/** Simplified Stripe Subscription object (fields used by VIVE). */
export interface StripeSubscriptionObject {
  id: string;
  object: 'subscription';
  customer: string;
  status: StripeSubscriptionStatus;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        unit_amount: number | null;
        currency: string;
        recurring: {
          interval: 'month' | 'year';
          interval_count: number;
        } | null;
        product: string;
      };
    }>;
  };
  current_period_start: number; // Unix timestamp
  current_period_end: number; // Unix timestamp
  trial_start: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  metadata: Record<string, string>;
  latest_invoice: string | null;
}

/**
 * Stripe subscription status values.
 * @see https://stripe.com/docs/api/subscriptions/object#subscription_object-status
 */
export type StripeSubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'paused';

/** Simplified Stripe Invoice object. */
export interface StripeInvoiceObject {
  id: string;
  object: 'invoice';
  customer: string;
  subscription: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  period_start: number;
  period_end: number;
  payment_intent: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  metadata: Record<string, string>;
}

/** Simplified Stripe Checkout Session object. */
export interface StripeCheckoutSessionObject {
  id: string;
  object: 'checkout.session';
  customer: string | null;
  customer_email: string | null;
  subscription: string | null;
  payment_intent: string | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  status: 'complete' | 'expired' | 'open';
  mode: 'payment' | 'setup' | 'subscription';
  metadata: Record<string, string>;
  client_reference_id: string | null;
  success_url: string;
  cancel_url: string | null;
}

/** Simplified Stripe Customer object. */
export interface StripeCustomerObject {
  id: string;
  object: 'customer';
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
  created: number;
  deleted?: boolean;
}

/** Simplified Stripe PaymentIntent object. */
export interface StripePaymentIntentObject {
  id: string;
  object: 'payment_intent';
  customer: string | null;
  amount: number;
  currency: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  metadata: Record<string, string>;
}

/** Map from Stripe event type to the data object shape. */
export interface StripeEventDataObjectMap {
  'customer.subscription.created': StripeSubscriptionObject;
  'customer.subscription.updated': StripeSubscriptionObject;
  'customer.subscription.deleted': StripeSubscriptionObject;
  'customer.subscription.trial_will_end': StripeSubscriptionObject;
  'customer.subscription.paused': StripeSubscriptionObject;
  'customer.subscription.resumed': StripeSubscriptionObject;
  'invoice.payment_succeeded': StripeInvoiceObject;
  'invoice.payment_failed': StripeInvoiceObject;
  'invoice.upcoming': StripeInvoiceObject;
  'payment_intent.succeeded': StripePaymentIntentObject;
  'payment_intent.payment_failed': StripePaymentIntentObject;
  'checkout.session.completed': StripeCheckoutSessionObject;
  'checkout.session.expired': StripeCheckoutSessionObject;
  'customer.created': StripeCustomerObject;
  'customer.updated': StripeCustomerObject;
  'customer.deleted': StripeCustomerObject;
}

/**
 * Typed Stripe webhook event.
 * Use the generic to narrow to a specific event:
 * `StripeWebhookEvent<'customer.subscription.updated'>`
 */
export interface StripeWebhookEvent<T extends StripeEventType = StripeEventType> {
  id: string;
  object: 'event';
  type: T;
  api_version: string;
  created: number; // Unix timestamp
  livemode: boolean;
  pending_webhooks: number;
  request: {
    id: string | null;
    idempotency_key: string | null;
  } | null;
  data: {
    object: T extends keyof StripeEventDataObjectMap
      ? StripeEventDataObjectMap[T]
      : Record<string, unknown>;
    /** Present on `*.updated` events; contains changed field values BEFORE the update. */
    previous_attributes?: Partial<
      T extends keyof StripeEventDataObjectMap
        ? StripeEventDataObjectMap[T]
        : Record<string, unknown>
    >;
  };
}

// ---------------------------------------------------------------------------
// 7. Domain-level composite / view types
// ---------------------------------------------------------------------------

/**
 * Full user profile enriched with live subscription, level, and streak data.
 * Returned by the `/me` endpoint.
 */
export interface UserProfile {
  profile: ProfileRow;
  subscription: SubscriptionRow | null;
  level: UserLevelRow;
  streak: StreakRow;
  /** Active missions for the current day. */
  activeMissions: MissionRow[];
  /** Whether the user has completed today's check-in. */
  checkedInToday: boolean;
  /** ISO date today in the user's timezone. */
  todayDate: string;
}

/**
 * Compact health snapshot used as Jarvis context input.
 */
export interface HealthSnapshot {
  userId: UUID;
  /** Aggregated values keyed by metric type for the past N days. */
  recentAggregates: Partial<Record<MetricType, HealthDailyAggregateRow[]>>;
  /** Latest single sample per metric (for real-time vitals). */
  latestSamples: Partial<Record<MetricType, HealthSampleRow>>;
  /** Date range the snapshot covers. */
  from: string; // 'YYYY-MM-DD'
  to: string; // 'YYYY-MM-DD'
}

/**
 * Analytics event shape for client-side tracking (sent to analytics pipeline).
 */
export interface AnalyticsEvent {
  eventName: string;
  userId: UUID | null;
  sessionId: string | null;
  platform: 'ios' | 'android' | 'web';
  appVersion: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp: ISOTimestamp;
}

/**
 * Internal service-to-service auth context injected by the API gateway.
 */
export interface ServiceContext {
  userId: UUID;
  plan: Plan;
  isAdmin: boolean;
  requestId: string;
  region: string;
}
