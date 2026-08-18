/**
 * Types for the normalized policy representation.
 * Mirrors policy.schema.json (v1.0.0) — keep the two in sync.
 */

export const POLICY_SCHEMA_VERSION = "1.0.0" as const;

export type Confidence = "high" | "medium" | "low";

export type SchemeType =
  | "retail_indemnity"
  | "corporate_gmc"
  | "government_scheme"
  | "top_up";

export type RoomCategory =
  | "general_ward"
  | "semi_private"
  | "single_private_ac"
  | "deluxe"
  | "icu";

/** Keys that join a policy to the hospital dataset's empanelment block. */
export type InsurerKey =
  | "star_health"
  | "hdfc_ergo"
  | "icici_lombard"
  | "niva_bupa"
  | "care_health"
  | "bajaj_allianz"
  | "new_india_assurance"
  | "tata_aig"
  | "pmjay"
  | "cghs"
  | "esi";

export type CapType =
  | "absolute_per_day"
  | "percent_of_sum_insured"
  | "category_entitlement"
  | "no_limit";

/**
 * A per-day monetary ceiling.
 *
 * Read `resolved_per_day` and nothing else for calculations — it already
 * accounts for percentage-of-sum-insured caps.
 *
 * `resolved_per_day === null` means NO rupee cap applies. Do not coerce
 * that to 0; the two mean opposite things.
 */
export interface CapLimit {
  cap_type: CapType;
  cap_value: number | null;
  resolved_per_day: number | null;
  not_specified: boolean;
  eligible_category?: RoomCategory | null;
  confidence: Confidence;
  source_excerpt?: string | null;
}

export interface Insurer {
  name: string;
  policy_name?: string | null;
  /** Store masked (last 4 only). */
  policy_number?: string | null;
}

export interface Coverage {
  sum_insured: number | null;
  sum_insured_type: "individual" | "floater" | "package_based";
  policy_period?: { start: string; end: string } | null;
  members_covered?: number | null;
  confidence?: Confidence;
}

export interface CoPay {
  /** Applied AFTER proportionate deduction, never before. */
  percent: number;
  applies_to:
    | "all_claims"
    | "non_network_only"
    | "specific_ailments"
    | "senior_citizen_only"
    | "none";
  confidence: Confidence;
  source_excerpt?: string | null;
}

export interface Deductible {
  amount: number;
  confidence: Confidence;
}

export interface SubLimit {
  /** Prefer a package_code from the hospital dataset where one matches. */
  category: string;
  limit_amount: number;
  basis:
    | "per_eye"
    | "per_hospitalization"
    | "per_policy_year"
    | "per_day"
    | "per_claim";
  confidence: Confidence;
  source_excerpt?: string | null;
}

export interface WaitingPeriod {
  category:
    | "initial_waiting"
    | "pre_existing_conditions"
    | "specific_ailments"
    | "maternity"
    | "other";
  months: number;
  label?: string | null;
  confidence: Confidence;
  source_excerpt?: string | null;
}

export interface Exclusion {
  text: string;
  confidence: Confidence;
}

export interface Network {
  type: "cashless_network" | "reimbursement_only" | "empanelled_scheme";
  insurer_key: InsurerKey | null;
  /** true means non-network hospitals are not covered at all. */
  restricted_to_network: boolean;
  non_network_reimbursement_percent?: number | null;
  confidence?: Confidence;
}

export type ExemptCategory =
  | "consumables"
  | "medicines"
  | "implants"
  | "diagnostics"
  | "ambulance";

export interface ProportionateDeduction {
  /** false when the policy waives proportionate deduction entirely. */
  applicable: boolean;
  /** Share of the bill that scales by the room-rent ratio. */
  scalable_component_percent: number;
  /** Reimbursed at actuals, never scaled. */
  exempt_categories: ExemptCategory[];
  confidence?: Confidence;
  note?: string | null;
}

export interface ExtractionMeta {
  extracted_at: string;
  model: string;
  overall_confidence: Confidence;
  /** Dotted paths of low-confidence fields, e.g. "room_rent.cap_value". */
  fields_needing_review: string[];
  source_document?: string | null;
  is_mock_data?: boolean;
}

export interface NormalizedPolicy {
  schema_version: typeof POLICY_SCHEMA_VERSION;
  policy_id: string;
  scheme_type: SchemeType;
  insurer: Insurer;
  coverage: Coverage;
  room_rent: CapLimit;
  icu_rent: CapLimit;
  co_pay: CoPay;
  deductible: Deductible;
  sub_limits: SubLimit[];
  waiting_periods: WaitingPeriod[];
  exclusions: Exclusion[];
  network: Network;
  proportionate_deduction: ProportionateDeduction;
  extraction_meta: ExtractionMeta;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turns a percentage-of-sum-insured cap into a rupee figure.
 * Call this immediately after extraction, before anything reads
 * `resolved_per_day`.
 */
export function resolveCap(cap: CapLimit, sumInsured: number | null): CapLimit {
  if (cap.cap_type === "percent_of_sum_insured" && cap.cap_value != null && sumInsured != null) {
    return { ...cap, resolved_per_day: Math.round((sumInsured * cap.cap_value) / 100) };
  }
  if (cap.cap_type === "absolute_per_day") {
    return { ...cap, resolved_per_day: cap.cap_value };
  }
  return { ...cap, resolved_per_day: null };
}

/** True when the chosen room rate triggers proportionate deduction. */
export function exceedsCap(cap: CapLimit, chosenRoomRate: number): boolean {
  if (cap.resolved_per_day == null) return false;
  return chosenRoomRate > cap.resolved_per_day;
}

/** The scaling ratio. Returns 1 when no deduction applies. */
export function deductionRatio(cap: CapLimit, chosenRoomRate: number): number {
  if (!exceedsCap(cap, chosenRoomRate) || cap.resolved_per_day == null) return 1;
  return cap.resolved_per_day / chosenRoomRate;
}

/** Fields the UI should flag with a "please verify" badge. */
export function needsReview(policy: NormalizedPolicy): string[] {
  const flagged = [...policy.extraction_meta.fields_needing_review];
  if (policy.room_rent.confidence === "low") flagged.push("room_rent");
  if (policy.co_pay.confidence === "low") flagged.push("co_pay");
  return Array.from(new Set(flagged));
}