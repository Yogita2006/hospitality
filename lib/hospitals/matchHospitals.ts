/**
 * Hospital matching.
 *
 * Filters the hospital dataset by what the patient actually needs, then ranks
 * by the number that matters: what they will pay out of pocket.
 *
 * Ranking by price alone is wrong. A cheaper hospital outside the network can
 * cost far more than a pricier one inside it, and a room category the policy
 * does not cover turns a small saving into a large bill.
 */

import type { NormalizedPolicy } from "../policy/policy.types";
import {
  calculateOutOfPocket,
  type CalculationResult,
  type RoomCategory,
} from "../calculator/deduction";

/* ------------------------------------------------------------------ */
/* Dataset shapes — mirror data/hospitals_clean.json                   */
/* ------------------------------------------------------------------ */

export interface HospitalPackage {
  package_code: string;
  specialty: string;
  estimated_total: number;
  typical_length_of_stay_days: number;
}

export interface Hospital {
  id: string;
  name: string;
  hospital_type: "government" | "private" | "trust";
  location: {
    address: string;
    city: string;
    state: string;
    pincode: string | null;
    /** Added by scripts/geocode.mjs. Absent until that has been run. */
    lat?: number;
    lng?: number;
    geocode_precision?: string;
  };
  specialties: string[];
  specialties_raw: string[];
  room_tariff: Record<string, number | null>;
  tariff_confidence: string;
  charges: { opd_registration: number | null; diet_per_day: number | null };
  empanelment: {
    pmjay: boolean;
    cghs: boolean;
    esi: boolean;
    insurer_network: string[];
    cashless_available: boolean;
  };
  accreditation: { nabh: boolean };
  procedure_packages: HospitalPackage[];
}

export interface MatchOptions {
  policy: NormalizedPolicy;
  /** Canonical specialty tag, e.g. "cardiology". */
  specialty?: string;
  /** Package code, e.g. "total_knee_replacement". Narrows further. */
  packageCode?: string;
  /** Restrict to these pincodes. */
  pincodes?: string[];
  /** Rank and filter by distance from this point instead of by pincode. */
  origin?: { lat: number; lng: number };
  /** Only hospitals within this many kilometres of origin. */
  radiusKm?: number;
  /** Only hospitals that accept this policy. */
  networkOnly?: boolean;
  maxResults?: number;
}

export interface RoomOption {
  category: RoomCategory;
  roomRate: number;
  /** True when this category is within the policy's room rent cap. */
  withinCap: boolean;
  result: CalculationResult;
}

export interface HospitalMatch {
  hospital: Hospital;
  inNetwork: boolean;
  /** How the policy connects to this hospital, for display. */
  networkReason: string;
  /** The package used for costing, when one was matched. */
  matchedPackage: HospitalPackage | null;
  estimatedBill: number;
  /** Every room category, cheapest out-of-pocket first. */
  roomOptions: RoomOption[];
  /** Straight-line distance from the search origin, when one was given. */
  distanceKm: number | null;
  /** Lowest out-of-pocket across all room categories. */
  bestCase: number;
  /** Highest out-of-pocket, i.e. the most expensive room. */
  worstCase: number;
}

/* ------------------------------------------------------------------ */
/* Network resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Decides whether a policy is accepted at a hospital.
 * Government schemes check their own empanelment flag; private insurers check
 * the network list.
 */
/**
 * Maps an insurer's trading name onto the key the dataset uses.
 *
 * The extraction is told to emit a key from the schema enum, but a policy
 * that names an insurer slightly differently — or a model that plays it safe
 * and returns null — would otherwise put every hospital out of network, which
 * is both wrong and alarming. Falling back to the name keeps the answer
 * correct when the key is missing.
 */
const INSURER_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/star\s*health/i, "star_health"],
  [/hdfc\s*ergo/i, "hdfc_ergo"],
  [/icici\s*lombard/i, "icici_lombard"],
  [/niva\s*bupa|max\s*bupa/i, "niva_bupa"],
  [/care\s*health|religare/i, "care_health"],
  [/bajaj\s*allianz/i, "bajaj_allianz"],
  [/new\s*india\s*assurance/i, "new_india_assurance"],
  [/tata\s*aig/i, "tata_aig"],
  [/pm-?jay|pradhan\s*mantri|ayushman\s*bharat/i, "pmjay"],
  [/\bcghs\b|central\s*government\s*health/i, "cghs"],
  [/\besi\b|employees'?\s*state\s*insurance/i, "esi"],
];

function insurerKeyFor(policy: NormalizedPolicy): string | null {
  if (policy.network.insurer_key) return policy.network.insurer_key;

  const haystack = `${policy.insurer.name} ${policy.insurer.policy_name ?? ""}`;
  for (const [pattern, key] of INSURER_NAME_PATTERNS) {
    if (pattern.test(haystack)) return key;
  }
  return null;
}

export function resolveNetwork(
  policy: NormalizedPolicy,
  hospital: Hospital
): { inNetwork: boolean; reason: string } {
  const key = insurerKeyFor(policy);

  if (key === "pmjay") {
    return hospital.empanelment.pmjay
      ? { inNetwork: true, reason: "Empanelled under PM-JAY" }
      : { inNetwork: false, reason: "Not empanelled under PM-JAY" };
  }
  if (key === "cghs") {
    return hospital.empanelment.cghs
      ? { inNetwork: true, reason: "CGHS empanelled" }
      : { inNetwork: false, reason: "Not CGHS empanelled" };
  }
  if (key === "esi") {
    return hospital.empanelment.esi
      ? { inNetwork: true, reason: "ESI empanelled" }
      : { inNetwork: false, reason: "Not ESI empanelled" };
  }
  if (key === null) {
    return {
      inNetwork: false,
      reason: "Insurer not recognised — network status unknown",
    };
  }

  const listed = hospital.empanelment.insurer_network.includes(key);
  const insurerLabel = key.replace(/_/g, " ");
  return listed
    ? {
        inNetwork: true,
        reason: hospital.empanelment.cashless_available
          ? `Cashless available with ${insurerLabel}`
          : `In ${insurerLabel} network`,
      }
    : { inNetwork: false, reason: `Not in the ${insurerLabel} network` };
}

