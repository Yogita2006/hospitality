/**
 * POST /api/match
 *
 * Takes an extracted policy plus filters, returns ranked hospital matches.
 *
 * The dataset stays server-side: it is 230 KB and the browser has no reason
 * to hold all 60 hospitals to display a filtered list of them.
 */

import { NextRequest, NextResponse } from "next/server";
import { matchHospitals, type Hospital } from "@/lib/hospitals/matchHospitals";
import type { NormalizedPolicy } from "@/lib/policy/policy.types";
import hospitalData from "@/data/hospitals_clean.json";

export const runtime = "nodejs";

const hospitals = hospitalData as unknown as Hospital[];

interface MatchBody {
  policy: NormalizedPolicy;
  specialty?: string;
  packageCode?: string;
  pincodes?: string[];
  origin?: { lat: number; lng: number };
  radiusKm?: number;
  networkOnly?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as MatchBody;

    if (!body?.policy?.schema_version) {
      return NextResponse.json(
        { ok: false, errors: ["A normalized policy is required"] },
        { status: 400 }
      );
    }

    const matches = matchHospitals(hospitals, {
      policy: body.policy,
      specialty: body.specialty || undefined,
      packageCode: body.packageCode || undefined,
      pincodes: body.pincodes?.length ? body.pincodes : undefined,
      origin: body.origin,
      radiusKm: body.radiusKm,
      networkOnly: Boolean(body.networkOnly),
      maxResults: 12,
    });

    return NextResponse.json({ ok: true, matches, totalScanned: hospitals.length });
  } catch (error) {
    console.error("Match route error:", error);
    return NextResponse.json(
      { ok: false, errors: [error instanceof Error ? error.message : "Unexpected error"] },
      { status: 500 }
    );
  }
}