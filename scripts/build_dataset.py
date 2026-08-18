"""
Cleans and enriches the Delhi hospital dataset for the Hospitality
insurance-navigation platform.

Run:  python3 build_dataset.py <input.json> <output.json>
"""

import json
import re
import sys
import hashlib

# --------------------------------------------------------------------------
# Canonical specialty taxonomy.
# Rules are evaluated in order; the first pattern that hits a raw string
# assigns that canonical tag. A raw string may map to more than one tag.
# --------------------------------------------------------------------------

SPECIALTY_RULES = [
    ("cardiology",        r"cardio|cardiac|cath lab|heart|coronary|electrophysiolog|pacing"),
    ("cardiothoracic_surgery", r"ctvs|cardiothoracic|cardio-thoracic|cardiovascular and thoracic|bypass|valve operation"),
    ("oncology",          r"oncolog|cancer|tumour|tumor|chemotherap|leukemia|lymphoma"),
    ("hematology",        r"hematolog|haematolog|bone marrow|blood profile"),
    ("transfusion",       r"blood bank|transfusion"),
    ("neurology",         r"neurolog|neuro-imaging|stroke|epilep"),
    ("neurosurgery",      r"neurosurg|neuro surgery|neuro-icu|spine surgery|spinal"),
    ("orthopedics",       r"orthop|joint replacement|bone and joint|arthroscop|fracture|trauma & orthop|trauma and orthop"),
    ("nephrology",        r"nephrolog|dialysis|renal|kidney"),
    ("urology",           r"urolog|endourolog|prostat"),
    ("gastroenterology",  r"gastroenterolog|hepatolog|liver|g\.i\.|gi surgery|endoscop"),
    ("pulmonology",       r"pulmonolog|respirator|chest disease|asthma|pft|tb testing|tubercul|sleep medicine"),
    ("endocrinology",     r"endocrinolog|diabet|metabolism|thyroid"),
    ("rheumatology",      r"rheumatolog|immunolog|allerg"),
    ("dermatology",       r"dermatolog|venereolog|cosmetolog|leprosy|aesthetic"),
    ("ophthalmology",     r"ophthalmolog|eye|retina|cataract|vision"),
    ("ent",               r"otolaryngolog|\bent\b|head & neck|head and neck|audiolog|speech patholog"),
    ("obstetrics_gynecology", r"obstetric|gynec|gynaec|maternity|labor room|labour room|fertility|ivf|reproductive"),
    ("pediatrics",        r"p(a)?ediatric|neonat|nicu|picu|child and adolescent|children with special needs"),
    ("general_surgery",   r"general surgery|laparoscop|surgical disciplines|hernia|appendix|gall bladder|bariatric"),
    ("general_medicine",  r"general medicine|internal medicine|internal therapeutic|family medicine|physician"),
    ("psychiatry",        r"psychiatr|psycholog|mental health|de-addiction|substance abuse|depression|anxiety|mood disorder|counseling|counselling"),
    ("plastic_surgery",   r"plastic|reconstructive|burns|maxillofacial|cosmetic"),
    ("dentistry",         r"dental|dentistr|prosthodont|oral health|oral surgery|oral implantolog"),
    ("critical_care",     r"critical care|\bicu\b|\bccu\b|intensive care|ventilator"),
    ("emergency_medicine", r"emergency|casualty|resuscitation|trauma cent|trauma care|accident|ambulance"),
    ("anesthesiology",    r"an(a)?esthes|pain management|pain medicine"),
    ("radiology",         r"radiolog|radio-diagnosis|imaging|\bmri\b|\bct\b|x-ray|ultrasound|doppler|sonograph"),
    ("nuclear_medicine",  r"nuclear medicine|pet-ct|pet-mri|pet scan"),
    ("pathology",         r"patholog|laborator|lab medicine|lab diagnostic|biochemistr|microbiolog|diagnostics lab"),
    ("physiotherapy",     r"physiotherap|rehabilitat|occupational therapy"),
    ("nutrition",         r"dietetic|nutrition"),
    ("infectious_disease", r"hiv|art cent|antiretroviral|cd4|infectious"),
    ("geriatrics",        r"geriatric"),
    ("preventive_health", r"preventive|health check|screening|immunization|vaccinat|community medicine|immigration medical"),
    ("pharmacy",          r"pharmac"),
]

