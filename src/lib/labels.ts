export type Language =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "zh"
  | "ja"
  | "ko"
  | "ar"
  | "hi";

export interface Labels {
  incoming: string;
  onTheWay: string;
  arriving: string;
  yourRide: string;
  inTrip: string;
  thanks: string;
}

const translations: Record<Language, Labels> = {
  en: {
    incoming: "INCOMING RIDE",
    onTheWay: "DRIVER ON THE WAY",
    arriving: "ARRIVING SOON",
    yourRide: "YOUR RIDE",
    inTrip: "IN TRIP",
    thanks: "THANK YOU",
  },
  es: {
    incoming: "VIAJE ENTRANTE",
    onTheWay: "CONDUCTOR EN CAMINO",
    arriving: "LLEGANDO PRONTO",
    yourRide: "TU VIAJE",
    inTrip: "EN VIAJE",
    thanks: "GRACIAS",
  },
  fr: {
    incoming: "COURSE ENTRANTE",
    onTheWay: "CHAUFFEUR EN ROUTE",
    arriving: "ARRIVÉE BIENTÔT",
    yourRide: "VOTRE COURSE",
    inTrip: "EN COURSE",
    thanks: "MERCI",
  },
  de: {
    incoming: "EINGEHENDE FAHRT",
    onTheWay: