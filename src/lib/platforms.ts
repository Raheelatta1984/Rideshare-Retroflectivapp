import type { Platform, Ride } from "../types";

// Rideshare platforms supported by Retroflex
export const PLATFORMS: Platform[] = [
  {
    id: "uber",
    name: "Uber",
    short: "UB",
    color: "#000000",
    text: "#FFFFFF",
    accent: "#000000",
    blurb: "Rideshare, Eats, Freight — the app universe.",
  },
  {
    id: "didi",
    name: "DiDi",
    short: "DD",
    color: "#FF6000",
    text: "#FFFFFF",
    accent: "#FF6000",
    blurb: "China and emerging markets rideshare leader.",
  },
  {
    id: "lyft",
    name: "Lyft",
    short: "LY",
    color: "#FF00BF",
    text: "#FFFFFF",
    accent: "#FF00BF",
    blurb: "US-focused rideshare with pink brand identity.",
  },
  {
    id: "ola",
    name: "Ola",
    short: "OL",
    color: "#FCC200",
    text: "#000000",
    accent: "#FCC200",
    blurb: "India's dominant rideshare and mobility platform.",
  },
  {
    id: "grab",
    name: "Grab",
    short: "GR",
    color: "#00B14F",
    text: "#FFFFFF",
    accent: "#00B14F",
    blurb: "Southeast Asia's super app for rides, food, logistics.",
  },
  {
    id: "bolt",
    name: "Bolt",
    short: "BT",
    color: "#001D4A",
    text: "#FFFFFF",
    accent: "#001D4A",
    blurb: "European and global rideshare and scooter platform.",
  },
  {
    id: "indriver",
    name: "inDriver",
    short: "ID",
    color: "#1CBAB0",
    text: "#FFFFFF",
    accent: "#1CBAB0",
    blurb: "Peer-to-peer rideshare in emerging markets.",
  },
  {
    id: "99taxis",
    name: "99Taxis",
    short: "99",
    color: "#FFCC00",
    text: "#000000",
    accent: "#FFCC00",
    blurb: "Brazil's established taxi and ride-hailing app.",
  },
];

/**
 * Look up a platform by id.
 *
 * Always returns a Platform: every caller renders .name/.accent/.short directly,
 * so an unknown id (e.g. a ride stored with a platform we no longer ship) used
 * to crash the history list with "Cannot read properties of undefined".
 */
export function getPlatform(id: string): Platform {
  return (
    PLATFORMS.find((p) => p.id === id) ?? {
      id: id || "unknown",
      name: id ? id.charAt(0).toUpperCase() + id.slice(1) : "Rideshare",
      short: (id || "??").slice(0, 2).toUpperCase(),
      color: "#1C1C1C",
      text: "#F4EDE1",
      accent: "#8A8A8A",
      blurb: "Unrecognised rideshare platform.",
    }
  );
}

// Sample rides for demo and testing
export const SAMPLE_RIDES: Ride[] = [
  {
    id: "ride_1",
    driverId: "demo",
    platform: "uber",
    passengerFirst: "Sarah",
    passengerLastInitial: "M",
    colorCode: "#FF6B6B",
    pin: "1234",
    pickup: "123 Main St, Downtown",
    dropoff: "456 Park Ave, Midtown",
    fare: "$28.50",
    etaMinutes: 12,
    status: "incoming",
    createdAt: new Date().toISOString(),
  },
  {
    id: "ride_2",
    driverId: "demo",
    platform: "didi",
    passengerFirst: "James",
    passengerLastInitial: "K",
    colorCode: "#4ECDC4",
    pin: "5678",
    pickup: "789 Market St",
    dropoff: "321 Harbor Blvd",
    fare: "$35.00",
    etaMinutes: 8,
    status: "incoming",
    createdAt: new Date().toISOString(),
  },
  {
    id: "ride_3",
    driverId: "demo",
    platform: "lyft",
    passengerFirst: "Emma",
    passengerLastInitial: "J",
    colorCode: "#FFE66D",
    pin: "9012",
    pickup: "555 Broadway",
    dropoff: "777 5th Avenue",
    fare: "$24.75",
    etaMinutes: 15,
    status: "incoming",
    createdAt: new Date().toISOString(),
  },
  {
    id: "ride_4",
    driverId: "demo",
    platform: "ola",
    passengerFirst: "Arjun",
    passengerLastInitial: "P",
    colorCode: "#95E1D3",
    pin: "3456",
    pickup: "999 Tech Park",
    dropoff: "111 Innovation Ave",
    fare: "$18.50",
    etaMinutes: 6,
    status: "incoming",
    createdAt: new Date().toISOString(),
  },
];