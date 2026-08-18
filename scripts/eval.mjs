/**
 * Extraction eval harness.
 *
 *   node scripts/eval.mjs
 *
 * Runs every sample policy through /api/extract and diffs the result against
 * sample_policies/expected/. Start the dev server first.
 *
 * Scoring is tiered, because not every field matters equally:
 *
 *   CRITICAL  — money and structure. A miss here breaks the calculator.
 *               These decide pass/fail.
 *   SOFT      — names, labels, exclusion wording, confidence levels.
 *               Reported but never fails the run.
 *
 * Flags:
 *   --base=http://localhost:3000   override the server URL
 *   --only=pmjay                   run a single case
 *   --verbose                      print full values and soft mismatches
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const BASE = flag("base", "http://localhost:3000");
const ONLY = flag("only", null);
const VERBOSE = args.includes("--verbose");

const POLICY_DIR = path.join(process.cwd(), "sample_policies");
const EXPECTED_DIR = path.join(POLICY_DIR, "expected");

/** Never compared — these legitimately differ between runs. */
const IGNORED = [
  /^extraction_meta\.extracted_at$/,
  /^extraction_meta\.model$/,
  /^extraction_meta\.source_document$/,
  /^policy_id$/,
  /\.note$/,
  /^proportionate_deduction\.note$/,
];

/**
 * Fields that decide pass/fail. Everything else is soft.
 * These are exactly the inputs the deduction calculator and hospital matcher
 * read; a wrong value here produces a wrong rupee figure for the patient.
 */
const CRITICAL = [
  /^schema_version$/,
  /^scheme_type$/,
  /^coverage\.sum_insured$/,
  /^coverage\.sum_insured_type$/,
  /^(room_rent|icu_rent)\.(cap_type|cap_value|resolved_per_day|not_specified|eligible_category)$/,
  /^co_pay\.(percent|applies_to)$/,
  /^deductible\.amount$/,
  /^sub_limits\[\d+\]\.(category|limit_amount|basis)$/,
  /^network\.(type|insurer_key|restricted_to_network|non_network_reimbursement_percent)$/,
  /^proportionate_deduction\.(applicable|scalable_component_percent)$/,
];

/** Arrays where order carries no meaning. */
const UNORDERED = [/^proportionate_deduction\.exempt_categories$/];

const matches = (patterns, p) => patterns.some((re) => re.test(p));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const isExcerpt = (p) => p.endsWith("source_excerpt");
const isExclusion = (p) => /^exclusions\[\d+\]/.test(p);

