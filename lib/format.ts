/** Shared display helpers. Keeps rupee formatting identical everywhere. */

export const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export const titleCase = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Shape returned by GET /api/facets. */
export interface Facets {
  specialties: Array<{ tag: string; label: string; count: number; packageCount: number }>;
  packages: Array<{ code: string; label: string; specialty: string; count: number }>;
  locations: Array<{ pincode: string; label: string; area: string; count: number }>;
}

export const EMPTY_FACETS: Facets = { specialties: [], packages: [], locations: [] };