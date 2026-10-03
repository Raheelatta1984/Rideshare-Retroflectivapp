export type PlatformId =
  | "uber"
  | "didi"
  | "lyft"
  | "ola"
  | "grab"
  | "bolt"
  | "indriver"
  | "99taxis"
  | string;

export type DriverRole = "admin" | "driver" | "demo" | "owner" | "supervisor";

export interface Vehicle {
  make: string;
  model: string;
  color: string;
  plate: string;
  year: string;
}

export interface Driver {
  id: string;
  name: string;
  email: string;
  phone: string;
  password: string;
  city: string;
  pairCode: string;
  frontPairCode?: string;
  createdAt: string;
  platforms: PlatformId[];
  vehicle: Vehicle;
  role?: DriverRole;
}

export interface Ride {
  id: string;
  driverId: string;
  platform: string;
  passengerFirst: string;
  passengerLastInitial: string;
  colorCode: string;
  pin: string;
  pickup: string;
  dropoff: string;
  fare: string;
  etaMinutes: number;
  status: RideStatus;
  createdAt: string;
  acceptedAt?: string;
  stoppedAt?: string;
  arrivedAt?: string;
  completedAt?: string;
}

export type RideStatus =
  | "incoming"
  | "accepted"
  | "en_route"
  | "stopped"
  | "arrived"
  | "dropoff"
  | "in_trip"
  | "complete"
  | "idle";

export interface ActivityLog {
  id: string;
  at: number;
  action: string;
  pairCode?: string;
  actorId?: string;
  driverId?: string;
  deviceId?: string;
  deviceName?: string;
  platforms?: string[];
  details?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  pairCode: string;
  position: "rear" | "front";
  lastSeen: number;
}

export interface TabletBattery {
  percentage: number;
  charging: boolean;
  updatedAt: number;
  deviceId: string;
  deviceName: string;
  pairCode?: string;
  position?: "rear" | "front";
}

export interface DisplaySettings {
  theme: "day" | "night" | "amber" | "auto";
  masterOn?: boolean;
  rearMasterOn?: boolean;
  frontMasterOn?: boolean;
  apps?: string[];
  brightness?: number;
  adaptiveBrightness?: boolean;
  displayDurationSeconds?: number;
  includeBlank?: boolean;
  blankDurationSeconds?: number;
  motionSafetyGate?: boolean;
  stationarySpeedKph?: number;
  stationaryWaitSeconds?: number;
  stopDelaySeconds?: number;
  showPlatform?: boolean;
  showPin?: boolean;
  showColorBar?: boolean;
  showLastInitial?: boolean;
  showGreeting?: boolean;
  diagnosticsOverlay?: boolean;
  platformBackgroundMode?: "brand" | "black";
  wordmarkEmbossed?: boolean;
  fadeTransitions?: boolean;
  nswSafetyMode?: boolean;
  language?: "en" | "es" | "fr" | "de" | "pt" | "zh" | "ja" | "ko" | "ar" | "hi";
  deviceProfiles?: DeviceProfile[];
  commercialCampaigns?: CommercialCampaign[];
  includeCommercial?: boolean;
  /** Sleep pin-light shown on the rear glass while idle. */
  sleepIndicator?: boolean;
  /** Whether the driver can see the front-tablet mirror. */
  frontDriverVisible?: boolean;
  /** Tablet battery alerting. */
  batteryAlertsEnabled?: boolean;
  batteryAlertStep?: number;
  batteryAlertCooldownMinutes?: number;
  /** Last enterprise QA simulation result (driver console → Testing). */
  enterpriseQa?: EnterpriseQaResult;
}

/**
 * Result of the driver console's enterprise QA simulation.
 * Control-plane only: it never creates real devices or sockets.
 */
export interface EnterpriseQaResult {
  targetDevices: number;
  simulatedOnline: number;
  admittedDevices: number;
  acknowledgedDevices: number;
  recoveredDevices: number;
  failedDevices: number;
  estimatedDispatchPerSecond: number;
  runDurationSeconds: number;
  lastRunAt: number;
  lastRunDurationMs: number;
  note: string;
}

