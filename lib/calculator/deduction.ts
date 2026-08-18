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

/**
 * One line of the discharge bill the patient is left holding, with the reason
 * it was not paid.
 *
 * This is the part caregivers never see coming. The hospital hands over a
 * total; the insurer settles part of it; nobody itemises the gap. Naming each
 * component and the clause behind it is the whole point of the tool.
 */
export interface PatientCharge {
  label: string;
  amount: number;
  /** Plain-language reason, written to be read at an admission counter. */
  reason: string;
  /** Where it came from, for grouping and for the writeup. */
  source:
    | "proportionate_deduction"
    | "co_pay"
    | "deductible"
    | "sub_limit"
    | "sum_insured"
    | "non_network"
    | "non_payable_items";
  /** True when the figure rests on an assumption rather than the policy text. */
  estimated?: boolean;
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
  /** Itemised reasons the patient is paying anything at all. */
  charges: PatientCharge[];
  /** Non-fatal notes: assumptions made, limits hit. */
  warnings: string[];
}

/**
 * Hospitals bill a set of items no Indian health policy pays for: gloves,
 * syringes, admission kits, attendant charges, documentation fees. IRDAI
 * publishes the list; insurers call them non-medical or non-payable items.
 *
 * They are the single most common discharge surprise and they appear on
 * every bill, so leaving them out would understate what the caregiver
 * actually hands over. The share below is an illustrative planning figure,
 * not a policy term — it is labelled as an estimate wherever it is shown.
 */
const NON_PAYABLE_ITEMS_PERCENT = 3;

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
  const charges: PatientCharge[] = [];

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

    charges.push({
      label: "Proportionate deduction",
      amount: round(scalableShare - scaledShare),
      reason:
        `Your policy covers ${inr(capPerDay)} a day for the room; this room costs ` +
        `${inr(roomRatePerDay)}. Because you went above the limit, the insurer pays ` +
        `only ${(ratio * 100).toFixed(0)}% of the surgeon, theatre, nursing and ` +
        `consultant charges — not just the room difference.`,
      source: "proportionate_deduction",
    });

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
      charges.push({
        label: `${procedureCategory.replace(/_/g, " ")} sub-limit`,
        amount: round(admissible - subLimit.limit_amount),
        reason:
          `This policy caps ${procedureCategory.replace(/_/g, " ")} at ` +
          `${inr(subLimit.limit_amount)} ${subLimit.basis.replace(/_/g, " ")}, ` +
          `however much cover you have left.`,
        source: "sub_limit",
      });
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
    charges.push({
      label: "Above your sum insured",
      amount: round(admissible - sumInsured),
      reason:
        `Your annual cover is ${inr(sumInsured)}. Anything past that is yours, ` +
        `and this admission uses all of it.`,
      source: "sum_insured",
    });
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
    charges.push({
      label: "Deductible",
      amount: Math.min(policy.deductible.amount, round(admissible)),
      reason: `The first ${inr(policy.deductible.amount)} of any claim is yours before cover starts.`,
      source: "deductible",
    });
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

    charges.push({
      label: `Co-payment (${policy.co_pay.percent}%)`,
      amount: round(coPayAmount),
      reason:
        policy.co_pay.applies_to === "non_network_only"
          ? `This hospital is outside your network, so you carry ${policy.co_pay.percent}% of whatever is approved.`
          : `Your policy makes you carry ${policy.co_pay.percent}% of every approved claim. It applies after all other deductions.`,
      source: "co_pay",
    });

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
      charges.push({
        label: "Hospital not covered",
        amount: round(admissible),
        reason:
          "This policy pays only at hospitals in its network. Treatment here is not covered at all.",
        source: "non_network",
      });
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
        charges.push({
          label: "Non-network reimbursement",
          amount: round(admissible * (1 - pct / 100)),
          reason: `Outside the network only ${pct}% of the approved amount comes back to you, and it comes back later — you pay the hospital in full first.`,
          source: "non_network",
        });
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

  // Non-medical consumables are billed by the hospital and paid by nobody
  // else. They sit outside the admissible-amount arithmetic entirely, which
  // is exactly why they surprise people at the counter.
  if (insurerPays > 0) {
    charges.push({
      label: "Non-medical items",
      amount: round(billTotal * (NON_PAYABLE_ITEMS_PERCENT / 100)),
      reason:
        "Gloves, syringes, admission kits, attendant charges and documentation " +
        "fees are on IRDAI's non-payable list. No health policy covers them, and " +
        "they appear on the final bill rather than in the claim.",
      source: "non_payable_items",
      estimated: true,
    });
  }

  // Largest first: the caregiver wants the reason for the biggest number.
  charges.sort((a, b) => b.amount - a.amount);

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
    charges,
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
