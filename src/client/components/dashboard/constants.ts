import type { ChatProvider, HighlightCategory } from "../../../shared/types";

export const WINDOW_OPTIONS = [1, 3, 5, 10];
export const BAR_WIDTH = 7;
export const BAR_GAP = 3;
export const SLOT_WIDTH = BAR_WIDTH + BAR_GAP;
export const CHART_HEIGHT = 200;
export const CHART_BOTTOM_PAD = 20;
export const RENDER_BUFFER_SLOTS = 20;
export const MAX_FILLED_SLOTS = 50_000;
export const TIME_LABEL_SLOT_INTERVAL = 15;
export const MAX_TRACKED_KEYWORDS = 8;
export const SESSIONS_REFRESH_THROTTLE_MS = 5_000;
/** 구간 종료 표시 — 직전 구간의 띠를 여기서 끊고, 다음 마커 전까지 빈 구간으로 둔다 */
export const MARKER_END_LABEL = "종료";
export const MARKER_PRESETS = ["밴픽", "게임", "휴식", "광고", MARKER_END_LABEL];
// 캡처가 1fps라 프레임 자체가 최대 1초 간격 — 300ms면 5장이 1.5초에 한 바퀴 돌아
// "영상처럼 움직이는" 느낌을 주면서도 각 프레임이 눈에 들어오는 균형점
export const FRAME_PLAYBACK_INTERVAL_MS = 300;
// 서버의 프레임 인덱스 재스캔 주기(frameCapture.ts)와 맞춰, 그보다 빨리 폴링해도 의미가 없다
export const FRAME_INDEX_REFRESH_MS = 5_000;
export const MARKER_COLORS: Record<string, string> = {
  밴픽: "rgba(143, 198, 255, 0.24)",
  게임: "rgba(49, 232, 149, 0.2)",
  휴식: "rgba(255, 207, 93, 0.22)",
  광고: "rgba(255, 107, 125, 0.22)"
};

export const MIN_SPIKE_SAMPLE_WINDOWS = 12;
export const SPIKE_ALERT_MAX_AGE_MS = 30_000;
export const SPIKE_TOAST_LIFETIME_MS = 6_000;

export const PROVIDER_LABEL: Record<ChatProvider, string> = { chzzk: "치지직", soop: "SOOP" };

export const HIGHLIGHT_CATEGORIES: Array<{ value: HighlightCategory; label: string }> = [
  { value: "teamfight", label: "한타" },
  { value: "player_mistake", label: "실수" },
  { value: "objective", label: "오브젝트" },
  { value: "solo_kill", label: "솔로킬" },
  { value: "pentakill", label: "펜타킬" },
  { value: "macro", label: "운영" },
  { value: "other", label: "기타" }
];

export interface TimelineSelection {
  startAt: number;
  endAt: number;
}