COMPILED = [(tag, re.compile(pat, re.I)) for tag, pat in SPECIALTY_RULES]

# Raw strings that describe facilities/admin, not clinical specialties.
NON_CLINICAL = re.compile(
    r"college of nursing|hospital administration|biostatistic|biophysic|anatomy|"
    r"physiology|forensic|elisa testing coordination|retail pharmacy",
    re.I,
)


def normalize_specialties(raw_list):
    """Map verbose free-text specialty strings onto the canonical taxonomy."""
    tags = set()
    for raw in raw_list:
        if NON_CLINICAL.search(raw):
            continue
        for tag, pattern in COMPILED:
            if pattern.search(raw):
                tags.add(tag)
    return sorted(tags)


# --------------------------------------------------------------------------
# Government / trust hospital identification.
# These are publicly funded Delhi facilities where ward care is free or
# nominally priced, so a room rate of 0 is a real value and not missing data.
# --------------------------------------------------------------------------

GOVT_MARKERS = re.compile(
    r"\baiims\b|all india institute|safdarjung|ram manohar lohia|\brml\b|lok nayak|"
    r"\blnjp\b|deen dayal upadhyay|\bddu\b|guru teg bahadur|\bgtb\b|hindu rao|"
    r"lady hardinge|kalawati|sucheta kriplani|maulana azad|\bmamc\b|\bucms\b|"
    r"national institute|government|govt|municipal|delhi state|central government|"
    r"integrated counseling|\bictc\b|chacha nehru|institute of human behaviour|"
    r"\bihbas\b|rajiv gandhi super|baba saheb ambedkar|sanjay gandhi memorial|"
    r"acharya shree bhikshu|aruna asaf ali|bhagwan mahavir|dr\. hedgewar|"
    r"jag pravesh chandra|maharishi valmiki|pt\. madan mohan malaviya|"
    r"satyawadi raja harish chandra|shri dada dev",
    re.I,
)

TRUST_MARKERS = re.compile(
    r"\btrust\b|charitable|mission|seva|society|sir ganga ram|holy family|maharaja agrasen|"
    r"st\. stephen|st stephen|moolchand|deepak memorial",
    re.I,
)

DEFUNCT_MARKERS = re.compile(r"strike off|struck off|closed|defunct|non-operational", re.I)


def classify_hospital(name):
    if GOVT_MARKERS.search(name):
        return "government"
    if TRUST_MARKERS.search(name):
        return "trust"
    return "private"


# --------------------------------------------------------------------------
# Deterministic pseudo-random helper.
# Synthetic fields must be stable across runs so the demo never changes
# under the judges' feet. Everything is seeded off the hospital id.
# --------------------------------------------------------------------------

def seeded_value(hosp_id, salt, modulo):
    digest = hashlib.md5(f"{hosp_id}:{salt}".encode()).hexdigest()
    return int(digest[:8], 16) % modulo


# --------------------------------------------------------------------------
# Location parsing
# --------------------------------------------------------------------------

PINCODE = re.compile(r"\b(1\d{5})\b")

# A few source addresses omit the pincode; fill only where it is well known.
PINCODE_FALLBACK = {
    "hosp_aiims_01": "110029",
}


def parse_location(raw, hosp_id=None):
    pin = PINCODE.search(raw)
    pincode = pin.group(1) if pin else PINCODE_FALLBACK.get(hosp_id)
    # Strip the trailing "Delhi - 110001" fragment to leave the street address.
    address = re.sub(r",?\s*(New\s+)?Delhi\s*[-–]?\s*1?\d{0,5}\s*$", "", raw).strip(" ,")
    return {
        "address": address or raw,
        "city": "New Delhi",
        "state": "Delhi",
        "pincode": pincode,
    }


