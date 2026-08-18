/**
 * POST /api/extract
 *
 * Accepts multipart/form-data with a single "file" field and returns the
 * normalized policy.
 *
 * This route is server-side, which is what keeps ANTHROPIC_API_KEY out of the
 * browser bundle. Never move this logic into a client component.
 */

import { NextRequest, NextResponse } from "next/server";
import { extractPolicy } from "@/lib/extraction/extractPolicy";

// pdf-parse needs the Node runtime; it will not run on the edge runtime.
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".pdf"];

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, errors: ["No file provided under the 'file' field"] },
        { status: 400 }
      );
    }

    const name = file.name.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      return NextResponse.json(
        { ok: false, errors: ["Only .txt and .pdf files are supported"] },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { ok: false, errors: ["File exceeds the 15 MB limit"] },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await extractPolicy(buffer, file.name);

    // The raw model response is useful in the terminal but should not travel
    // to the browser.
    if (!result.ok && result.diagnostics.lastRawResponse) {
      console.error("Extraction failed. Raw model output:");
      console.error(result.diagnostics.lastRawResponse.slice(0, 2000));
      delete result.diagnostics.lastRawResponse;
    }

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Extract route error:", error);
    return NextResponse.json(
      {
        ok: false,
        errors: [error instanceof Error ? error.message : "Unexpected error"],
      },
      { status: 500 }
    );
  }
}