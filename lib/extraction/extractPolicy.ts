/**
 * Policy extraction pipeline (Gemini).
 *
 * ingest -> Gemini call -> parse -> schema validation -> resolve caps
 *
 * On a schema failure the validation errors are fed back to the model once.
 * That single retry fixes most malformed output and costs one extra call.
 *
 * Server-side only. Requires GEMINI_API_KEY in the environment.
 */

import { ingestDocument, type IngestResult } from "./ingest";
import { SYSTEM_PROMPT, EXTRACTION_MODELS, buildInstruction } from "./prompts";
import { validatePolicy, parseModelOutput } from "../policy/validatePolicy";
import type { NormalizedPolicy } from "../policy/policy.types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_OUTPUT_TOKENS = 8192;

export interface ExtractionResult {
  ok: boolean;
  policy: NormalizedPolicy | null;
  errors: string[];
  diagnostics: {
    ingestMode: IngestResult["mode"];
    likelyScanned: boolean;
    rawTextLength: number;
    filteredTextLength: number;
    pageCount: number | null;
    attempts: number;
    /** Which model actually answered, after any fallback. */
    modelUsed?: string;
    /** Raw model text, kept for debugging when validation fails. */
    lastRawResponse?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Gemini request/response shapes                                      */
/* ------------------------------------------------------------------ */

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/**
 * Builds the parts array for whichever path ingestion chose.
 * A scanned PDF is sent as inline base64 and Gemini reads the pages itself.
 */
function buildParts(ingested: IngestResult, instruction: string): GeminiPart[] {
  if (ingested.mode === "pdf_native") {
    return [
      {
        inline_data: {
          mime_type: "application/pdf",
          data: ingested.base64 ?? "",
        },
      },
      { text: instruction },
    ];
  }

  return [
    { text: `POLICY DOCUMENT:\n\n${ingested.text ?? ""}` },
    { text: instruction },
  ];
}

function collectText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Worth waiting and trying the same model again. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Worth trying a different model instead.
 *
 * 404 means the model has been retired — Google removes older releases for
 * new API keys without warning. Retrying it is pointless; moving down the
 * chain is the whole reason the chain exists. 400 covers a model that exists
 * but rejects the request shape.
 */
const MODEL_FALLBACK_STATUS = new Set([400, 404, ...RETRYABLE_STATUS]);
const MAX_NETWORK_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps a call with exponential backoff on transient errors.
 * 503 UNAVAILABLE from Gemini means "busy right now", not "your request is
 * wrong" — retrying a few seconds later almost always succeeds.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < MAX_NETWORK_RETRIES; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status === undefined || !RETRYABLE_STATUS.has(status)) throw error;

      if (i < MAX_NETWORK_RETRIES - 1) {
        const delay = 1000 * 2 ** i + Math.floor(Math.random() * 400);
        console.warn(
          `Gemini ${status}, retrying in ${delay}ms (${i + 1}/${MAX_NETWORK_RETRIES - 1})`
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

async function callModel(
  contents: GeminiContent[],
  model: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const response = await fetch(
    `${API_BASE}/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          // Forces valid JSON out, so no code fences to strip.
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Extraction is not a creative task; keep it deterministic.
          temperature: 0,
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(
      `Gemini call failed (${response.status}): ${body.slice(0, 300)}`
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as GeminiResponse;

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Request blocked: ${data.promptFeedback.blockReason}`);
  }

  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      "Response truncated at max output tokens — raise MAX_OUTPUT_TOKENS"
    );
  }

  const text = collectText(data);
  if (!text) throw new Error("Gemini returned no text content");
  return text;
}

/**
 * Tries each model in EXTRACTION_MODELS. withRetry already handles transient
 * blips; reaching this fallback means a model is sustainably unavailable, so
 * we move to the next one rather than failing the whole run.
 */
async function callWithFallback(
  contents: GeminiContent[]
): Promise<{ text: string; model: string }> {
  let lastError: unknown;

  for (const model of EXTRACTION_MODELS) {
    try {
      const text = await withRetry(() => callModel(contents, model));
      return { text, model };
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status === undefined || !MODEL_FALLBACK_STATUS.has(status)) throw error;

      console.warn(
        `${model} unavailable (${status}) — trying the next model`
      );
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `All models failed (${EXTRACTION_MODELS.join(", ")}). Last error — ${message}`
  );
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

export async function extractPolicy(
  buffer: Buffer,
  filename: string
): Promise<ExtractionResult> {
  const ingested = await ingestDocument(buffer, filename);

  const diagnostics: ExtractionResult["diagnostics"] = {
    ingestMode: ingested.mode,
    likelyScanned: ingested.meta.likelyScanned,
    rawTextLength: ingested.meta.rawTextLength,
    filteredTextLength: ingested.meta.filteredTextLength,
    pageCount: ingested.meta.pageCount,
    attempts: 0,
  };

  const contents: GeminiContent[] = [
    { role: "user", parts: buildParts(ingested, buildInstruction()) },
  ];

  let raw = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    diagnostics.attempts = attempt;

    try {
      const call = await callWithFallback(contents);
      raw = call.text;
      diagnostics.modelUsed = call.model;
    } catch (error) {
      return {
        ok: false,
        policy: null,
        errors: [error instanceof Error ? error.message : String(error)],
        diagnostics,
      };
    }

    diagnostics.lastRawResponse = raw;

    let parsed: unknown;
    try {
      parsed = parseModelOutput(raw);
    } catch {
      if (attempt === 2) {
        return {
          ok: false,
          policy: null,
          errors: ["Model output was not valid JSON"],
          diagnostics,
        };
      }
      contents.push({ role: "model", parts: [{ text: raw }] });
      contents.push({
        role: "user",
        parts: [
          {
            text:
              "That was not valid JSON. Return only the JSON object, with no " +
              "prose and no code fences.",
          },
        ],
      });
      continue;
    }

    const result = validatePolicy(parsed);
    if (result.valid) {
      return { ok: true, policy: result.policy, errors: [], diagnostics };
    }

    if (attempt === 2) {
      return { ok: false, policy: null, errors: result.errors, diagnostics };
    }

    // Feed the validation errors back and let the model correct itself.
    contents.push({ role: "model", parts: [{ text: raw }] });
    contents.push({
      role: "user",
      parts: [
        {
          text:
            "Your JSON failed schema validation with these errors:\n" +
            result.errors.map((e) => `- ${e}`).join("\n") +
            "\n\nReturn the corrected JSON object only. Do not invent values " +
            "to satisfy the schema — use null with low confidence where the " +
            "document is silent.",
        },
      ],
    });
  }

  return {
    ok: false,
    policy: null,
    errors: ["Extraction failed after retry"],
    diagnostics,
  };
}