# --------------------------------------------------------------------------
# Room tariff repair and extension
# --------------------------------------------------------------------------

def build_room_tariff(hosp_id, hospital_type, rooms):
    ward = rooms.get("general_ward", 0)
    semi = rooms.get("semi_private", 0)
    priv = rooms.get("private", 0)

    if hospital_type == "government":
        # Zero is a genuine rate here: subsidised public wards, not missing data.
        substituted = (semi == 0) or (priv == 0)
        ward = ward if ward else 0
        semi = semi if semi else 500
        priv = priv if priv else 1500
        icu = max(1000 + seeded_value(hosp_id, "icu_govt", 8) * 250, int(priv * 1.2))
        deluxe = None
        confidence = "partially_estimated" if substituted else "published"
    else:
        missing = (ward == 0 and semi == 0 and priv == 0)
        if missing:
            # No published tariff. Impute from the private-hospital median band
            # and mark the record so the UI can show it as an estimate.
            base = 2500 + seeded_value(hosp_id, "base", 12) * 250
            ward = base
            semi = int(base * 1.6)
            priv = int(base * 2.4)
            confidence = "estimated"
        else:
            ward = ward or None
            semi = semi or None
            priv = priv or None
            confidence = "published"

        anchor = priv or semi or ward or 5000
        icu = int(anchor * 1.8)
        deluxe = int(anchor * 1.55)

    tariff = {
        "general_ward": ward,
        "semi_private": semi,
        "private": priv,
        "deluxe": deluxe,
        "icu": icu,
    }
    return tariff, confidence


# --------------------------------------------------------------------------
# Empanelment (SYNTHETIC)
# --------------------------------------------------------------------------

PRIVATE_INSURERS = [
    "star_health", "hdfc_ergo", "icici_lombard", "niva_bupa",
    "care_health", "bajaj_allianz", "new_india_assurance", "tata_aig",
]


def build_empanelment(hosp_id, hospital_type, spec_count, private_rate):
    if hospital_type == "government":
        pmjay = True
        cghs = True
        esi = seeded_value(hosp_id, "esi", 10) < 7
        insurers = []
    elif hospital_type == "trust":
        pmjay = seeded_value(hosp_id, "pmjay", 10) < 6
        cghs = True
        esi = seeded_value(hosp_id, "esi", 10) < 5
        insurers = PRIVATE_INSURERS[: 4 + seeded_value(hosp_id, "ins", 4)]
    else:
        # Larger/pricier private hospitals are likelier to be widely empanelled.
        scale = (spec_count >= 10) + ((private_rate or 0) >= 6000)
        pmjay = seeded_value(hosp_id, "pmjay", 10) < (2 + scale * 2)
        cghs = seeded_value(hosp_id, "cghs", 10) < (4 + scale * 2)
        esi = seeded_value(hosp_id, "esi", 10) < (3 + scale)
        count = 2 + seeded_value(hosp_id, "ins", 6)
        offset = seeded_value(hosp_id, "off", len(PRIVATE_INSURERS))
        rotated = PRIVATE_INSURERS[offset:] + PRIVATE_INSURERS[:offset]
        insurers = sorted(rotated[:count])

    return {
        "pmjay": pmjay,
        "cghs": cghs,
        "esi": esi,
        "insurer_network": insurers,
        "cashless_available": bool(insurers) or pmjay,
    }


# --------------------------------------------------------------------------
# Procedure packages (SYNTHETIC, anchored on PM-JAY / CGHS style banding)
# --------------------------------------------------------------------------