function flatten(value, prefix = "", out = {}) {
  if (value === null || typeof value !== "object") {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    if (matches(UNORDERED, prefix)) {
      out[prefix] = [...value].map(String).sort().join("|");
      return out;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    if (value.length === 0) out[prefix] = "[]";
    return out;
  }
  for (const [key, inner] of Object.entries(value)) {
    flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * Exclusions are compared as a set, loosely. The model listing MORE
 * exclusions than we wrote down is correct behaviour, not a failure —
 * only a missing expected one counts.
 */
function compareExclusions(actual, expected) {
  const actualTexts = (actual ?? []).map((e) => norm(e.text));
  const missing = (expected ?? [])
    .map((e) => e.text)
    .filter((text) => {
      const n = norm(text);
      return !actualTexts.some((a) => a.includes(n) || n.includes(a));
    });
  return { missing, actualCount: actualTexts.length };
}

function compare(actual, expected, documentText) {
  const fa = flatten(actual);
  const fe = flatten(expected);
  const paths = new Set([...Object.keys(fa), ...Object.keys(fe)]);
  const doc = norm(documentText);

  const out = {
    critPass: 0, critFail: 0, critMismatches: [],
    softPass: 0, softFail: 0, softMismatches: [],
    hallucinated: [],
  };

  for (const p of paths) {
    if (matches(IGNORED, p)) continue;
    if (isExclusion(p)) continue; // handled separately

    const a = fa[p];
    const e = fe[p];

    if (isExcerpt(p)) {
      if (a && !doc.includes(norm(a))) {
        out.hallucinated.push({ path: p, value: a });
        out.softFail++;
      } else {
        out.softPass++;
      }
      continue;
    }

    const critical = matches(CRITICAL, p);
    let equal = a === e;

    // Soft text fields: substring either way is close enough.
    if (!equal && !critical && typeof a === "string" && typeof e === "string") {
      const na = norm(a), ne = norm(e);
      equal = na.includes(ne) || ne.includes(na);
    }

    if (equal) {
      critical ? out.critPass++ : out.softPass++;
    } else if (critical) {
      out.critFail++;
      out.critMismatches.push({ path: p, expected: e, actual: a });
    } else {
      out.softFail++;
      out.softMismatches.push({ path: p, expected: e, actual: a });
    }
  }

  const excl = compareExclusions(actual.exclusions, expected.exclusions);
  out.exclusions = excl;
  if (excl.missing.length) {
    out.softFail += excl.missing.length;
  } else {
    out.softPass++;
  }

  return out;
}

async function runCase(name) {
  const txtPath = path.join(POLICY_DIR, `${name}.txt`);
  const expPath = path.join(EXPECTED_DIR, `${name}.json`);

  const documentText = fs.readFileSync(txtPath, "utf-8");
  const expected = JSON.parse(fs.readFileSync(expPath, "utf-8"));

  const form = new FormData();
  form.append("file", new Blob([documentText], { type: "text/plain" }), `${name}.txt`);

  const started = Date.now();
  const response = await fetch(`${BASE}/api/extract`, { method: "POST", body: form });
  const payload = await response.json();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n━━━ ${name} ━━━ (${elapsed}s, ${payload?.diagnostics?.attempts ?? "?"} attempt(s))`);

  if (!payload.ok) {
    console.log("  EXTRACTION FAILED");
    (payload.errors ?? []).forEach((e) => console.log(`    ${String(e).slice(0, 200)}`));
    return { name, critFail: 1, critPass: 0, softPass: 0, softFail: 0, failed: true };
  }

  const r = compare(payload.policy, expected, documentText);
  const critTotal = r.critPass + r.critFail;
  const softTotal = r.softPass + r.softFail;

  const verdict = r.critFail === 0 ? "PASS" : "FAIL";
  console.log(`  ${verdict}  critical ${r.critPass}/${critTotal}   soft ${r.softPass}/${softTotal}`);
  console.log(`  exclusions: ${r.exclusions.actualCount} found, ${r.exclusions.missing.length} expected ones missing`);

  if (r.hallucinated.length) {
    console.log("  HALLUCINATED EXCERPTS — quoted text not in document:");
    r.hallucinated.forEach((h) =>
      console.log(`    ${h.path}\n      "${String(h.value).slice(0, 90)}"`)
    );
  }

  if (r.critMismatches.length) {
    console.log("  CRITICAL MISMATCHES:");
    for (const m of r.critMismatches) {
      console.log(`    ${m.path}`);
      console.log(`      expected: ${JSON.stringify(m.expected)}`);
      console.log(`      actual:   ${JSON.stringify(m.actual)}`);
    }
  }

  if (VERBOSE && r.softMismatches.length) {
    console.log("  soft mismatches:");
    for (const m of r.softMismatches) {
      console.log(`    ${m.path}: ${String(m.expected).slice(0, 40)} -> ${String(m.actual).slice(0, 40)}`);
    }
  }

  if (VERBOSE && r.exclusions.missing.length) {
    console.log("  missing exclusions:");
    r.exclusions.missing.forEach((t) => console.log(`    ${t}`));
  }

  return { name, ...r };
}

async function main() {
  const cases = fs
    .readdirSync(EXPECTED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((n) => !ONLY || n === ONLY);

  if (!cases.length) {
    console.error("No cases found in sample_policies/expected/");
    process.exit(1);
  }

  console.log(`Running ${cases.length} case(s) against ${BASE}`);

  const results = [];
  for (const name of cases) {
    try {
      results.push(await runCase(name));
    } catch (error) {
      console.log(`\n━━━ ${name} ━━━`);
      console.log(`  ERROR: ${error.message}`);
      results.push({ name, critFail: 1, critPass: 0, softPass: 0, softFail: 0, failed: true });
    }
  }

  const critPass = results.reduce((s, r) => s + r.critPass, 0);
  const critFail = results.reduce((s, r) => s + r.critFail, 0);
  const softPass = results.reduce((s, r) => s + r.softPass, 0);
  const softFail = results.reduce((s, r) => s + r.softFail, 0);

  console.log(`\n${"═".repeat(52)}`);
  console.log(`CRITICAL: ${critPass} passed, ${critFail} failed`);
  console.log(`SOFT:     ${softPass} passed, ${softFail} failed  (informational)`);
  results.forEach((r) => {
    const status = r.failed
      ? "ERROR"
      : r.critFail === 0
        ? `PASS (${r.critPass} critical)`
        : `FAIL (${r.critFail} critical)`;
    console.log(`  ${r.name.padEnd(24)} ${status}`);
  });

  process.exit(critFail > 0 ? 1 : 0);
}

main();
