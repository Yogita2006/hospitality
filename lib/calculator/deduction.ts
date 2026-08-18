/**
 * Out-of-pocket calculator.
 *
 * The whole product is this function. Everything else feeds it or displays
 * its output.
 *
 * ORDER MATTERS. Each step operates on the result of the previous one:
 *
 *   1. split the bill into scalable and exempt components
 *   2. apply the room-rent ratio to the scalable component only
 *   3. cap at any matching sub-limit
 *   4. cap at the sum insured
 *   5. subtract the deductible
 *   6. apply co-pay to what remains
 *   7. apply non-network reimbursement percentage
 *
 * Applying co-pay before proportionate deduction, or the deductible after
 * co-pay, produces a different and wrong number.
 */

import type { NormalizedPolicy, CapLimit } from "../policy/policy.types";

export type RoomCategory =
  | "general_ward"
  | "semi_private"
  | "private"
  | "deluxe"
  | "icu";

export interface CalculationInput {
  policy: NormalizedPolicy;
  /** Total hospital bill in rupees, inclusive of room charges. */
  billTotal: number;
  /** Per-day rate of the room the patient occupies. */
  roomRatePerDay: number;
  roomCategory: RoomCategory;
  /** Whether this hospital accepts the patient's policy. */
  inNetwork: boolean;
  /** Sub-limit category to test against, e.g. "cataract_surgery_with_iol". */
  procedureCategory?: string;
}

export interface CalculationStep {
  label: string;
  /** Plain-language explanation shown in the UI. */
  detail: string;
  /** Running amount after this step, in rupees. */
  amount: number;
}

export interface CalculationResult {
  billTotal: number;
  insurerPays: number;
  patientPays: number;
  /** True when the room rate triggered proportionate deduction. */
  deductionApplied: boolean;
  /** The scaling ratio, 1 when no deduction applies. */
  ratio: number;
  /** The cap that was compared against, null when uncapped. */
  capPerDay: number | null;
  steps: CalculationStep[];
  /** Non-fatal notes: assumptions made, limits hit. */
  warnings: string[];
}

const inr = (n: number) =>
  `₹${Math.round(n).toLocaleString("en-IN")}`;

const round = (n: number) => Math.round(n);

/** Picks the cap that governs this stay: ICU has its own. */
function governingCap(policy: NormalizedPolicy, category: RoomCategory): CapLimit {
  return category === "icu" ? policy.icu_rent : policy.room_rent;
}

