import type { Driver } from "../types";
import { uid, pairCode } from "./id";

export const DEMO_DRIVER: Driver = {
  id: uid("drv"),
  name: "Raheel",
  email: "demo@retroflex.app",
  phone: "+61 451-195-192",
  password: "demo1234",
  city: "Sydney",
  pairCode: pairCode(),
  frontPairCode: pairCode(),
  createdAt: new Date().toISOString(),
  platforms: ["uber", "didi"],
  vehicle: {
    make: "Toyota",
    model: "Prius V",
    color: "Snowhite",
    plate: "CIW37G",
    year: "2012",
  },
  role: "demo",
};

/**
 * Seeds the demo driver into the database if it doesn't exist
 * This ensures there's always a demo account available for testing
 */
export function seedDemoDriver(
  save: (driver: Driver) => void,
  findByEmail: (email: string) => Driver | undefined
) {
  const existing = findByEmail(DEMO_DRIVER.email);
  if (!existing) {
    save(DEMO_DRIVER);
  }
}