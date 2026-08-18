/**
 * Document ingestion for policy uploads.
 *
 *   npm install pdf-parse
 *
 * Three paths, decided automatically:
 *
 *   .txt          -> read as text
 *   digital PDF   -> pdf-parse extracts embedded text
 *   scanned PDF   -> no usable text found, so the raw PDF goes to the
 *                    model as base64 and the model reads the pages itself
 *
 * Server-side only. pdf-parse uses Node APIs and will not run in the browser.
 */

/** How the document should be handed to the model. */
export type IngestMode = "text" | "pdf_native";

export interface IngestResult {
  mode: IngestMode;
  /** Present when mode is "text". Already prefiltered. */
  text?: string;
  /** Present when mode is "pdf_native". Raw PDF bytes, base64 encoded. */
  base64?: string;
  meta: {
    filename: string;
    /** Characters of text recovered before prefiltering. 0 for scanned PDFs. */
    rawTextLength: number;
    pageCount: number | null;
    /** Set when we fell back to pdf_native because text extraction was thin. */
    likelyScanned: boolean;
    /** Characters after prefiltering. Equal to rawTextLength if unfiltered. */
    filteredTextLength: number;
  };
}

/**
 * Below this many characters per page, a PDF is almost certainly scanned.
 * A real policy page carries 1500-3000 characters; a scanned page yields
 * only stray artifacts from the PDF structure.
 */
const CHARS_PER_PAGE_THRESHOLD = 200;

/** Skip prefiltering below this size — short documents lose nothing by going whole. */
const PREFILTER_MIN_CHARS = 20000;

/**
 * Terms that mark a paragraph as carrying an extractable value.
 * Tuned against the fields in policy.schema.json.
 */
const SIGNAL_TERMS = [
  "room rent", "room charges", "room category", "boarding", "nursing",
  "icu", "intensive care",
  "sum insured", "sum assured", "limit of indemnity",
  "co-payment", "copayment", "co pay",
  "deductible",
  "proportionate", "proportionality",
  "sub-limit", "sublimit", "sub limit",
  "waiting period", "pre-existing", "pre existing",
  "exclusion", "not covered", "shall not be liable",
  "network", "cashless", "empanel", "reimbursement",
  "policy period", "policy schedule", "certificate of insurance",
  "maternity", "cataract", "ambulance",
];

/**
 * Sections that are pure boilerplate in every Indian policy and never
 * contain a value we extract. Dropping them is what makes the filter worth it.
 */
const NOISE_TERMS = [
  "grievance redressal", "ombudsman", "arbitration",
  "irdai registration", "cin no", "corporate identity number",
  "free look period", "portability",
  "nomination", "assignment of policy",
  "definitions of standard", "preamble",
];

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Keeps paragraphs that carry a signal term, plus one paragraph either side
 * for context — caps are often stated one line away from their heading.
 *
 * Always keeps the first 3 paragraphs: that is the Policy Schedule, where
 * this policy's actual numbers live.
 */
export function prefilterPolicyText(text: string): string {
  if (text.length < PREFILTER_MIN_CHARS) return text;

  const paras = splitParagraphs(text);
  const keep = new Set<number>();

  // The schedule sits at the top and always matters.
  for (let i = 0; i < Math.min(3, paras.length); i++) keep.add(i);

  paras.forEach((para, i) => {
    const lower = para.toLowerCase();

    if (NOISE_TERMS.some((t) => lower.includes(t))) return;

    if (SIGNAL_TERMS.some((t) => lower.includes(t))) {
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i < paras.length - 1) keep.add(i + 1);
    }
  });

  const ordered = Array.from(keep).sort((a, b) => a - b);

  // Mark gaps so the model knows text was removed rather than assuming
  // two unrelated clauses are adjacent.
  const chunks: string[] = [];
  let previous = -1;
  for (const i of ordered) {
    if (previous !== -1 && i > previous + 1) chunks.push("[... omitted ...]");
    chunks.push(paras[i]);
    previous = i;
  }

  return chunks.join("\n\n");
}

/** Reads a PDF's embedded text. Returns null if the library cannot parse it. */
async function extractPdfText(
  buffer: Buffer
): Promise<{ text: string; pages: number } | null> {
  try {
    // Imported lazily so the browser bundle never pulls it in.
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return { text: parsed.text ?? "", pages: parsed.numpages ?? 1 };
  } catch {
    return null;
  }
}

/**
 * Main entry point. Give it the uploaded bytes and filename; it decides
 * which of the three paths applies and returns something the extraction
 * call can use directly.
 */
export async function ingestDocument(
  buffer: Buffer,
  filename: string
): Promise<IngestResult> {
  const isPdf = filename.toLowerCase().endsWith(".pdf");

  // --- Path 1: plain text ---
  if (!isPdf) {
    const raw = buffer.toString("utf-8");
    const filtered = prefilterPolicyText(raw);
    return {
      mode: "text",
      text: filtered,
      meta: {
        filename,
        rawTextLength: raw.length,
        pageCount: null,
        likelyScanned: false,
        filteredTextLength: filtered.length,
      },
    };
  }

  const parsed = await extractPdfText(buffer);
  const pages = parsed?.pages ?? 1;
  const raw = parsed?.text ?? "";
  const density = raw.length / Math.max(pages, 1);

  // --- Path 3: scanned PDF, hand the file to the model whole ---
  if (density < CHARS_PER_PAGE_THRESHOLD) {
    return {
      mode: "pdf_native",
      base64: buffer.toString("base64"),
      meta: {
        filename,
        rawTextLength: raw.length,
        pageCount: parsed?.pages ?? null,
        likelyScanned: true,
        filteredTextLength: 0,
      },
    };
  }

  // --- Path 2: digital PDF ---
  const filtered = prefilterPolicyText(raw);
  return {
    mode: "text",
    text: filtered,
    meta: {
      filename,
      rawTextLength: raw.length,
      pageCount: pages,
      likelyScanned: false,
      filteredTextLength: filtered.length,
    },
  };
}

/**
 * Builds the user-message content array for the Anthropic Messages API,
 * shaped correctly for whichever path ingestion chose.
 */
export function buildMessageContent(
  ingested: IngestResult,
  instruction: string
): unknown[] {
  if (ingested.mode === "pdf_native") {
    return [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: ingested.base64,
        },
      },
      { type: "text", text: instruction },
    ];
  }

  return [
    { type: "text", text: `POLICY DOCUMENT:\n\n${ingested.text}` },
    { type: "text", text: instruction },
  ];
}