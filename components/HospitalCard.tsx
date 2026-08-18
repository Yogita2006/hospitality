"use client";

import { useState } from "react";
import type { HospitalMatch, RoomOption } from "@/lib/hospitals/matchHospitals";
import { rupees } from "@/lib/format";

/**
 * Rooms in price order with one dashed line drawn where the policy stops
 * covering the room rate. Above the line the figures are green; below it they
 * are amber, because below it the patient is paying a share of the whole bill
 * and not just the room difference.
 *
 * Everything inside a <button> here is inline: block elements nested in a
 * button are invalid markup and React will complain about them at hydration.
 */
function RoomLadder({
  options,
  capPerDay,
}: {
  options: RoomOption[];
  capPerDay: number | null;
}) {
  const [openRoom, setOpenRoom] = useState<string | null>(null);

  const byRate = [...options].sort((a, b) => a.roomRate - b.roomRate);
  const firstOver = byRate.findIndex((o) => !o.withinCap);
  const expanded = byRate.find((o) => o.category === openRoom) ?? null;

  return (
    <>
      <div className="ladder">
        {byRate.map((option, index) => (
          <div key={option.category}>
            {capPerDay !== null && firstOver > -1 && index === firstOver && (
              <div className="cap-line">
                <span>Cover stops at {rupees(capPerDay)}/day</span>
              </div>
            )}

            <button
              type="button"
              className={`rung ${option.withinCap ? "within" : "over"}`}
              onClick={() =>
                setOpenRoom(openRoom === option.category ? null : option.category)
              }
              aria-expanded={openRoom === option.category}
            >
              <span className="rung-name">{option.category.replace(/_/g, " ")}</span>
              <span className="rung-rate num">{rupees(option.roomRate)}/day</span>
              <span className="rung-cost num">{rupees(option.result.patientPays)}</span>
            </button>
          </div>
        ))}
      </div>

      {expanded && expanded.result.charges.length > 0 && (
        <div className="why">
          <p className="why-head">
            Why you pay {rupees(expanded.result.patientPays)}
          </p>

          {expanded.result.charges.map((charge, i) => (
            <div className="why-row" key={i}>
              <div>
                <strong>
                  {charge.label}
                  {charge.estimated && <span className="why-est">estimate</span>}
                </strong>
                <p>{charge.reason}</p>
              </div>
              <span className="val num">{rupees(charge.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="breakdown">
          {expanded.result.steps.map((step, i) => (
            <div className="step-row" key={i}>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
              <span className="val num">{rupees(step.amount)}</span>
            </div>
          ))}

          {expanded.result.warnings.map((warning, i) => (
            <div className="notice notice-caution" key={i} style={{ margin: "10px 0" }}>
              {warning}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function HospitalCard({ match }: { match: HospitalMatch }) {
  const [open, setOpen] = useState(false);

  const { hospital, inNetwork, networkReason, matchedPackage, estimatedBill } = match;
  const capPerDay = match.roomOptions[0]?.result.capPerDay ?? null;

  const location = hospital.location.pincode ?? hospital.location.city;
  const accreditation = hospital.accreditation.nabh ? " · NABH" : "";

  return (
    <div className={`hospital ${inNetwork ? "" : "is-out"}`}>
      <button
        type="button"
        className="hospital-row"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>
          <span className="name">{hospital.name}</span>
          <span className="sub">
            {match.distanceKm !== null ? `${match.distanceKm.toFixed(1)} km · ` : ""}
            {location} · {hospital.hospital_type}
            {accreditation}
          </span>
        </span>

        <span className="cell">
          <span className={`flag ${inNetwork ? "flag-covered" : "flag-caution"}`}>
            {inNetwork ? "Cashless" : "Out of network"}
          </span>
        </span>

        <span className="cell muted num">{rupees(estimatedBill)}</span>
        <span className="cell pay num">{rupees(match.bestCase)}</span>
      </button>

      {open && (
        <div className="detail">
          <p className="meta" style={{ marginBottom: "10px" }}>
            {networkReason}
            {matchedPackage
              ? ` · ${matchedPackage.package_code.replace(/_/g, " ")}, typically ${matchedPackage.typical_length_of_stay_days} days`
              : ""}
          </p>

          <RoomLadder options={match.roomOptions} capPerDay={capPerDay} />

          <p className="meta" style={{ marginTop: "10px" }}>
            Select a room category to see the full calculation.
          </p>
        </div>
      )}
    </div>
  );
}
