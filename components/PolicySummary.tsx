"use client";

import type { NormalizedPolicy } from "@/lib/policy/policy.types";
import { describeCap } from "@/lib/policy/validatePolicy";
import { rupees, titleCase } from "@/lib/format";

export default function PolicySummary({ policy }: { policy: NormalizedPolicy }) {
  const { coverage, room_rent, icu_rent, co_pay, deductible, network } = policy;
  const review = policy.extraction_meta.fields_needing_review;
  const capped = room_rent.resolved_per_day !== null;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Policy on file</p>
          <h2>{policy.insurer.name}</h2>
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {policy.proportionate_deduction.applicable && capped ? (
            <span className="flag flag-pay">Proportionate deduction applies</span>
          ) : (
            <span className="flag flag-covered">No proportionate deduction</span>
          )}
          {network.restricted_to_network && (
            <span className="flag flag-caution">Network only</span>
          )}
          <span className="flag flag-caution">{titleCase(policy.scheme_type)}</span>
        </div>
      </div>

      <dl className="facts">
        <div className="fact">
          <dt>Sum insured</dt>
          <dd className="num">
            {coverage.sum_insured === null ? "Package" : rupees(coverage.sum_insured)}
            <small>{titleCase(coverage.sum_insured_type)}</small>
          </dd>
        </div>

        <div className="fact">
          <dt>Room limit</dt>
          <dd className={capped ? "num" : ""}>
            {capped ? `${rupees(room_rent.resolved_per_day as number)}/day` : "No limit"}
            <small>{describeCap(room_rent)}</small>
          </dd>
        </div>

        <div className="fact">
          <dt>ICU limit</dt>
          <dd className={icu_rent.resolved_per_day !== null ? "num" : ""}>
            {icu_rent.resolved_per_day !== null
              ? `${rupees(icu_rent.resolved_per_day)}/day`
              : "No limit"}
            <small>{describeCap(icu_rent)}</small>
          </dd>
        </div>

        <div className="fact">
          <dt>Co-payment</dt>
          <dd>
            {co_pay.percent > 0 ? `${co_pay.percent}%` : "Nil"}
            <small>
              {co_pay.applies_to === "non_network_only"
                ? "Outside network only"
                : co_pay.percent > 0
                  ? "Every claim"
                  : "No co-payment"}
            </small>
          </dd>
        </div>

        <div className="fact">
          <dt>Deductible</dt>
          <dd className="num">
            {deductible.amount > 0 ? rupees(deductible.amount) : "Nil"}
            <small>{deductible.amount > 0 ? "Before cover starts" : "None applicable"}</small>
          </dd>
        </div>
      </dl>

      {review.length > 0 && (
        <div className="panel-body" style={{ paddingTop: 0 }}>
          <div className="notice notice-caution" style={{ marginBottom: 0 }}>
            Verify before relying on these figures — hard to read in the document:{" "}
            {review.join(", ")}.
          </div>
        </div>
      )}
    </section>
  );
}