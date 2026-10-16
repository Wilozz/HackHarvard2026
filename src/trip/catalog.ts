import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../config";

const hotelSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  region: z.string(),
  nightlyRateUsd: z.number().positive(),
  roomCapacity: z.number().int().positive(),
  /** "DEMO" means DEMO_FRONT_DESK_PHONE, so the demo never dials a real hotel. */
  phone: z.string(),
  highlights: z.array(z.string()),
});
const catalogSchema = z.object({ hotels: z.array(hotelSchema) });

export type Hotel = z.infer<typeof hotelSchema>;

let cached: Hotel[] | undefined;

export function loadCatalog(): Hotel[] {
  cached ??= catalogSchema.parse(JSON.parse(readFileSync("data/catalog.json", "utf8"))).hotels;
  return cached;
}

export function hotelPhone(hotel: Hotel): string | undefined {
  return hotel.phone === "DEMO" ? config.DEMO_FRONT_DESK_PHONE : hotel.phone;
}
