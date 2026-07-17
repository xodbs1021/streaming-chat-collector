export type ChatProvider = "chzzk" | "soop";
export type SourceMode = "official" | "unofficial" | "mock";
export type ProviderState =
  | "idle"
  | "auth_required"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "unsupported"
  | "error";

export type ChatRole =
  | "streamer"
  | "manager"
  | "chat_manager"
  | "verified"
  | "subscriber"
  | "viewer";

export interface ChatBadge {
  id: string;
  label: string;
  imageUrl?: string;
}

export interface ChatEmote {
  id: string;
  token: string;
  url: string;
}

export interface ChatMessage {
  provider: ChatProvider;
  sourceMode: SourceMode;
  channelId: string;
  messageId: string;
  nickname: string;
  role: ChatRole;
  badges: ChatBadge[];
  content: string;
  emotes: ChatEmote[];
  timestamp: number;
  raw: unknown;
}

export interface ChatRecord extends ChatMessage {
  sessionId: string;
  sequence: number;
  receivedAt: number;
}

export interface RecordingSession {
  sessionId: string;
  /** 이 provider 세션이 속한 방송 — 신규 레이아웃에서 `<broadcastId>/chat/<provider>/`를 가리킨다. */
  broadcastId?: string;
  provider: ChatProvider;
  sourceMode: SourceMode;
  channelId: string;
  startedAt: number;
  endedAt?: number;
  messageCount: number;
  fileName: string;
  displayName?: string;
  archivedAt?: number;
}

/** 방송에 참여한 provider 한 줄 — broadcast.meta.json의 providers 배열 원소. */
export interface BroadcastProviderRef {
  provider: ChatProvider;
  sourceMode: SourceMode;
  channelId: string;
}

/** 방송(broadcast) 단위 세션 — chzzk+soop 등 여러 provider를 하나의 broadcastId로 묶는다. */
export interface BroadcastSession {
  broadcastId: string;
  startedAt: number;
  endedAt?: number;
  providers: BroadcastProviderRef[];
  displayName?: string;
  archivedAt?: number;
}

/** 녹화 라이프사이클 상태. idle=비녹화, recording=저장 중, grace=방송종료 감지 후 자동종료 대기. */
export type RecordingState = "idle" | "recording" | "grace";

export interface RecordingStatus {
  enabled: boolean;
  dataDir: string;
  message: string;
  recordingState?: RecordingState;
  activeBroadcastId?: string;
  activeSession?: RecordingSession;
  activeSessions?: RecordingSession[];
  lastRecordAt?: number;
}

/** 프레임 인덱스 응답 — 라이브(/api/frames)·과거(/api/broadcasts) index 라우트와 클라 fetchFrameSeconds가 공유. */
export interface FrameIndexResponse {
  seconds: number[];
}

export interface AnalyticsRankItem {
  label: string;
  count: number;
  id?: string;
}

export interface ViewerCountSample {
  provider: ChatProvider;
  timestamp: number;
  count: number;
}

export interface AnalyticsWindow {
  windowStart: number;
  windowEnd: number;
  messageCount: number;
  uniqueChatters: number;
  avgLength: number;
  maxLength: number;
  providerCounts: Partial<Record<ChatProvider, number>>;
  roleCounts: Partial<Record<ChatRole, number>>;
  topChatters: AnalyticsRankItem[];
  topTerms: AnalyticsRankItem[];
  topEmotes: AnalyticsRankItem[];
  viewerCount?: number;
  keywordCounts?: Record<string, number>;
}

export interface AnalyticsSummary {
  generatedAt: number;
  windowSec: number;
  totalMessages: number;
  uniqueChatters: number;
  startedAt?: number;
  endedAt?: number;
  session?: RecordingSession;
  providerCounts: Partial<Record<ChatProvider, number>>;
  roleCounts: Partial<Record<ChatRole, number>>;
  topChatters: AnalyticsRankItem[];
  topTerms: AnalyticsRankItem[];
  topEmotes: AnalyticsRankItem[];
  recentMessages: ChatRecord[];
  windows: AnalyticsWindow[];
  /** true when windows contains only the most recent windows (socket push); merge with existing client state */
  partialWindows?: boolean;
  viewerCount?: number;
  participationRate?: number;
}

export type HighlightLevel = "review" | "highlight" | "strong";
export type HighlightCategory = "teamfight" | "player_mistake" | "objective" | "solo_kill" | "pentakill" | "macro" | "other";

export interface HighlightAnnotation {
  candidateId: string;
  category: HighlightCategory;
  note: string;
  startAt?: number;
  endAt?: number;
  windowSec?: number;
  peakCount?: number;
  totalMessages?: number;
  topTerms?: AnalyticsRankItem[];
  createdAt: number;
  updatedAt: number;
}

export type HighlightAnnotationMap = Record<string, HighlightAnnotation>;

