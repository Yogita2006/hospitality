"use client";

import { rupees } from "@/lib/format";

/**
 * The landing page's thesis.
 *
 * These figures are the real output of the calculator for one hospital in the
 * dataset — Maharaja Agrasen, Dwarka, a knee replacement, on a policy with a
 * ₹5,000 room cap. Showing the answer before asking for a file is the point:
 * the surprise is the gap between the fourth row and the second, and no one
 * needs to upload anything to feel it.
 */

const BILL = 132000;
const CAP = 5000;

const ROWS = [
  { room: "general ward", rate: 2500, pays: 13200 },
  { room: "semi private", rate: 4000, pays: 13200 },
  { room: "private", rate: 7500, pays: 40920 },
  { room: "deluxe", rate: 11625, pays: 60592 },
];

export default function WorkedExample() {
  const firstOver = ROWS.findIndex((r) => r.rate > CAP);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>What the calculation looks like</h3>
        <span className="eyebrow">Worked example</span>
      </div>

      <div className="panel-body">
        <p className="meta" style={{ marginBottom: "14px" }}>
          Knee replacement in Dwarka · {rupees(BILL)} bill · policy covers{" "}
          {rupees(CAP)} a day for the room
        </p>

        <div className="ladder">
          {ROWS.map((row, index) => (
            <div key={row.room}>
              {index === firstOver && (
                <div className="cap-line">
                  <span>Cover stops at {rupees(CAP)}/day</span>
                </div>
              )}
              <div
                className={`rung ${row.rate <= CAP ? "within" : "over"}`}
                style={{ cursor: "default" }}
              >
                <span className="rung-name">{row.room}</span>
                <span className="rung-rate num">{rupees(row.rate)}/day</span>
                <span className="rung-cost num">{rupees(row.pays)}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="example-foot">
          Moving from semi-private to private costs {rupees(3500)} more a day in room
          rent. It costs <strong>{rupees(27720)} more</strong> in total, because the
          insurer scales down the rest of the bill by the same ratio.
        </p>
      </div>
    </section>
  );
}