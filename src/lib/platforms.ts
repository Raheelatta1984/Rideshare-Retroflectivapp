// Rideshare platforms supported by Retroflex
export interface Platform {
  id: string;
  name: string;
  short: string;
  color: string;
  text: string;
  accent: string;
  blurb: string;
}

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