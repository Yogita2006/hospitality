/**
 * Calculator and matcher tests.
 *
 *   npx tsx scripts/test-calc.ts
 *
 * No server needed — these are pure functions. Run this after any change to
 * deduction.ts or matchHospitals.ts.
 *
 * The assertions encode the rules that must never silently break: ordering of
 * deduction vs co-pay, sub-limit ceilings, network handling, and the direction
 * of the room-upgrade curve.
 */

import fs from "node:fs";
import path from "node:path";

import { calculateOutOfPocket, compareRoomCategories } from "../lib/calculator/deduction";
import { matchHospitals, resolveNetwork, type Hospital } from "../lib/hospitals/matchHospitals";
import type { NormalizedPolicy } from "../lib/policy/policy.types";

const root = process.cwd();
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf-8"));

const retail = read("sample_policies/expected/retail_star_health.json") as NormalizedPolicy;
const corp = read("sample_policies/expected/corporate_gmc.json") as NormalizedPolicy;
const pmjay = read("sample_policies/expected/pmjay.json") as NormalizedPolicy;
const hospitals = read("data/hospitals_clean.json") as Hospital[];

/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const section = (title: string) => console.log(`\n── ${title} ──`);

/* ------------------------------------------------------------------ */
/* 1. Room within cap means no deduction                               */
/* ------------------------------------------------------------------ */

section("Room within cap");

const within = calculateOutOfPocket({
  policy: retail,
  billTotal: 200000,
  roomRatePerDay: 3500,
  roomCategory: "general_ward",
  inNetwork: true,
});

check("no deduction applied", within.deductionApplied === false);
check("ratio is 1", within.ratio === 1);
check(
  "only the 10% co-pay is borne",
  within.patientPays === 20000,
  `got ${inr(within.patientPays)}, expected ${inr(20000)}`
);

/* ------------------------------------------------------------------ */
/* 2. Room above cap triggers proportionate deduction                  */
/* ------------------------------------------------------------------ */

section("Room above cap");

const above = calculateOutOfPocket({
  policy: retail,
  billTotal: 200000,
  roomRatePerDay: 9000,
  roomCategory: "private",
  inNetwork: true,
});

check("deduction applied", above.deductionApplied === true);
check(
  "ratio is cap / actual",
  Math.abs(above.ratio - 5000 / 9000) < 0.0001,
  `got ${above.ratio.toFixed(4)}`
);
check(
  "patient pays materially more than the room difference alone",
  above.patientPays > within.patientPays * 3,
  `${inr(within.patientPays)} -> ${inr(above.patientPays)}`
);
check(
  "exempt share is NOT scaled",
  above.insurerPays > 200000 * above.ratio,
  "insurer payout must exceed a naive full-bill scaling"
);

/* ------------------------------------------------------------------ */
/* 3. Ordering: co-pay applies after deduction, not before             */
/* ------------------------------------------------------------------ */

section("Ordering");

const scalable = 200000 * 0.7;
const exempt = 200000 - scalable;
const admissible = scalable * (5000 / 9000) + exempt;
const expectedInsurer = Math.round(admissible * 0.9);

check(
  "insurer payout matches deduction-then-copay",
  above.insurerPays === expectedInsurer,
  `got ${inr(above.insurerPays)}, expected ${inr(expectedInsurer)}`
);

const wrongOrder = Math.round(200000 * 0.9 * (5000 / 9000));
check(
  "result differs from copay-then-deduction",
  above.insurerPays !== wrongOrder,
  `wrong order would give ${inr(wrongOrder)}`
);

/* ------------------------------------------------------------------ */
/* 4. Sub-limits cap the payout                                        */
/* ------------------------------------------------------------------ */

section("Sub-limits");

const cataract = calculateOutOfPocket({
  policy: retail,
  billTotal: 120000,
  roomRatePerDay: 3500,
  roomCategory: "general_ward",
  inNetwork: true,
  procedureCategory: "cataract_surgery_with_iol",
});

check(
  "payout capped at the 40,000 sub-limit less co-pay",
  cataract.insurerPays === 36000,
  `got ${inr(cataract.insurerPays)}`
);
check(
  "sub-limit step is explained",
  cataract.steps.some((s) => s.label === "Sub-limit applied")
);

/* ------------------------------------------------------------------ */
/* 5. No-cap policy never deducts                                      */
/* ------------------------------------------------------------------ */

section("No-cap policy");