export interface HighlightThresholds {
  activeWindowMean: number;
  p95: number;
  p99: number;
  max: number;
  windowCount: number;
  activeWindowCount: number;
  candidateWindowCount: number;
}

export interface HighlightCandidate {
  id: string;
  sessionId: string;
  windowSec: number;
  level: HighlightLevel;
  startAt: number;
  endAt: number;
  durationSec: number;
  peakCount: number;
  totalMessages: number;
  uniqueChatters: number;
  score: number;
  topTerms: AnalyticsRankItem[];
  topEmotes: AnalyticsRankItem[];
  annotation?: HighlightAnnotation;
}

export interface HighlightSummary {
  generatedAt: number;
  windowSec: number;
  session?: RecordingSession;
  canSaveAnnotations: boolean;
  thresholds: HighlightThresholds;
  candidates: HighlightCandidate[];
  annotations: HighlightAnnotationMap;
}

/** 방송 구간 마커 — timestamp부터 endAt(지정 시) 또는 다음 마커 전까지가 하나의 구간 */
export interface TimelineMarker {
  id: string;
  label: string;
  timestamp: number;
  /** 구간 끝 (선택 범위로 만든 마커) — 없으면 다음 마커 전까지 이어짐 */
  endAt?: number;
  createdAt: number;
}

export interface SessionDisplayMeta {
  displayName?: string;
  archivedAt?: number;
}

export type ProviderFailureReason =
  | "offline"
  | "input_error"
  | "guest_chat_blocked"
  | "network_blocked"
  | "protocol_changed"
  | "auth_required"
  | "unknown";

export interface ProviderDiagnosticLog {
  id: string;
  provider: ChatProvider;
  sourceMode?: SourceMode;
  level: "info" | "success" | "warning" | "error";
  message: string;
  reason?: ProviderFailureReason;
  channelId?: string;
  detail?: string;
  createdAt: number;
}

export interface WindowComparisonItem {
  windowSec: number;
  totalMessages: number;
  windowCount: number;
  activeWindowMean: number;
  p95: number;
  p99: number;
  max: number;
  candidateWindowCount: number;
  reviewCount: number;
  highlightCount: number;
  strongCount: number;
  topScore: number;
}

export interface WindowComparisonSummary {
  generatedAt: number;
  session?: RecordingSession;
  items: WindowComparisonItem[];
}

export interface MediaAnalysisResult {
  candidateId: string;
  startAt: number;
  endAt: number;
  source: "video" | "audio" | "video_audio";
  score: number;
  label?: string;
  note?: string;
  createdAt: number;
}

/** ffmpeg 캡처 화질(세로 픽셀). scale=-2:<h>의 대상 높이로 쓰인다. */
export type CaptureQuality = 1080 | 720 | 480 | 360;

/** 관리 UI에 노출하는 화질 선택지 (높은 화질부터). */
export const CAPTURE_QUALITIES: readonly CaptureQuality[] = [1080, 720, 480, 360];

export interface OverlaySettings {
  maxMessages: number;
  fontSize: number;
  showBadges: boolean;
  showSourceLabel: boolean;
  showTimestamps: boolean;
  compactMode: boolean;
  messageLifetimeSec: number;
  backgroundOpacity: number;
  captureQuality: CaptureQuality;
}

export interface ProviderStatus {
  provider: ChatProvider;
  sourceMode: SourceMode;
  state: ProviderState;
  message: string;
  channelId?: string;
  connectedAt?: number;
  lastEventAt?: number;
  viewerCount?: number;
}

export type ProviderStatusMap = Partial<Record<ChatProvider, ProviderStatus>>;

export interface ConnectProviderRequest {
  provider: ChatProvider;
  sourceMode: SourceMode;
  channelId?: string;
}

export interface DisconnectProviderRequest {
  provider?: ChatProvider;
}

export interface HealthResponse {
  ok: boolean;
  uptimeSec: number;
  providerStatus: ProviderStatus;
  providerStatuses?: ProviderStatusMap;
}

export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
  "chat:delete": (messageId: string) => void;
  "provider:status": (status: ProviderStatus) => void;
  "provider:statuses": (statuses: ProviderStatusMap) => void;
  "settings:update": (settings: OverlaySettings) => void;
  "chat:history": (messages: ChatMessage[]) => void;
  "recording:status": (status: RecordingStatus) => void;
  "analytics:live": (summary: AnalyticsSummary) => void;
}

export interface ClientToServerEvents {
  "provider:connect": (request: ConnectProviderRequest) => void;
  "provider:disconnect": (request?: DisconnectProviderRequest) => void;
  "settings:update": (settings: Partial<OverlaySettings>) => void;
  /** 녹화 시작 — 현재 연결된 provider들을 하나의 방송으로 묶어 저장을 시작한다. */
  "recording:start": () => void;
  /** 녹화 종료 — 활성 방송 세션을 확정하고 저장을 멈춘다(연결은 유지). */
  "recording:stop": () => void;
}
