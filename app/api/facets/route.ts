/**
 * GET /api/facets
 *
 * Returns the filter options that actually exist in the dataset: every
 * specialty, every procedure package, and every pincode with a hospital in it.
 *
 * Deriving these from the data rather than hard-coding them means the filters
 * can never offer something the dataset cannot answer, and never hide
 * something it can.
 */

import { NextResponse } from "next/server";
import type { Hospital } from "@/lib/hospitals/matchHospitals";
import hospitalData from "@/data/hospitals_clean.json";

export const runtime = "nodejs";

const hospitals = hospitalData as unknown as Hospital[];

const titleCase = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Reader-facing names for the package codes carried in the dataset. */
const PACKAGE_LABELS: Record<string, string> = {
  coronary_angioplasty_single_stent: "Angioplasty (single stent)",
  coronary_artery_bypass_graft: "Bypass surgery",
  total_knee_replacement: "Knee replacement",
  hip_replacement: "Hip replacement",
  laparoscopic_appendectomy: "Appendix removal",
  laparoscopic_cholecystectomy: "Gall bladder removal",
  hernia_repair: "Hernia repair",
  cesarean_section: "Caesarean delivery",
  normal_delivery: "Normal delivery",
  hemodialysis_per_session: "Dialysis (per session)",
  cataract_surgery_with_iol: "Cataract surgery",
  chemotherapy_cycle: "Chemotherapy (per cycle)",
};

/**
 * Human-readable area names, read off the addresses in the dataset itself.
 * "110075" tells a caregiver nothing; "Dwarka" tells them everything. The
 * pincode stays as the value because that is what the matcher filters on.
 */
const AREA_NAMES: Record<string, string> = {
  "110001": "Connaught Place",
  "110002": "Delhi Gate",
  "110005": "Karol Bagh & Rajendra Place",
  "110007": "Malka Ganj",
  "110009": "Mukherjee Nagar & GTB Nagar",
  "110015": "Kirti Nagar",
  "110016": "Hauz Khas",
  "110017": "Saket",
  "110021": "Chanakyapuri",
  "110023": "Kidwai Nagar & INA",
  "110024": "Lajpat Nagar",
  "110025": "Okhla & Sukhdev Vihar",
  "110026": "West Punjabi Bagh",
  "110029": "Ansari Nagar (AIIMS)",
  "110034": "Pitampura",
  "110048": "Greater Kailash I",
  "110049": "Gautam Nagar",
  "110052": "Ashok Vihar",
  "110054": "Civil Lines & Tis Hazari",
  "110057": "Vasant Vihar",
  "110058": "Janakpuri",
  "110064": "Hari Nagar",
  "110065": "East of Kailash",
  "110070": "Vasant Kunj",
  "110075": "Dwarka",
  "110076": "Sarita Vihar",
  "110077": "Dwarka Sector 7",
  "110085": "Rohini",
  "110087": "Paschim Vihar",
  "110091": "Patparganj & Mayur Vihar",
  "110095": "Dilshad Garden",
};

export interface Facets {
  specialties: Array<{ tag: string; label: string; count: number; packageCount: number }>;
  packages: Array<{ code: string; label: string; specialty: string; count: number }>;
  locations: Array<{ pincode: string; label: string; area: string; count: number }>;
}

export async function GET() {
  const specialtyCount = new Map<string, number>();
  const specialtyPackages = new Map<string, Set<string>>();
  const packageMeta = new Map<string, { specialty: string; count: number }>();
  const pincodeCount = new Map<string, number>();

  for (const hospital of hospitals) {
    for (const tag of hospital.specialties) {
      specialtyCount.set(tag, (specialtyCount.get(tag) ?? 0) + 1);
    }

    for (const pkg of hospital.procedure_packages) {
      const set = specialtyPackages.get(pkg.specialty) ?? new Set<string>();
      set.add(pkg.package_code);
      specialtyPackages.set(pkg.specialty, set);

      const existing = packageMeta.get(pkg.package_code);
      packageMeta.set(pkg.package_code, {
        specialty: pkg.specialty,
        count: (existing?.count ?? 0) + 1,
      });
    }

    const pin = hospital.location.pincode;
    if (pin) pincodeCount.set(pin, (pincodeCount.get(pin) ?? 0) + 1);
  }

  const facets: Facets = {
    // packageCount lets the picker separate departments that carry published
    // package rates from those the cost has to be estimated for.
    specialties: [...specialtyCount.entries()]
      .map(([tag, count]) => ({
        tag,
        label: titleCase(tag),
        count,
        packageCount: specialtyPackages.get(tag)?.size ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),

    packages: [...packageMeta.entries()]
      .map(([code, meta]) => ({
        code,
        label: PACKAGE_LABELS[code] ?? titleCase(code),
        specialty: meta.specialty,
        count: meta.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),

    locations: [...pincodeCount.entries()]
      .map(([pincode, count]) => ({
        pincode,
        area: AREA_NAMES[pincode] ?? pincode,
        label: `${AREA_NAMES[pincode] ?? pincode} · ${pincode}`,
        count,
      }))
      // Alphabetical by area, because that is how someone looks for their
      // own neighbourhood.
      .sort((a, b) => a.area.localeCompare(b.area)),
  };

  return NextResponse.json({ ok: true, facets });
}