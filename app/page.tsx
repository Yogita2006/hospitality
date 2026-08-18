"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { NormalizedPolicy } from "@/lib/policy/policy.types";
import type { HospitalMatch } from "@/lib/hospitals/matchHospitals";
import { EMPTY_FACETS, type Facets } from "@/lib/format";
import PolicySummary from "@/components/PolicySummary";
import HospitalCard from "@/components/HospitalCard";
import WorkedExample from "@/components/WorkedExample";
import Disclaimer from "@/components/Disclaimer";
import ThemeToggle from "@/components/ThemeToggle";
import HospitalMap from "@/components/HospitalMap";

type Phase = "idle" | "reading" | "ready" | "error";

const STAGES = [
  { label: "Policy intake" },
  { label: "Coverage extracted" },
  { label: "Hospital match" },
  { label: "Room comparison" },
];

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [policy, setPolicy] = useState<NormalizedPolicy | null>(null);
  const [matches, setMatches] = useState<HospitalMatch[]>([]);
  const [error, setError] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [matching, setMatching] = useState(false);

  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [specialty, setSpecialty] = useState("orthopedics");
  const [procedure, setProcedure] = useState("total_knee_replacement");
  const [pincode, setPincode] = useState("");
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(10);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [networkOnly, setNetworkOnly] = useState(false);

  // Filter options come from the dataset, so they can never offer something
  // the data cannot answer.
  useEffect(() => {
    fetch("/api/facets")
      .then((r) => r.json())
      .then((d) => { if (d.ok) setFacets(d.facets); })
      .catch(() => setFacets(EMPTY_FACETS));
  }, []);

  const fileInput = useRef<HTMLInputElement>(null);

  const stageIndex = phase === "ready" ? (matches.length ? 3 : 2) : phase === "reading" ? 1 : 0;

  const runMatch = useCallback(
    async (
      forPolicy: NormalizedPolicy,
      spec: string,
      code: string,
      pin: string,
      netOnly: boolean,
      originPoint: { lat: number; lng: number } | null,
      radius: number
    ) => {
      setMatching(true);
      try {
        const response = await fetch("/api/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            policy: forPolicy,
            specialty: spec || undefined,
            packageCode: code || undefined,
            pincodes: pin ? [pin] : undefined,
            origin: originPoint ?? undefined,
            radiusKm: originPoint ? radius : undefined,
            networkOnly: netOnly,
          }),
        });
        const data = await response.json();
        setMatches(data.ok ? data.matches : []);
      } catch {
        setMatches([]);
      } finally {
        setMatching(false);
      }
    },
    []
  );

  const handleFile = useCallback(
    async (file: File) => {
      setPhase("reading");
      setError([]);
      setMatches([]);

      const form = new FormData();
      form.append("file", file);

      try {
        const response = await fetch("/api/extract", { method: "POST", body: form });
        const data = await response.json();

        if (!data.ok) {
          setError(data.errors ?? ["The policy could not be read."]);
          setPhase("error");
          return;
        }

        setPolicy(data.policy);
        setPhase("ready");
        await runMatch(data.policy, specialty, procedure, pincode, networkOnly, origin, radiusKm);
      } catch {
        setError(["Could not reach the server. Is the app still running?"]);
        setPhase("error");
      }
    },
    [specialty, procedure, pincode, networkOnly, origin, radiusKm, runMatch]
  );

  const loadSample = useCallback(
    async (name: string) => {
      setPhase("reading");
      try {
        const text = await fetch(`/samples/${name}.txt`).then((r) => r.text());
        await handleFile(new File([text], `${name}.txt`, { type: "text/plain" }));
      } catch {
        setError(["That sample could not be loaded."]);
        setPhase("error");
      }
    },
    [handleFile]
  );

  const applyFilters = (
    spec: string,
    code: string,
    pin: string,
    netOnly: boolean
  ) => {
    setSpecialty(spec);
    setProcedure(code);
    setPincode(pin);
    setNetworkOnly(netOnly);
    if (policy) void runMatch(policy, spec, code, pin, netOnly, origin, radiusKm);
  };

  /** Browser geolocation, then a radius search around wherever they are. */
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateError("This browser cannot share a location.");
      return;
    }

    setLocating(true);
    setLocateError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        setOrigin(point);
        setPincode("");
        setLocating(false);
        if (policy) void runMatch(policy, specialty, procedure, "", networkOnly, point, radiusKm);
      },
      () => {
        setLocating(false);
        setLocateError("Location was declined. Pick an area instead.");
      },
      { timeout: 10000 }
    );
  };

  const clearLocation = () => {
    setOrigin(null);
    setLocateError(null);
    if (policy) void runMatch(policy, specialty, procedure, pincode, networkOnly, null, radiusKm);
  };

  const changeRadius = (km: number) => {
    setRadiusKm(km);
    if (policy && origin) {
      void runMatch(policy, specialty, procedure, "", networkOnly, origin, km);
    }
  };

  /** Changing specialty invalidates any procedure that does not belong to it. */
  const onSpecialtyChange = (spec: string) => {
    const stillValid = facets.packages.some(
      (p) => p.code === procedure && p.specialty === spec
    );
    applyFilters(spec, stillValid ? procedure : "", pincode, networkOnly);
  };

  const packagesForSpecialty = specialty
    ? facets.packages.filter((p) => p.specialty === specialty)
    : facets.packages;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">H</span>
          Hospitality
        </div>
        <span className="env">Demo · mock data</span>
        <span className="spacer" />
        <span className="status">
          <span className="dot" />
          60 hospitals indexed
        </span>
        <ThemeToggle />
      </header>

      <div className="layout">
        <nav className="rail">
          <div className="rail-group">
            <p>Admission workflow</p>
            {STAGES.map((stage, i) => (
              <div
                key={stage.label}
                className={`rail-item ${i === stageIndex ? "is-active" : ""} ${i < stageIndex ? "is-done" : ""}`}
              >
                <span className="idx">{`0${i + 1}`}</span>
                {stage.label}
              </div>
            ))}
          </div>

          <p className="rail-note">
            TPA consoles compute the proportionate deduction at adjudication. Billing
            desks compute it at discharge. This computes it before you choose a room.
          </p>
        </nav>

        <main className="workspace">
          <div className="page-head">
            <div>
              <p className="eyebrow">Admission cost, priced against your policy</p>
              <h1>Know what you&rsquo;ll pay before you&rsquo;re admitted.</h1>
              <p>
                Upload a health insurance policy. This reads the room limits, co-payment
                and network, then prices every Delhi hospital and room category against
                them.
              </p>
            </div>
          </div>

          {phase === "idle" && (
            <div className="split">
              <section className="panel">
                <div className="panel-head">
                  <h3>1 · Policy intake</h3>
                  <span className="eyebrow">PDF or TXT</span>
                </div>
                <div className="panel-body">
                  <div
                    className={`drop ${dragging ? "is-over" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) void handleFile(file);
                    }}
                  >
                    <p>Drop a policy document here, or select one from your device.</p>
                    <button className="btn" onClick={() => fileInput.current?.click()}>
                      Select file
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".pdf,.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                  </div>

                  <div className="drop-actions">
                    <p className="eyebrow" style={{ marginBottom: "8px" }}>
                      Or load a mock policy
                    </p>
                    <div className="samples">
                      <button onClick={() => void loadSample("retail_star_health")}>
                        Retail · ₹5,000 room cap
                      </button>
                      <button onClick={() => void loadSample("corporate_gmc")}>
                        Corporate GMC · no cap
                      </button>
                      <button onClick={() => void loadSample("pmjay")}>PM-JAY</button>
                    </div>
                  </div>
                </div>
              </section>

              <WorkedExample />
            </div>
          )}

          {phase === "reading" && (
            <section className="panel">
              <div className="panel-body">
                <div className="working">
                  <span className="pulse" />
                  <span>
                    Extracting coverage terms — room limits, ICU limits, co-payment,
                    waiting periods and network. Up to a minute.
                  </span>
                </div>
              </div>
            </section>
          )}

          {phase === "error" && (
            <section className="panel">
              <div className="panel-body">
                <div className="notice notice-error">
                  <strong>The policy could not be read.</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                    {error.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
                <button className="btn btn-quiet" onClick={() => setPhase("idle")}>
                  Try another file
                </button>
              </div>
            </section>
          )}

          {phase === "ready" && policy && (
            <>
              <PolicySummary policy={policy} />

              <section className="panel">
                <div className="panel-head">
                  <h3>2 · Treatment and location</h3>
                </div>
                <div className="panel-body">
                  <div className="locbar">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={useMyLocation}
                      disabled={locating}
                    >
                      {locating ? "Finding you…" : "Use my location"}
                    </button>

                    {origin ? (
                      <>
                        <span className="locbar-state">
                          Searching within
                          <select
                            aria-label="Search radius"
                            value={radiusKm}
                            onChange={(e) => changeRadius(Number(e.target.value))}
                          >
                            <option value={3}>3 km</option>
                            <option value={5}>5 km</option>
                            <option value={10}>10 km</option>
                            <option value={20}>20 km</option>
                            <option value={40}>40 km</option>
                          </select>
                          of you
                        </span>
                        <button type="button" className="linkish" onClick={clearLocation}>
                          Clear
                        </button>
                      </>
                    ) : (
                      <span className="meta">
                        or choose an area below
                      </span>
                    )}
                  </div>

                  {locateError && (
                    <div className="notice" style={{ marginTop: "10px" }}>
                      {locateError}
                    </div>
                  )}

                  <div className="controls" style={{ marginTop: "14px" }}>
                    <div className="field">
                      <label htmlFor="specialty">Department</label>
                      <select
                        id="specialty"
                        value={specialty}
                        onChange={(e) => onSpecialtyChange(e.target.value)}
                      >
                        <option value="">All departments</option>
                        <optgroup label="Published package rates">
                          {facets.specialties
                            .filter((s) => s.packageCount > 0)
                            .map((s) => (
                              <option key={s.tag} value={s.tag}>
                                {s.label} — {s.packageCount} procedures
                              </option>
                            ))}
                        </optgroup>
                        <optgroup label="Cost estimated from room rates">
                          {facets.specialties
                            .filter((s) => s.packageCount === 0)
                            .map((s) => (
                              <option key={s.tag} value={s.tag}>
                                {s.label} ({s.count} hospitals)
                              </option>
                            ))}
                        </optgroup>
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="procedure">Procedure</label>
                      <select
                        id="procedure"
                        value={procedure}
                        onChange={(e) =>
                          applyFilters(specialty, e.target.value, pincode, networkOnly)
                        }
                      >
                        <option value="">
                          {packagesForSpecialty.length === 0
                            ? "No package rates for this department"
                            : "Any procedure in this department"}
                        </option>
                        {packagesForSpecialty.map((p) => (
                          <option key={p.code} value={p.code}>
                            {p.label} ({p.count} hospitals)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="area">Area</label>
                      <select
                        id="area"
                        value={pincode}
                        disabled={origin !== null}
                        onChange={(e) =>
                          applyFilters(specialty, procedure, e.target.value, networkOnly)
                        }
                      >
                        <option value="">Anywhere in Delhi</option>
                        {facets.locations.map((l) => (
                          <option key={l.pincode} value={l.pincode}>
                            {l.area} · {l.pincode} ({l.count})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="network">Network</label>
                      <div className="check">
                        <input
                          id="network"
                          type="checkbox"
                          checked={networkOnly}
                          onChange={(e) =>
                            applyFilters(specialty, procedure, pincode, e.target.checked)
                          }
                        />
                        <span style={{ fontSize: "0.85rem" }}>
                          Only hospitals that accept this policy
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="meta" style={{ marginTop: "12px" }}>
                    {procedure
                      ? "Costs use each hospital's published package rate for this procedure."
                      : packagesForSpecialty.length === 0
                        ? "The dataset carries package rates for 12 procedures across 8 departments. This department is not one of them, so costs are estimated from room rates and a typical three-day stay."
                        : "No procedure selected — costs are estimated from room rates and a typical three-day stay."}
                  </p>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h3>3 · Hospitals</h3>
                  <span className="eyebrow">
                    {matching ? "Pricing…" : `${matches.length} results · lowest cost first`}
                  </span>
                </div>

                {!matching && matches.length > 0 && (
                  <HospitalMap matches={matches} origin={origin} />
                )}

                {matching ? (
                  <div className="panel-body">
                    <div className="working">
                      <span className="pulse" />
                      <span>Pricing hospitals against this policy…</span>
                    </div>
                  </div>
                ) : matches.length === 0 ? (
                  <div className="panel-body">
                    <p className="meta">
                      No hospital in the dataset offers this procedure under these
                      filters. Widen the location, or clear the network filter to see
                      what is available outside the network.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="table-head">
                      <span>Hospital</span>
                      <span>Status</span>
                      <span>Est. bill</span>
                      <span>You pay from</span>
                    </div>
                    {matches.map((match) => (
                      <HospitalCard key={match.hospital.id} match={match} />
                    ))}
                  </>
                )}
              </section>

              <button
                className="btn btn-quiet"
                onClick={() => {
                  setPhase("idle");
                  setPolicy(null);
                  setMatches([]);
                }}
              >
                Load a different policy
              </button>
            </>
          )}

          <Disclaimer />
        </main>
      </div>
    </>
  );
}