export interface DeviceProfile {
  id: string;
  pairCode: string;
  position: "rear" | "front";
  label?: string;
  deviceId?: string;
  /** Every field below is always materialised by createDeviceProfile(). */
  powered: boolean;
  apps: string[];
  brightness: number;
  adaptiveBrightness: boolean;
  displayDurationSeconds: number;
  includeBlank: boolean;
  blankDurationSeconds: number;
  commercialEnabled: boolean;
  campaignIds: string[];
  passengerNameEnabled: boolean;
  passengerName?: string;
  /** NSW safety mode requires an explicit parked confirmation per device. */
  commercialParkedConfirmed?: boolean;
}

export interface MotionState {
  isStationary: boolean;
  speedMps?: number;
  stoppedForMs: number;
  allowed: boolean;
}

export interface DeviceTelemetry {
  deviceId: string;
  deviceName: string;
  pairCode: string;
  position: "rear" | "front";
  at: number;
  displayState: "live" | "blank" | "waiting";
  battery?: TabletBattery;
  screen: string;
  devicePixelRatio: number;
  visibility: "visible" | "hidden";
  connection?: string;
  downlinkMbps?: number;
  rttMs?: number;
  deviceMemoryGb?: number;
  jsHeapUsedMb?: number;
  uptimeSeconds: number;
  activeContent?: string;
}

export interface CommercialCampaign {
  id: string;
  title: string;
  enabled: boolean;
  approved: boolean;
  assetDataUrl: string;
  /** "gif" is only allowed when NSW safety mode is off. */
  mediaType: "image" | "video" | "gif";
  displaySeconds: number;
  target?: "rear" | "front" | "both";
  discountText?: string;
  referralCode?: string;
  legal?: CommercialCampaignLegal;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * The six consent slots a commercial campaign carries. Used both as the shape
 * of CommercialCampaignLegal's consent fields and as the role argument when
 * issuing a consent PDF from the driver console.
 */
export type ConsentRole =
  | "appOwner"
  | "driver"
  | "vehicleOwner"
  | "campaignOwner"
  | "trademarkAuthorization"
  | "safetyAssessment";

export interface CommercialCampaignLegal {
  /**
   * The six consent records are always created together by blankCampaignLegal()
   * and are required before a campaign can be displayed.
   */
  appOwner: LegalConsent;
  driver: LegalConsent;
  vehicleOwner: LegalConsent;
  campaignOwner: LegalConsent;
  trademarkAuthorization: LegalConsent;
  safetyAssessment: LegalConsent;
  merchantName?: string;
  offerExpiry?: string;
  privacyPolicyUrl?: string;
  qrTermsConfirmed?: boolean;
  noRiderDataWithoutConsent?: boolean;
  /** Driver confirms they are the registered owner of the display vehicle. */
  driverIsVehicleOwner?: boolean;
  /** Timestamp of the issued full-authorization pack, if any. */
  fullAuthorizationIssuedAt?: number;
  fullAuthorizationDelivery?: DeliveryStatus | string;
}

export type DeliveryStatus = "not-issued" | "prepared" | "delivered" | "failed";

export interface LegalConsent {
  confirmed: boolean;
  signerName: string;
  agreementReference: string;
  email?: string;
  confirmedAt?: number;
  /** Timestamp the consent PDF was generated for the signer. */
  signedDocumentAt?: number;
  deliveryStatus?: DeliveryStatus | string;
}

export interface DeviceProfileInput {
  /** Defaults to codeProfileId(pairCode, position) when omitted. */
  id?: string;
  pairCode: string;
  position?: "rear" | "front";
  deviceId?: string;
  label?: string;
  powered?: boolean;
  apps?: string[];
  brightness?: number;
  adaptiveBrightness?: boolean;
  displayDurationSeconds?: number;
  includeBlank?: boolean;
  blankDurationSeconds?: number;
  commercialEnabled?: boolean;
  campaignIds?: string[];
  passengerNameEnabled?: boolean;
  passengerName?: string;
}

export interface PasswordResetRecord {
  email: string;
  code: string;
  token: string;
  createdAt: number;
  verifiedAt?: number;
  usedAt?: number;
}

export interface Platform {
  id: string;
  name: string;
  short: string;
  color: string;
  text: string;
  accent: string;
  blurb: string;
}

export type TabletDevice = {
  id: string;
  name: string;
  pairCode: string;
  position: "rear" | "front";
  lastSeen: number;
};