BASE_PACKAGES = [
    ("coronary_angioplasty_single_stent", "cardiology",            90000, 3),
    ("coronary_artery_bypass_graft",      "cardiothoracic_surgery", 210000, 8),
    ("total_knee_replacement",            "orthopedics",            160000, 5),
    ("hip_replacement",                   "orthopedics",            150000, 5),
    ("laparoscopic_appendectomy",         "general_surgery",         35000, 2),
    ("laparoscopic_cholecystectomy",      "general_surgery",         42000, 2),
    ("hernia_repair",                     "general_surgery",         33000, 2),
    ("cesarean_section",                  "obstetrics_gynecology",   38000, 3),
    ("normal_delivery",                   "obstetrics_gynecology",   22000, 2),
    ("hemodialysis_per_session",          "nephrology",               2500, 0),
    ("cataract_surgery_with_iol",         "ophthalmology",           28000, 1),
    ("chemotherapy_cycle",                "oncology",                45000, 1),
]

TYPE_MULTIPLIER = {"government": 0.45, "trust": 0.8, "private": 1.0}


def build_packages(hosp_id, hospital_type, spec_tags):
    multiplier = TYPE_MULTIPLIER[hospital_type]
    jitter = 0.88 + (seeded_value(hosp_id, "jit", 25) / 100.0)  # 0.88 - 1.12
    out = []
    for code, required_spec, base_cost, los in BASE_PACKAGES:
        if required_spec not in spec_tags:
            continue
        estimate = int(round(base_cost * multiplier * jitter / 500.0)) * 500
        out.append({
            "package_code": code,
            "specialty": required_spec,
            "estimated_total": estimate,
            "typical_length_of_stay_days": los,
        })
    return out


# --------------------------------------------------------------------------
# Main transform
# --------------------------------------------------------------------------

def transform(records):
    cleaned = []
    seen_ids = set()
    report = {
        "input_records": len(records),
        "duplicates_removed": [],
        "defunct_removed": [],
        "tariff_estimated": [],
    }

    for entry in records:
        hosp_id = entry["id"]
        name = entry["name"]

        if hosp_id in seen_ids:
            report["duplicates_removed"].append(hosp_id)
            continue
        seen_ids.add(hosp_id)

        if DEFUNCT_MARKERS.search(name):
            report["defunct_removed"].append(name)
            continue

        hospital_type = classify_hospital(name)
        spec_tags = normalize_specialties(entry["specialties"])
        tariff, confidence = build_room_tariff(hosp_id, hospital_type, entry["room_types"])
        if confidence in ("estimated", "partially_estimated"):
            report["tariff_estimated"].append(hosp_id)

        clean_name = re.sub(r"\s*\(Company Status:.*?\)", "", name).strip()

        record = {
            "id": hosp_id,
            "name": clean_name,
            "hospital_type": hospital_type,
            "location": parse_location(entry["location"], hosp_id),
            "specialties": spec_tags,
            "specialties_raw": entry["specialties"],
            "room_tariff": tariff,
            "tariff_confidence": confidence,
            "charges": {
                "opd_registration": entry["key_charges"].get("opd_registration"),
                "diet_per_day": entry["key_charges"].get("diet_charges_per_day") or None,
            },
            "empanelment": build_empanelment(
                hosp_id, hospital_type, len(spec_tags), tariff.get("private")
            ),
            "accreditation": {
                "nabh": (
                    hospital_type == "private"
                    and len(spec_tags) >= 8
                    and seeded_value(hosp_id, "nabh", 10) < 6
                ),
            },
            "data_provenance": {
                "name_location_specialties": "public_sources",
                "room_tariff": {
                    "published": "public_sources",
                    "partially_estimated": "mixed",
                    "estimated": "synthetic_estimate",
                }[confidence],
                "empanelment": "synthetic",
                "packages": "synthetic",
                "accreditation": "synthetic",
            },
        }

        record["procedure_packages"] = build_packages(hosp_id, hospital_type, spec_tags)
        cleaned.append(record)

    report["output_records"] = len(cleaned)
    return cleaned, report


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "hospitals.json"
    dst = sys.argv[2] if len(sys.argv) > 2 else "hospitals_clean.json"

    with open(src) as fh:
        records = json.load(fh)

    cleaned, report = transform(records)

    with open(dst, "w") as fh:
        json.dump(cleaned, fh, indent=2, ensure_ascii=False)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()