export function calculateOutOfPocket(input: CalculationInput): CalculationResult {
  const {
    policy,
    billTotal,
    roomRatePerDay,
    roomCategory,
    inNetwork,
    procedureCategory,
  } = input;

  const steps: CalculationStep[] = [];
  const warnings: string[] = [];

  const cap = governingCap(policy, roomCategory);
  const capPerDay = cap.resolved_per_day;

  steps.push({
    label: "Hospital bill",
    detail: `Estimated total for this admission at the ${roomCategory.replace(/_/g, " ")} rate of ${inr(roomRatePerDay)} per day.`,
    amount: billTotal,
  });

  /* --- Step 1 & 2: proportionate deduction ------------------------- */

  const deductionPossible =
    policy.proportionate_deduction.applicable &&
    capPerDay !== null &&
    roomRatePerDay > capPerDay;

  let ratio = 1;
  let admissible = billTotal;

  if (deductionPossible && capPerDay !== null) {
    ratio = capPerDay / roomRatePerDay;

    const scalablePct = policy.proportionate_deduction.scalable_component_percent;
    const scalableShare = billTotal * (scalablePct / 100);
    const exemptShare = billTotal - scalableShare;
    const scaledShare = scalableShare * ratio;

    admissible = scaledShare + exemptShare;

    steps.push({
      label: "Proportionate deduction",
      detail:
        `Your room costs ${inr(roomRatePerDay)} per day but your policy covers ${inr(capPerDay)}. ` +
        `That ratio (${(ratio * 100).toFixed(0)}%) is applied to ${scalablePct}% of the bill — ` +
        `surgeon, theatre, nursing and consultant charges. ` +
        `The remaining ${100 - scalablePct}% (${policy.proportionate_deduction.exempt_categories.join(", ") || "exempt items"}) is paid in full.`,
      amount: round(admissible),
    });
  } else if (capPerDay !== null && roomRatePerDay > capPerDay) {
    steps.push({
      label: "Room rent above limit",
      detail:
        `Your room costs ${inr(roomRatePerDay)} against a limit of ${inr(capPerDay)}, ` +
        `but this policy waives proportionate deduction, so only the room difference is yours.`,
      amount: round(admissible),
    });
  } else if (capPerDay !== null) {
    steps.push({
      label: "Room within limit",
      detail: `Your room is within the ${inr(capPerDay)} per day limit, so no proportionate deduction applies.`,
      amount: round(admissible),
    });
  } else {
    steps.push({
      label: "No room rent limit",
      detail: "This policy places no cap on room rent, so no proportionate deduction applies.",
      amount: round(admissible),
    });
  }

  /* --- Step 3: sub-limit ------------------------------------------- */

  if (procedureCategory) {
    const subLimit = policy.sub_limits.find(
      (s) => s.category === procedureCategory
    );
    if (subLimit && admissible > subLimit.limit_amount) {
      admissible = subLimit.limit_amount;
      steps.push({
        label: "Sub-limit applied",
        detail:
          `This policy caps ${procedureCategory.replace(/_/g, " ")} at ${inr(subLimit.limit_amount)} ` +
          `(${subLimit.basis.replace(/_/g, " ")}), regardless of your remaining cover.`,
        amount: round(admissible),
      });
    }
  }

  /* --- Step 4: sum insured ----------------------------------------- */

  const sumInsured = policy.coverage.sum_insured;
  if (sumInsured !== null && admissible > sumInsured) {
    admissible = sumInsured;
    steps.push({
      label: "Sum insured reached",
      detail: `Your annual cover of ${inr(sumInsured)} is the ceiling for this claim.`,
      amount: round(admissible),
    });
    warnings.push("This admission exhausts the sum insured.");
  }

  /* --- Step 5: deductible ------------------------------------------ */

  if (policy.deductible.amount > 0) {
    admissible = Math.max(0, admissible - policy.deductible.amount);
    steps.push({
      label: "Deductible",
      detail: `The first ${inr(policy.deductible.amount)} of any claim is yours to pay.`,
      amount: round(admissible),
    });
  }

  /* --- Step 6: co-pay ---------------------------------------------- */

  const coPayApplies =
    policy.co_pay.percent > 0 &&
    (policy.co_pay.applies_to === "all_claims" ||
      (policy.co_pay.applies_to === "non_network_only" && !inNetwork));

  if (coPayApplies) {
    const coPayAmount = admissible * (policy.co_pay.percent / 100);
    admissible -= coPayAmount;
    steps.push({
      label: `Co-payment ${policy.co_pay.percent}%`,
      detail:
        policy.co_pay.applies_to === "non_network_only"
          ? `This hospital is outside your network, so a ${policy.co_pay.percent}% co-payment of ${inr(coPayAmount)} applies.`
          : `A ${policy.co_pay.percent}% co-payment of ${inr(coPayAmount)} applies to every claim under this policy.`,
      amount: round(admissible),
    });
  }

  /* --- Step 7: network --------------------------------------------- */

  if (!inNetwork) {
    if (policy.network.restricted_to_network) {
      admissible = 0;
      steps.push({
        label: "Outside network",
        detail:
          "This policy covers treatment only at network hospitals. Nothing is payable here.",
        amount: 0,
      });
      warnings.push("This hospital is not covered by your policy at all.");
    } else {
      const pct = policy.network.non_network_reimbursement_percent;
      if (pct !== null && pct !== undefined && pct < 100) {
        admissible = admissible * (pct / 100);
        steps.push({
          label: "Non-network reimbursement",
          detail: `Outside the network, only ${pct}% of the admissible amount is reimbursed.`,
          amount: round(admissible),
        });
      }
      warnings.push(
        "Non-network treatment is reimbursed later, not cashless — you pay upfront."
      );
    }
  }

  const insurerPays = Math.max(0, round(admissible));
  const patientPays = Math.max(0, round(billTotal - insurerPays));

  steps.push({
    label: "You pay",
    detail: `Out of a ${inr(billTotal)} bill, your insurer covers ${inr(insurerPays)}.`,
    amount: patientPays,
  });

  if (policy.extraction_meta.fields_needing_review.length > 0) {
    warnings.push(
      "Some policy values could not be read confidently — verify before relying on this figure."
    );
  }

  return {
    billTotal: round(billTotal),
    insurerPays,
    patientPays,
    deductionApplied: deductionPossible,
    ratio,
    capPerDay,
    steps,
    warnings,
  };
}

/**
 * Runs the calculation across every room category a hospital offers.
 * This is what powers the room slider: same bill, different outcome.
 */
export function compareRoomCategories(
  base: Omit<CalculationInput, "roomRatePerDay" | "roomCategory">,
  tariff: Partial<Record<RoomCategory, number | null>>
): Array<{ category: RoomCategory; roomRate: number; result: CalculationResult }> {
  const order: RoomCategory[] = [
    "general_ward",
    "semi_private",
    "private",
    "deluxe",
    "icu",
  ];

  return order
    .filter((c) => c !== "icu")
    .map((category) => {
      const roomRate = tariff[category];
      if (roomRate === null || roomRate === undefined) return null;
      return {
        category,
        roomRate,
        result: calculateOutOfPocket({ ...base, roomRatePerDay: roomRate, roomCategory: category }),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}