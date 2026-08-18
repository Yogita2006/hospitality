/**
 * Runtime validation for LLM-extracted policies.
 *
 *   npm install ajv ajv-formats
 *
 * Note the import path: this schema uses JSON Schema 2020-12, so you must
 * import from "ajv/dist/2020" and not the default "ajv" entry point.
 */

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import schema from "./policy.schema.json";
import type { NormalizedPolicy, CapLimit } from "./policy.types";
import { resolveCap } from "./policy.types";

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

const validate = ajv.compile(schema);

export interface ValidationResult {
  valid: boolean;
  policy: NormalizedPolicy | null;
  errors: string[];
}

/**
 * Validates raw model output and resolves percentage caps into rupee figures.
 *
 * The schema sets additionalProperties: false throughout, so any field the
 * model invents is rejected rather than silently carried forward. That is
 * deliberate — a hallucinated field is a bug you want to see immediately.
 */
export function validatePolicy(raw: unknown): ValidationResult {
  const ok = validate(raw);

  if (!ok) {
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message}`
    );
    return { valid: false, policy: null, errors };
  }

  const policy = raw as unknown as NormalizedPolicy;
  const sumInsured = policy.coverage.sum_insured;

  const resolved: NormalizedPolicy = {
    ...policy,
    room_rent: resolveCap(policy.room_rent, sumInsured),
    icu_rent: resolveCap(policy.icu_rent, sumInsured),
  };

  return { valid: true, policy: resolved, errors: [] };
}

/** Strips code fences before parsing. Models add them even when told not to. */
export function parseModelOutput(text: string): unknown {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

/** Human-readable summary of a cap, for the UI. */
export function describeCap(cap: CapLimit): string {
  if (cap.not_specified || cap.cap_type === "no_limit") {
    return "No limit specified — full room charges are covered.";
  }
  if (cap.cap_type === "category_entitlement") {
    return `Entitled to ${cap.eligible_category?.replace(/_/g, " ") ?? "a standard room"}.`;
  }
  if (cap.resolved_per_day == null) {
    return "Could not determine a limit — please verify.";
  }
  const base = `₹${cap.resolved_per_day.toLocaleString("en-IN")} per day`;
  return cap.cap_type === "percent_of_sum_insured"
    ? `${base} (${cap.cap_value}% of sum insured)`
    : base;
}