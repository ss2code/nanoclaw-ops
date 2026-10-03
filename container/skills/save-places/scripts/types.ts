export type Visibility = 'group' | 'shareable';
export type InterestState = 'want-to-go' | 'maybe' | 'not-for-me';
export type VisitState = 'not-visited' | 'visited' | 'revisit';
export type VerificationState = 'verified' | 'provisional' | 'unverified';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RegionInput {
  id: string;
  name: string;
  countryCode: string;
  timezone: string;
  aliases?: string[];
  center?: Coordinates;
  bounds?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  active?: boolean;
}

export interface SourceInput {
  url?: string;
  platform?: string;
  title?: string;
  author?: string;
  sharedAt?: string;
}

export interface MemberInput {
  localId: string;
  displayAlias: string;
}

export interface ActivityInput {
  type?: string;
  interest?: InterestState;
  visitState?: VisitState;
  rating?: number;
  comment?: string;
  visibility?: Visibility;
  occurredAt?: string;
}

export interface MediaInput {
  kind: 'remote-image' | 'local-image' | 'source-card';
  url?: string;
  localPath?: string;
  alt?: string;
  attribution?: string;
  visibility?: Visibility;
}

export interface VerificationInput {
  state?: VerificationState;
  confidence?: number;
  references?: string[];
}

export interface HandoffProvenance {
  originalMessageId: string;
  originalChannel: string;
  delegatedBy: string;
  researchedBy: string;
}

export interface HandoffArtifact {
  filename: string;
  sha256: string;
  purpose?: string;
}

export interface IngestPlaceInput {
  id?: string;
  name: string;
  aliases?: string[];
  address?: string;
  locality?: string;
  neighborhood?: string;
  coordinates?: Coordinates;
  regionCandidate?: string;
  categories?: string[];
  tags?: string[];
  externalIds?: Record<string, string>;
  verification?: VerificationInput;
  activity?: ActivityInput;
  media?: MediaInput[];
  forceNew?: boolean;
}

export interface IngestEnvelope {
  ingestVersion: 1;
  idempotencyKey: string;
  source?: SourceInput;
  member: MemberInput;
  places: IngestPlaceInput[];
}

/** A durable worker-to-owner handoff. The envelope remains the ingest payload. */
export interface SavePlacesHandoff {
  handoffVersion: 1;
  kind: 'save-places.research';
  handoffId: string;
  provenance: HandoffProvenance;
  envelope: IngestEnvelope;
  artifacts?: HandoffArtifact[];
}

export interface PlaceMutation {
  inputIndex: number;
  status: 'created' | 'updated' | 'review';
  placeId?: string;
  placeName: string;
  regionId?: string;
  reviewId?: string;
  warnings: string[];
}

export interface IngestResult {
  ok: boolean;
  replayed: boolean;
  revision: number;
  affectedRegions: string[];
  mutations: PlaceMutation[];
  warnings: string[];
}

export interface PlaceSourceView {
  id: string;
  url: string;
  platform: string;
  title?: string;
  author?: string;
}

export interface PlaceEvidenceView {
  id: string;
  reference: string;
  role: 'verification';
  url?: string;
}

export interface PlaceMediaView {
  id: string;
  kind: string;
  url?: string;
  localPath?: string;
  alt: string;
  attribution?: string;
  visibility: Visibility;
}

export interface MemberPlaceStateView {
  memberId: string;
  displayAlias: string;
  interest?: InterestState;
  visitState: VisitState;
  rating?: number;
  lastComment?: string;
  updatedAt: string;
}

export interface ActivityView {
  id: string;
  type: string;
  displayAlias: string;
  interest?: InterestState;
  visitState?: VisitState;
  rating?: number;
  comment?: string;
  visibility: Visibility;
  occurredAt: string;
}

export interface PlaceView {
  id: string;
  anchor: string;
  name: string;
  aliases: string[];
  regionId?: string;
  regionName?: string;
  address?: string;
  locality?: string;
  neighborhood?: string;
  coordinates?: Coordinates;
  status: string;
  verificationState: VerificationState;
  confidence: number;
  categories: string[];
  tags: string[];
  sources: PlaceSourceView[];
  evidence: PlaceEvidenceView[];
  media: PlaceMediaView[];
  memberStates: MemberPlaceStateView[];
  activities: ActivityView[];
  summary: {
    wantToGo: number;
    visited: number;
    revisit: number;
    notForMe: number;
    ratingAverage?: number;
    ratingCount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RegionView {
  id: string;
  name: string;
  countryCode: string;
  timezone: string;
  aliases: string[];
  center?: Coordinates;
  bounds?: RegionInput['bounds'];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RenderResult {
  regionId: string;
  revision: number;
  profile: 'private' | 'share';
  htmlPath: string;
  jsonPath: string;
  places: number;
}
