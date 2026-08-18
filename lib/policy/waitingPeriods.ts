/**
 * Waiting period check.
 *
 * A policy can be perfectly valid and still not pay for the procedure you are
 * about to have, because the clock on that particular condition has not run
 * out. Room caps and co-pay change what you pay; a waiting period changes
 * whether anything is paid at all — so this has to be checked before any of
 * the cost arithmetic is worth reading.
 */

import type { NormalizedPolicy, WaitingPeriod } from "./policy.types";

/**
 * Terms that connect a procedure to the wording insurers use in their
 * specific-ailment clauses. The clause names conditions, not package codes,
 * so the match has to go through language.
 */
const PROCEDURE_TERMS: Record<string, string[]> = {
  total_knee_replacement: ["joint replacement", "knee", "orthopaedic", "orthopedic"],
  hip_replacement: ["joint replacement", "hip", "orthopaedic", "orthopedic"],
  cataract_surgery_with_iol: ["cataract"],
  hernia_repair: ["hernia"],
  normal_delivery: ["maternity", "pregnancy", "delivery"],
  cesarean_section: ["maternity", "pregnancy", "delivery", "caesarean", "cesarean"],
  hemodialysis_per_session: ["renal", "kidney", "dialysis"],
  chemotherapy_cycle: ["cancer", "oncology", "malignan"],
  coronary_angioplasty_single_stent: ["cardiac", "heart", "coronary"],
  coronary_artery_bypass_graft: ["cardiac", "heart", "coronary", "bypass"],
  laparoscopic_cholecystectomy: ["gall bladder", "gallbladder", "cholecyst"],
  laparoscopic_appendectomy: [],
};

export interface WaitingPeriodCheck {
  /** A waiting period exists for this procedure. */
  applies: boolean;
  months: number;
  /** Months of cover completed, when the policy start date is known. */
  monthsElapsed: number | null;
  /** true when the wait is still running, false when served, null if unknown. */
  stillWaiting: boolean | null;
  /** The date cover begins, when it can be worked out. */
  coveredFrom: string | null;
  clause: WaitingPeriod | null;
  /** Ready to display. */
  message: string | null;
}

const NONE: WaitingPeriodCheck = {
  applies: false,
  months: 0,
  monthsElapsed: null,
  stillWaiting: null,
  coveredFrom: null,
  clause: null,
  message: null,
};

const label = (code: string) => code.replace(/_/g, " ");

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth()) -
    (to.getDate() < from.getDate() ? 1 : 0)
  );
}

/**
 * Finds the clause that governs this procedure.
 *
 * Maternity has its own category, so it is matched directly. Everything else
 * goes through the specific-ailment clause, whose label lists the conditions
 * in prose.
 */
function findClause(
  policy: NormalizedPolicy,
  packageCode: string
): WaitingPeriod | null {
  const terms = PROCEDURE_TERMS[packageCode] ?? [];
  if (terms.length === 0) return null;

  const isMaternity = terms.includes("maternity");

  if (isMaternity) {
    const maternity = policy.waiting_periods.find((w) => w.category === "maternity");
    if (maternity) return maternity;
  }

  for (const clause of policy.waiting_periods) {
    if (clause.category !== "specific_ailments" && clause.category !== "other") {
      continue;
    }
    const haystack = `${clause.label ?? ""} ${clause.source_excerpt ?? ""}`.toLowerCase();
    if (terms.some((term) => haystack.includes(term))) return clause;
  }

  return null;
}

export function checkWaitingPeriod(
  policy: NormalizedPolicy,
  packageCode: string | null | undefined
): WaitingPeriodCheck {
  if (!packageCode) return NONE;

  const clause = findClause(policy, packageCode);
  if (!clause || clause.months <= 0) return NONE;

  const start = policy.coverage.policy_period?.start
    ? new Date(policy.coverage.policy_period.start)
    : null;

  // Without a start date the wait cannot be resolved either way, so the
  // clause is reported as a fact rather than as a verdict.
  if (!start || Number.isNaN(start.getTime())) {
    return {
      applies: true,
      months: clause.months,
      monthsElapsed: null,
      stillWaiting: null,
      coveredFrom: null,
      clause,
      message:
        `${label(packageCode)} is subject to a ${clause.months}-month waiting period ` +
        `under this policy. Check when your cover started — if the wait is not ` +
        `complete, this admission may not be paid at all.`,
    };
  }

  const elapsed = monthsBetween(start, new Date());
  const covered = new Date(start);
  covered.setMonth(covered.getMonth() + clause.months);
  const stillWaiting = elapsed < clause.months;

  return {
    applies: true,
    months: clause.months,
    monthsElapsed: elapsed,
    stillWaiting,
    coveredFrom: covered.toISOString().slice(0, 10),
    clause,
    message: stillWaiting
      ? `${label(packageCode)} is subject to a ${clause.months}-month waiting period ` +
        `under this policy. Your cover has run ${elapsed} month${elapsed === 1 ? "" : "s"}, ` +
        `so this is not payable until ${formatDate(covered.toISOString())}. ` +
        `The costs below assume it is covered.`
      : `${label(packageCode)} carries a ${clause.months}-month waiting period, ` +
        `which your policy has completed.`,
  };
}
