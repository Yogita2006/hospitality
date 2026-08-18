/**
 * The extraction prompt.
 *
 * The schema is loaded from policy.schema.json rather than duplicated here,
 * so the prompt can never drift from what the validator enforces.
 */

import schema from "../policy/policy.schema.json";

/**
 * Models are tried in order. When one is overloaded or has been retired, the
 * next is tried.
 *
 * The newest model is deliberately not first: free-tier capacity on the
 * latest release is the most contended, and extraction needs a model that
 * answers rather than a frontier one.
 *
 * gemini-flash-latest sits near the end as an alias Google keeps pointing at
 * a live model, so the chain cannot be retired out from under it.
 */
export const EXTRACTION_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
] as const;

/** Kept for anything that wants a single name. */
export const EXTRACTION_MODEL = EXTRACTION_MODELS[0];

export const SYSTEM_PROMPT = `You extract structured data from Indian health insurance policy documents.

You return ONE JSON object conforming exactly to the schema below. No prose, no explanation, no markdown code fences. Your entire response is the JSON object.

═══ SCHEMA ═══
${JSON.stringify(schema, null, 2)}
═══ END SCHEMA ═══

RULES — these matter more than completeness.

1. NEVER INVENT A VALUE.
   If the document does not state something, the field is null and its
   confidence is "low". A wrong number is far worse than a null. You are not
   being scored on how many fields you fill.

2. SILENT IS NOT ZERO.
   If the document says nothing about a room rent cap, that means NO CAP
   exists — set not_specified: true, cap_type: "no_limit", resolved_per_day:
   null. Never write 0 to mean "not mentioned". Zero and absent are opposite
   outcomes for the patient.

3. THE SCHEDULE WINS.
   Policy documents state the same value in two places: the Policy Schedule
   (first pages, specific to this policyholder) and the Policy Wording
   (generic boilerplate). Where they disagree, take the Schedule. It is also
   what the contract says prevails.

4. EVERY NUMBER NEEDS A source_excerpt.
   Copy the sentence or table row from the document VERBATIM — do not
   paraphrase, do not clean it up, do not merge two lines. If you cannot
   point at a line in the document, you do not have the value: set it null
   with confidence "low".

5. RESOLVE PERCENTAGE CAPS.
   "2% of sum insured per day" with sum_insured 500000 becomes
   cap_type: "percent_of_sum_insured", cap_value: 2, resolved_per_day: 10000.
   If sum_insured is null, leave resolved_per_day null.

6. SCOPE THE CO-PAY CORRECTLY.
   A co-pay that applies only outside the network is applies_to:
   "non_network_only", NOT "all_claims". This distinction changes what the
   patient pays. Read the qualifying clause, not just the percentage.

7. GOVERNMENT SCHEMES ARE STRUCTURALLY DIFFERENT.
   PM-JAY, ESI, Arogya Karnataka and similar schemes are package-based:
   scheme_type "government_scheme", sum_insured_type "package_based",
   room cap_type "category_entitlement" with eligible_category set, and
   restricted_to_network: true. They have no rupee room cap.

8. CONFIDENCE IS HONEST.
   "high"   — stated explicitly, unambiguously, in one place
   "medium" — inferred from context, or stated ambiguously, or in a table
              whose header you had to interpret
   "low"    — not found, or you are guessing
   List the dotted path of every low-confidence field in
   extraction_meta.fields_needing_review.

9. insurer_key MUST be one of the schema's enum values, or null. Do not
   invent a key for an insurer not in the list — null is correct there.

10. Set extraction_meta.is_mock_data to true and schema_version to "1.0.0".
11. MASK THE POLICY NUMBER.
   insurer.policy_number must be the last 4 characters only, prefixed with
   asterisks: "****1234". Never return the full number. It is user PII and
   nothing in the system needs it.

12. SUB-LIMIT CATEGORIES USE SNAKE_CASE SHORT KEYS.
   Use the shortest sensible key: "ambulance" not "road_ambulance",
   "cataract_surgery_with_iol" for cataract, "normal_delivery",
   "cesarean_section". These keys join to the hospital dataset, so an
   invented variant breaks the join.

13. LIST EVERY EXCLUSION the document states, not just the first few. Keep
   each one to a short phrase; do not copy the full sub-clause.

14. LEAVE label NULL unless category is "specific_ailments" or "other".
   For initial_waiting, pre_existing_conditions and maternity the category
   already says everything; a label there is noise.

15. WHEN cap_type IS "no_limit", eligible_category IS null.
   No cap means no category restriction, so there is nothing to name. Do not
   guess the highest category the document happens to mention.

16. WHEN proportionate_deduction.applicable IS false,
   scalable_component_percent MUST be 0 and exempt_categories MUST be [].
   Nothing scales, so there is no scalable share. Do not carry the 70 default
   into a policy that waives deduction.

17. IN GOVERNMENT SCHEMES, BOTH room_rent AND icu_rent USE
   cap_type "category_entitlement" — never "no_limit". Package-based cover
   is not the same as uncapped cover: the entitlement is defined by category,
   and stepping outside it moves the whole admission out of the scheme.
   Set eligible_category on both ("general_ward" and "icu" respectively).

18. WHEN restricted_to_network IS true,
   non_network_reimbursement_percent IS 0, not null.
   The document has answered the question: nothing is reimbursed outside the
   network. null means "unknown", which is a different and weaker claim.

Output the JSON object and nothing else.`;

export const USER_INSTRUCTION = `Extract this policy into the schema. Return only the JSON object.`;

/**
 * Two worked cases the model gets wrong most often. Kept short on purpose —
 * long few-shots crowd out the document itself.
 */
export const FEW_SHOT_NOTES = `Two cases that are commonly got wrong:

CASE A — the document says "No capping on room rent is applicable."
  Correct: cap_type "no_limit", cap_value null, resolved_per_day null,
  not_specified false, and proportionate_deduction.applicable false if the
  document also waives it.
  Wrong: cap_value 0, or resolved_per_day 0.

CASE B — the document says "A co-payment of 20% shall apply ONLY where
treatment is taken at a hospital outside the Network."
  Correct: percent 20, applies_to "non_network_only".
  Wrong: applies_to "all_claims".`;

export function buildInstruction(includeFewShot = true): string {
  return includeFewShot
    ? `${FEW_SHOT_NOTES}\n\n${USER_INSTRUCTION}`
    : USER_INSTRUCTION;
}