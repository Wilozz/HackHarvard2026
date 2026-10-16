const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(s: string): number | undefined {
  if (!ISO_DATE.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  // Reject rollovers such as 2026-02-31.
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? undefined : t;
}

/** Nights between two YYYY-MM-DD dates, or undefined if invalid or not positive. */
export function nightsBetween(checkIn: string, checkOut: string): number | undefined {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (a === undefined || b === undefined) return undefined;
  const n = Math.round((b - a) / DAY_MS);
  return n > 0 ? n : undefined;
}

export function roomsNeeded(guests: number, roomCapacity: number): number {
  return Math.max(1, Math.ceil(guests / roomCapacity));
}

export function stayTotalUsd(nightlyRateUsd: number, nights: number, rooms: number): number {
  return Math.round(nightlyRateUsd * nights * rooms * 100) / 100;
}

/**
 * Equal split in whole dollars (the Nessie sandbox truncates cents). Every
 * member except the payer owes floor(total / n); the payer pays the hotel and
 * covers the remainder, so the shares never add up to more than the bill.
 */
export function splitShares(totalUsd: number, memberKeys: string[], payerKey: string): Map<string, number> {
  const unique = [...new Set(memberKeys)];
  if (!unique.includes(payerKey)) throw new Error("payer must be one of the members");
  const per = Math.floor(totalUsd / unique.length);
  const shares = new Map<string, number>();
  for (const key of unique) if (key !== payerKey) shares.set(key, per);
  return shares;
}
