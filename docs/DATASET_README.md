# Hospital Dataset — Schema Reference

**60 hospitals, Delhi NCR** (including a 6-hospital Dwarka 110075 cluster). Generated from `hospitals_source_merged.json` by `build_dataset.py`.

Rerun anytime: `python3 build_dataset.py hospitals_source_merged.json hospitals_clean.json`

---

## What changed from the source file

| Issue | Fix |
|---|---|
| `hosp_iph_15` appeared twice | Deduplicated |
| 2 closed hospitals (Zed Hospital, Sunder Lal Jain) | Removed |
| 582 free-text specialty strings | Normalized to 36 canonical tags |
| `0` meant both "free" and "unknown" | Separated: `0` = genuinely free, `null` = no data |
| No ICU / deluxe rates | Added, with ICU always ≥ private rate |
| No network/empanelment data | Added `empanelment` block |
| No procedure costs | Added `procedure_packages` (475 total) |
| `location` was one unparsed string | Split into address / city / state / pincode |
| `diet_charges_per_day` was 0 for all 57 | Nulled out |

---

## Record shape

```jsonc
{
  "id": "hosp_spinal_42",
  "name": "Indian Spinal Injuries Centre (ISIC)",
  "hospital_type": "private",              // government | private | trust

  "location": {
    "address": "Sector C, Vasant Kunj",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110070"                    // null if unknown
  },

  "specialties": ["orthopedics", "neurosurgery", ...],  // canonical — filter on this
  "specialties_raw": [...],                             // original strings — display only

  "room_tariff": {                         // ₹ per day; null = no data
    "general_ward": 4500,
    "semi_private": 7500,
    "private": 12500,
    "deluxe": 19375,
    "icu": 22500
  },
  "tariff_confidence": "published",        // published | partially_estimated | estimated

  "charges": { "opd_registration": 1200, "diet_per_day": null },

  "empanelment": {
    "pmjay": true,
    "cghs": true,
    "esi": false,
    "insurer_network": ["star_health", "hdfc_ergo", ...],
    "cashless_available": true
  },

  "accreditation": { "nabh": false },

  "procedure_packages": [
    {
      "package_code": "total_knee_replacement",
      "specialty": "orthopedics",
      "estimated_total": 153500,           // ₹, full package
      "typical_length_of_stay_days": 5
    }
  ],

  "data_provenance": { ... }               // per-field origin — see below
}
```

---

## ⚠️ Data provenance — read this before the demo

Every record carries a `data_provenance` block marking each field's origin.
Use it in your writeup; judges give 20% to "enterprise in understanding
problem, sourcing data."

- **Real (from your public sourcing):** name, location, specialties, and room
  tariffs for 54 of 60 hospitals.
- **Synthetic:** `empanelment`, `accreditation`, `procedure_packages`, and
  imputed room rates for 6 hospitals (all pre-existing records).

Empanelment is generated deterministically (seeded on hospital ID), so it is
stable across runs and reproducible — but it is **not** real network data.
Say so plainly in your submission. The problem statement explicitly permits
synthetic and simulated data; claiming it is real is the only way this hurts you.

If you want to upgrade one thing later, upgrade PM-JAY empanelment — the
official hospital list is public and swapping real flags in would be a strong
"enterprise" signal.

---

## Canonical specialty tags (36)

`anesthesiology`, `cardiology`, `cardiothoracic_surgery`, `critical_care`,
`dentistry`, `dermatology`, `emergency_medicine`, `endocrinology`, `ent`,
`gastroenterology`, `general_medicine`, `general_surgery`, `geriatrics`,
`hematology`, `infectious_disease`, `nephrology`, `neurology`, `neurosurgery`,
`nuclear_medicine`, `nutrition`, `obstetrics_gynecology`, `oncology`,
`ophthalmology`, `orthopedics`, `pathology`, `pediatrics`, `pharmacy`,
`physiotherapy`, `plastic_surgery`, `preventive_health`, `psychiatry`,
`pulmonology`, `radiology`, `rheumatology`, `transfusion`, `urology`

---

## Package codes (12)

`coronary_angioplasty_single_stent`, `coronary_artery_bypass_graft`,
`total_knee_replacement`, `hip_replacement`, `laparoscopic_appendectomy`,
`laparoscopic_cholecystectomy`, `hernia_repair`, `cesarean_section`,
`normal_delivery`, `hemodialysis_per_session`, `cataract_surgery_with_iol`,
`chemotherapy_cycle`

Packages only appear on hospitals that have the matching specialty. Government
rates are ~45% of private, trust ~80%.

---

## Proportionate deduction — the formula your calculator needs

This is why `procedure_packages` and `room_tariff` both exist. When the chosen
room rate exceeds the policy's room rent cap, Indian insurers scale down
*most* of the bill, not just the room charge:

```
ratio = policy_room_cap / actual_room_rate      // e.g. 5000 / 12500 = 0.40
```

Apply `ratio` to associated charges — surgeon fees, OT, ICU, anesthesia,
nursing. Do **not** apply it to consumables, medicines, implants, or
diagnostics; those reimburse at actuals.

A workable split for the demo: treat 70% of `estimated_total` as
ratio-scalable and 30% as reimbursed at actuals. State the assumption in
your UI — a visible, defensible assumption reads better than a hidden one.