const corpDeluxe = calculateOutOfPocket({
  policy: corp,
  billTotal: 200000,
  roomRatePerDay: 22475,
  roomCategory: "deluxe",
  inNetwork: true,
});

check("no deduction on an uncapped policy", corpDeluxe.deductionApplied === false);
check("patient pays nothing in network", corpDeluxe.patientPays === 0);

const corpOut = calculateOutOfPocket({
  policy: corp,
  billTotal: 200000,
  roomRatePerDay: 14500,
  roomCategory: "private",
  inNetwork: false,
});

check(
  "non-network co-pay only applies out of network",
  corpOut.patientPays > 0 && corpOut.steps.some((s) => s.label.startsWith("Co-payment")),
  `out-of-network patient pays ${inr(corpOut.patientPays)}`
);

/* ------------------------------------------------------------------ */
/* 6. Government scheme behaviour                                      */
/* ------------------------------------------------------------------ */

section("PM-JAY");

const pjIn = calculateOutOfPocket({
  policy: pmjay,
  billTotal: 200000,
  roomRatePerDay: 0,
  roomCategory: "general_ward",
  inNetwork: true,
});
check("empanelled hospital is fully cashless", pjIn.patientPays === 0);

const pjOut = calculateOutOfPocket({
  policy: pmjay,
  billTotal: 200000,
  roomRatePerDay: 6000,
  roomCategory: "general_ward",
  inNetwork: false,
});
check("non-empanelled hospital pays nothing", pjOut.insurerPays === 0);
check("patient is warned", pjOut.warnings.length > 0);

/* ------------------------------------------------------------------ */
/* 7. Room upgrade curve is monotonic                                  */
/* ------------------------------------------------------------------ */

section("Room upgrade curve");

const agrasen = hospitals.find((h) => h.id === "hosp_agrasen_dwarka");
check("Dwarka test hospital present", Boolean(agrasen));

if (agrasen) {
  const rows = compareRoomCategories(
    { policy: retail, billTotal: 132000, inNetwork: true },
    agrasen.room_tariff
  );

  console.log(`\n  ${agrasen.name} — bill ${inr(132000)}`);
  rows.forEach((r) =>
    console.log(
      `    ${r.category.padEnd(14)} ${inr(r.roomRate).padStart(8)}/day   you pay ${inr(r.result.patientPays)}`
    )
  );

  const costs = rows.map((r) => r.result.patientPays);
  const monotonic = costs.every((c, i) => i === 0 || c >= costs[i - 1]);
  check("a pricier room never costs the patient less", monotonic, costs.join(" -> "));
}

/* ------------------------------------------------------------------ */
/* 8. Network resolution                                               */
/* ------------------------------------------------------------------ */

section("Network resolution");

const aiims = hospitals.find((h) => h.id === "hosp_aiims_01");
if (aiims) {
  check("PM-JAY resolves against the pmjay flag", resolveNetwork(pmjay, aiims).inNetwork === true);
}

const govtCount = hospitals.filter((h) => h.hospital_type === "government").length;
check("dataset has government hospitals to test against", govtCount > 0, `${govtCount} found`);

/* ------------------------------------------------------------------ */
/* 9. Matcher filtering and ranking                                    */
/* ------------------------------------------------------------------ */

section("Matcher");

const knee = matchHospitals(hospitals, {
  policy: retail,
  specialty: "orthopedics",
  packageCode: "total_knee_replacement",
  pincodes: ["110075"],
});

check("Dwarka knee-replacement matches found", knee.length > 0, `${knee.length} hospitals`);
check(
  "every match offers the requested package",
  knee.every((m) => m.matchedPackage?.package_code === "total_knee_replacement")
);
check(
  "in-network hospitals rank above out-of-network",
  knee.findIndex((m) => !m.inNetwork) === -1 ||
    knee.findIndex((m) => !m.inNetwork) > knee.findIndex((m) => m.inNetwork)
);

const netOnly = matchHospitals(hospitals, {
  policy: retail,
  specialty: "orthopedics",
  networkOnly: true,
  maxResults: 100,
});
check("networkOnly filter excludes out-of-network", netOnly.every((m) => m.inNetwork));

const bogus = matchHospitals(hospitals, {
  policy: retail,
  specialty: "orthopedics",
  packageCode: "a_package_that_does_not_exist",
});
check("unknown package returns nothing rather than everything", bogus.length === 0);

/* ------------------------------------------------------------------ */

console.log(`\n${"═".repeat(52)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  ${f}`));
}
process.exit(failures.length > 0 ? 1 : 0);