/* ------------------------------------------------------------------ */
/* Distance                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Straight-line distance. Road distance would be more useful but needs a
 * routing call per hospital; for ranking a shortlist the difference does not
 * change the order enough to justify that.
 */
export function distanceBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ */
/* Costing                                                             */
/* ------------------------------------------------------------------ */

const ROOM_ORDER: RoomCategory[] = [
  "general_ward",
  "semi_private",
  "private",
  "deluxe",
];

/**
 * Falls back to a length-of-stay estimate when no package matches, so a
 * hospital without a listed package is still comparable rather than hidden.
 */
function estimateBill(
  hospital: Hospital,
  pkg: HospitalPackage | null
): { bill: number; estimated: boolean } {
  if (pkg) return { bill: pkg.estimated_total, estimated: false };

  const anchor =
    hospital.room_tariff.private ??
    hospital.room_tariff.semi_private ??
    hospital.room_tariff.general_ward ??
    5000;
  return { bill: Math.round(anchor * 3 * 2.5), estimated: true };
}

function buildRoomOptions(
  policy: NormalizedPolicy,
  hospital: Hospital,
  bill: number,
  inNetwork: boolean,
  packageCode?: string
): RoomOption[] {
  const cap = policy.room_rent.resolved_per_day;

  return ROOM_ORDER.map((category) => {
    const roomRate = hospital.room_tariff[category];
    if (roomRate === null || roomRate === undefined) return null;

    const result = calculateOutOfPocket({
      policy,
      billTotal: bill,
      roomRatePerDay: roomRate,
      roomCategory: category,
      inNetwork,
      procedureCategory: packageCode,
    });

    return {
      category,
      roomRate,
      withinCap: cap === null || roomRate <= cap,
      result,
    };
  })
    .filter((o): o is RoomOption => o !== null)
    .sort((a, b) => a.result.patientPays - b.result.patientPays);
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

export function matchHospitals(
  hospitals: Hospital[],
  options: MatchOptions
): HospitalMatch[] {
  const {
    policy,
    specialty,
    packageCode,
    pincodes,
    origin,
    radiusKm,
    networkOnly = false,
    maxResults = 20,
  } = options;

  const matches: HospitalMatch[] = [];

  for (const hospital of hospitals) {
    if (specialty && !hospital.specialties.includes(specialty)) continue;

    if (pincodes?.length) {
      const pin = hospital.location.pincode;
      if (!pin || !pincodes.includes(pin)) continue;
    }

    // Distance is only known for hospitals that have been geocoded. A missing
    // coordinate excludes the hospital from a radius search rather than
    // silently placing it at the centre.
    let distanceKm: number | null = null;
    if (origin) {
      const { lat, lng } = hospital.location;
      if (lat === undefined || lng === undefined) {
        if (radiusKm !== undefined) continue;
      } else {
        distanceKm = distanceBetween(origin, { lat, lng });
        if (radiusKm !== undefined && distanceKm > radiusKm) continue;
      }
    }

    const pkg = packageCode
      ? hospital.procedure_packages.find((p) => p.package_code === packageCode) ?? null
      : null;

    // A specific procedure was asked for and this hospital does not offer it.
    if (packageCode && !pkg) continue;

    const { inNetwork, reason } = resolveNetwork(policy, hospital);
    if (networkOnly && !inNetwork) continue;

    const { bill } = estimateBill(hospital, pkg);
    const roomOptions = buildRoomOptions(policy, hospital, bill, inNetwork, packageCode);
    if (roomOptions.length === 0) continue;

    matches.push({
      hospital,
      inNetwork,
      networkReason: reason,
      matchedPackage: pkg,
      estimatedBill: bill,
      distanceKm,
      roomOptions,
      bestCase: roomOptions[0].result.patientPays,
      worstCase: roomOptions[roomOptions.length - 1].result.patientPays,
    });
  }

  // In-network first, then by what the patient actually pays.
  //
  // Distance deliberately does not lead the sort. The nearest hospital is
  // often the most expensive one, and a caregiver who sorts by proximity can
  // lose more to a room-rent cap than they save in travel time. Distance is
  // shown on every row so it can be weighed, not ranked on by default.
  matches.sort((a, b) => {
    if (a.inNetwork !== b.inNetwork) return a.inNetwork ? -1 : 1;
    return a.bestCase - b.bestCase;
  });

  return matches.slice(0, maxResults);
}

/**
 * One-line summary per match, for the results list.
 */
export function describeMatch(match: HospitalMatch): string {
  const best = match.roomOptions[0];
  const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  const network = match.inNetwork ? match.networkReason : `⚠ ${match.networkReason}`;
  const room = best.category.replace(/_/g, " ");

  return `${match.hospital.name} — ${network}. Cheapest option: ${room} at ${rupees(best.roomRate)}/day, you pay ${rupees(best.result.patientPays)} of a ${rupees(match.estimatedBill)} bill.`;
}