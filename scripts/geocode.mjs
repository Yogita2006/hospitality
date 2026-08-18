/**
 * Adds coordinates to the hospital dataset. Run once.
 *
 *   node scripts/geocode.mjs              → OpenStreetMap, free, no key
 *   node scripts/geocode.mjs --google     → Google, needs billing enabled
 *
 * Coordinates are map-agnostic: whichever provider fills them in, they work
 * with a Google map, a Leaflet map, or plain distance sorting.
 *
 * OpenStreetMap's Nominatim is free and needs no account. Its terms require
 * one request per second and a real User-Agent, both of which this respects.
 * 60 hospitals takes about a minute.
 *
 * Safe to re-run: hospitals that already have coordinates are skipped.
 */

import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "data", "hospitals_clean.json");
const ENV = path.join(process.cwd(), ".env.local");

const useGoogle = process.argv.includes("--google");

/** Re-geocode entries that only ever resolved to a pincode centre. */
const redoCoarse = process.argv.includes("--force");

/* Nominatim asks callers to identify themselves. */
const USER_AGENT = "Hospitality-PrecisionCare-Demo/1.0 (hackathon project)";

function readKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  if (!fs.existsSync(ENV)) return null;

  for (const line of fs.readFileSync(ENV, "utf-8").split("\n")) {
    const match = line.match(/^\s*(?:NEXT_PUBLIC_)?GOOGLE_MAPS_API_KEY\s*=\s*(.+)\s*$/);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocodeGoogle(query, key) {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(query)}&region=in&key=${key}`;

  const data = await (await fetch(url)).json();

  if (data.status === "OK" && data.results?.length) {
    const best = data.results[0];
    return {
      lat: best.geometry.location.lat,
      lng: best.geometry.location.lng,
      precision: best.geometry.location_type,
    };
  }
  if (data.status === "ZERO_RESULTS") return null;
  throw new Error(`${data.status}: ${data.error_message ?? "geocoding failed"}`);
}

async function geocodeNominatim(query) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(query)}&format=json&countrycodes=in&limit=1`;

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (response.status === 429) throw new Error("rate limited — slow down");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const results = await response.json();
  if (!results.length) return null;

  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    precision: results[0].type ?? "osm",
  };
}

/**
 * Nominatim does badly with long freeform addresses: plot numbers and "near
 * the metro station" landmarks push it off the building entirely. So this
 * walks from the most identifying query to the least, and stops at the first
 * hit.
 *
 * Cleaning matters as much as ordering — a name like
 * "BLK-Max Super Speciality Hospital (Dr. B.L. Kapur Memorial)" resolves
 * once the parenthetical is dropped.
 */

/** Strips parentheticals, unit-of suffixes and trailing company forms. */
function cleanName(name) {
  return name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(Unit of|Formerly|Run by|Pvt\.?|Private|Ltd\.?|Limited)\b.*/i, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/[,&]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pulls the colony or sector name out of an address: the part a local would
 * say. Skips plot numbers and "near X" landmarks, which only confuse the
 * geocoder.
 */
function locality(address) {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(
      (p) =>
        p &&
        !/^\d/.test(p) &&
        !/^(plot|block|pocket|no\.?|ground floor|first floor|opposite|near|behind)/i.test(p) &&
        !/^(new delhi|delhi)$/i.test(p)
    );

  // The last usable fragment is normally the colony, the earlier ones are
  // street-level detail.
  return parts.length ? parts[parts.length - 1] : null;
}

async function resolve(hospital, key) {
  const name = cleanName(hospital.name);
  const area = locality(hospital.location.address);
  const pin = hospital.location.pincode;

  const attempts = [
    [`${name}, Delhi, India`, null],
    area ? [`${name}, ${area}, Delhi, India`, null] : null,
    area && pin ? [`${area}, ${pin}, Delhi, India`, "locality"] : null,
    area ? [`${area}, Delhi, India`, "locality"] : null,
    pin ? [`${pin}, Delhi, India`, "area_only"] : null,
  ].filter(Boolean);

  for (const [query, precisionNote] of attempts) {
    const result = useGoogle
      ? await geocodeGoogle(query, key)
      : await geocodeNominatim(query);

    if (result) {
      return {
        ...result,
        precision: precisionNote ?? result.precision,
        query,
      };
    }
    await sleep(useGoogle ? 120 : 1100);
  }

  return null;
}

async function main() {
  const key = useGoogle ? readKey() : null;

  if (useGoogle && !key) {
    console.error("GOOGLE_MAPS_API_KEY not found in .env.local");
    process.exit(1);
  }

  console.log(
    useGoogle
      ? "Geocoding via Google (billing must be enabled)\n"
      : "Geocoding via OpenStreetMap Nominatim — free, about a minute\n"
  );

  const hospitals = JSON.parse(fs.readFileSync(DATA, "utf-8"));

  let done = 0;
  let approximate = 0;
  let skipped = 0;
  const failed = [];

  for (const hospital of hospitals) {
    const coarse =
      hospital.location.geocode_precision === "area_only" ||
      hospital.location.geocode_precision === "locality";

    if (hospital.location.lat && hospital.location.lng && !(redoCoarse && coarse)) {
      skipped++;
      continue;
    }

    try {
      const result = await resolve(hospital, key);

      if (result) {
        hospital.location.lat = result.lat;
        hospital.location.lng = result.lng;
        hospital.location.geocode_precision = result.precision;
        hospital.data_provenance.coordinates = useGoogle
          ? "google_geocoding"
          : "openstreetmap";

        if (result.precision === "area_only" || result.precision === "locality") approximate++;
        done++;

        const tag =
          result.precision === "area_only"
            ? "area "
            : result.precision === "locality"
              ? "local"
              : "exact";
        console.log(`  ${tag} ${hospital.name.slice(0, 46)}`);
      } else {
        failed.push(hospital.name);
        console.log(`  miss  ${hospital.name.slice(0, 46)}`);
      }
    } catch (error) {
      failed.push(`${hospital.name} — ${error.message}`);
      console.log(`  FAIL  ${hospital.name.slice(0, 40)} — ${error.message}`);

      // A billing or key problem will repeat for every record; stop early
      // rather than printing the same error sixty times.
      if (/REQUEST_DENIED|billing|API key/i.test(error.message)) {
        console.log("\nStopping — this affects every request, not just this one.");
        break;
      }
    }

    await sleep(useGoogle ? 120 : 1100);
  }

  fs.writeFileSync(DATA, JSON.stringify(hospitals, null, 2));

  console.log(
    `\n${done} geocoded (${approximate} at area level only), ` +
      `${skipped} already had coordinates, ${failed.length} failed`
  );

  if (approximate) {
    console.log(
      "\nArea-level points sit at the centre of the pincode, not on the building.\n" +
        "Good enough for distance sorting; note it in your writeup."
    );
  }

  if (failed.length) {
    console.log("\nFailed:");
    failed.slice(0, 12).forEach((f) => console.log(`  ${f}`));
    if (failed.length > 12) console.log(`  ...and ${failed.length - 12} more`);
  }
}

main();
