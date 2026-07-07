import { CheckCircle2, FlaskConical, LogIn, Plug, Power, RadioTower, Send, Settings2, Wifi } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { ChatProvider, OverlaySettings, ProviderDiagnosticLog, ProviderStatus, ProviderStatusMap, SourceMode } from "../../shared/types";
import { useRealtime } from "../hooks/useRealtime";

export function AdminRoute() {
  const { settings, providerStatus, providerStatuses, socketConnected, socket } = useRealtime();
  const [provider, setProvider] = useState<ChatProvider>("chzzk");
  const [sourceMode, setSourceMode] = useState<SourceMode>("official");
  const [channelId, setChannelId] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [providerLogs, setProviderLogs] = useState<ProviderDiagnosticLog[]>([]);
  const [localSettings, setLocalSettings] = useState<OverlaySettings>(settings);
  const authNotice = readAuthNotice();
  const selectedStatus = providerStatuses[provider] ?? providerStatus;

  useEffect(() => setLocalSettings(settings), [settings]);

  useEffect(() => {
    let cancelled = false;

    async function loadProviderLogs() {
      try {
        const response = await fetch("/api/providers/logs");
        if (!response.ok) {
          return;
        }
        const logs = (await response.json()) as ProviderDiagnosticLog[];
        if (!cancelled) {
          setProviderLogs(logs);
        }
      } catch {
        // 진단 패널은 보조 정보라 네트워크 오류를 조용히 무시합니다.
      }
    }

    void loadProviderLogs();
    const intervalId = window.setInterval(() => {
      void loadProviderLogs();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  function connect() {
    socket.emit("provider:connect", {
      provider,
      sourceMode: provider === "soop" ? "unofficial" : sourceMode,
      channelId
    });
  }

  function disconnect() {
    socket.emit("provider:disconnect", { provider });
  }

  function selectProvider(nextProvider: ChatProvider) {
    setProvider(nextProvider);
    setSourceMode(nextProvider === "soop" ? "unofficial" : "official");
  }

  function sendTestMessage(event: FormEvent) {
    event.preventDefault();
    socket.emit("test:message", { content: testMessage, provider });
    setTestMessage("");
  }

  function updateSettings(patch: Partial<OverlaySettings>) {
    const next = { ...localSettings, ...patch };
    setLocalSettings(next);
    socket.emit("settings:update", patch);
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">MULTICHAT OVERLAY</p>
          <h1>방송 채팅 관리</h1>
        </div>
        <div className="admin-header-actions">
          <a className="ghost-button" href="/dashboard">
            분석 대시보드
          </a>
          <a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">
            OBS 오버레이 열기
          </a>
        </div>
      </header>

      {authNotice && (
        <section className={`auth-notice ${authNotice.kind}`} aria-live="polite">
          <strong>{authNotice.title}</strong>
          <span>{authNotice.message}</span>
        </section>
      )}

      <section className="admin-grid">
        <div className="panel connect-panel">
          <div className="panel-title">
            <Plug size={20} />
            <h2>채팅 소스 연결</h2>
          </div>

          <div className="mode-control provider-control" role="tablist" aria-label="채팅 플랫폼">
            <button className={provider === "chzzk" ? "active" : ""} onClick={() => selectProvider("chzzk")}>
              <Plug size={17} />
              치지직
            </button>
            <button className={provider === "soop" ? "active" : ""} onClick={() => selectProvider("soop")}>
              <RadioTower size={17} />
              SOOP
            </button>
          </div>

          {provider === "chzzk" ? (
            <>
              <div className="mode-control source-mode-control" role="tablist" aria-label="치지직 연결 방식">
                <button className={sourceMode === "official" ? "active" : ""} onClick={() => setSourceMode("official")}>
                  <CheckCircle2 size={17} />
                  공식 Open API
                </button>
                <button className={sourceMode === "unofficial" ? "active" : ""} onClick={() => setSourceMode("unofficial")}>
                  <FlaskConical size={17} />
                  비공식 실험
                </button>
              </div>

              {sourceMode === "official" ? (
                <div className="auth-box">
                  <div className="auth-step-grid">
                    <a className="ghost-button" href="/api/auth/chzzk/login" target="_blank" rel="noreferrer">
                      <LogIn size={18} />
                      1. 치지직 로그인
                    </a>
                    <a className="auth-button" href="/api/auth/chzzk/start">
                      <CheckCircle2 size={18} />
                      2. 공식 연결 승인
                    </a>
                  </div>
                  <p className="auth-help">
                    새 탭에서 치지직 홈 우측 상단에 프로필이 보이면 이 화면으로 돌아와 2번을 누르세요.
                  </p>
                  <a className="auth-fallback-link" href="/api/auth/chzzk/start?viaNaver=1">
                    네이버 로그인 경유 방식으로 다시 시도
                  </a>
                </div>
              ) : (
                <label className="field">
                  <span>공개 채널 ID 또는 라이브 URL</span>
                  <input
                    value={channelId}
                    onChange={(event) => setChannelId(event.target.value)}
                    placeholder="예: 채널 ID 또는 https://chzzk.naver.com/live/채널ID"
                  />
                </label>
              )}
            </>
          ) : (
            <div className="auth-box">
              <div className="source-mode-badge">
                <FlaskConical size={16} />
                공개 수신 모드
              </div>
              <label className="field">
                <span>BJ ID 또는 방송 URL</span>
                <input
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value)}
                  placeholder="예: phonics1 또는 https://play.sooplive.co.kr/phonics1"
                />
              </label>
            </div>
          )}

          <div className="action-row">
            <button className="primary-button" onClick={connect}>
              <Wifi size={18} />
              연결
            </button>
            <button className="ghost-button" onClick={disconnect}>
              <Power size={18} />
              해제
            </button>
          </div>

          <ProviderStatusCards statuses={providerStatuses} selectedProvider={provider} />
          <StatusBlock socketConnected={socketConnected} state={selectedStatus.state} message={selectedStatus.message} />
        </div>

        <div className="panel settings-panel">
          <div className="panel-title">
            <Settings2 size={20} />
            <h2>오버레이 표시</h2>
          </div>

          <RangeField
            label="글자 크기"
            value={localSettings.fontSize}
            min={14}
            max={42}
            unit="px"
            onChange={(value) => updateSettings({ fontSize: value })}
          />
          <RangeField
            label="최대 채팅 수"
            value={localSettings.maxMessages}
            min={10}
            max={300}
            unit="개"
            onChange={(value) => updateSettings({ maxMessages: value })}
          />
          <RangeField
            label="배경 투명도"
            value={Math.round(localSettings.backgroundOpacity * 100)}
            min={0}
            max={90}
            unit="%"
            onChange={(value) => updateSettings({ backgroundOpacity: value / 100 })}
          />
          <RangeField
            label="자동 사라짐"
            value={localSettings.messageLifetimeSec}
            min={0}
            max={120}
            unit="초"
            onChange={(value) => updateSettings({ messageLifetimeSec: value })}
          />

          <div className="toggle-grid">
            <Toggle label="배지 표시" checked={localSettings.showBadges} onChange={(showBadges) => updateSettings({ showBadges })} />
            <Toggle
              label="소스 라벨"
              checked={localSettings.showSourceLabel}
              onChange={(showSourceLabel) => updateSettings({ showSourceLabel })}
            />
            <Toggle
              label="시간 표시"
              checked={localSettings.showTimestamps}
              onChange={(showTimestamps) => updateSettings({ showTimestamps })}
            />
            <Toggle
              label="컴팩트"
              checked={localSettings.compactMode}
              onChange={(compactMode) => updateSettings({ compactMode })}
            />
          </div>
        </div>

        <form className="panel test-panel" onSubmit={sendTestMessage}>
          <div className="panel-title">
            <Send size={20} />
            <h2>테스트 메시지</h2>
          </div>
          <label className="field">
            <span>내용</span>
            <input value={testMessage} onChange={(event) => setTestMessage(event.target.value)} placeholder="오버레이 테스트 메시지" />
          </label>
          <button className="primary-button" type="submit">
            <Send size={18} />
            보내기
          </button>
        </form>

        <ProviderLogPanel logs={providerLogs} />
      </section>
    </main>
  );
}

function ProviderStatusCards({ statuses, selectedProvider }: { statuses: ProviderStatusMap; selectedProvider: ChatProvider }) {
  const providers: ChatProvider[] = ["chzzk", "soop"];
  return (
    <div className="provider-status-grid" aria-label="플랫폼별 연결 상태">
      {providers.map((provider) => {
        const status = statuses[provider] ?? fallbackStatus(provider);
        return (
          <div className={`provider-status-card ${selectedProvider === provider ? "active" : ""}`} key={provider}>
            <div>
              <strong>{provider === "soop" ? "SOOP" : "CHZZK"}</strong>
              <span className={`status-dot state-${status.state}`} />
            </div>
            <p>{status.message}</p>
            {status.channelId && <small>{status.channelId}</small>}
          </div>
        );
      })}
    </div>
  );
}

function readAuthNotice() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("auth") !== "chzzk") {
    return undefined;
  }

  if (params.get("status") === "ok") {
    return {
      kind: "success",
      title: "치지직 공식 로그인 완료",
      message: "이제 공식 Open API 모드에서 연결 버튼을 누르면 채팅 이벤트를 구독합니다."
    };
  }

  if (params.get("status") === "error") {
    return {
      kind: "error",
      title: "치지직 공식 로그인 실패",
      message: params.get("message") || "네이버 로그인 상태와 치지직 Developers의 Redirect URI를 확인한 뒤 다시 시도해주세요."
    };
  }

  return undefined;
}

function fallbackStatus(provider: ChatProvider): ProviderStatus {
  return {
    provider,
    sourceMode: provider === "soop" ? "unofficial" : "official",
    state: "idle",
    message: provider === "soop" ? "SOOP 연결 대기 중" : "치지직 연결 대기 중"
  };
}

function failureReasonLabel(reason: ProviderDiagnosticLog["reason"]) {
  switch (reason) {
    case "offline":
      return "오프라인";
    case "input_error":
      return "입력 오류";
    case "guest_chat_blocked":
      return "게스트 채팅 불가";
    case "network_blocked":
      return "네트워크 차단";
    case "protocol_changed":
      return "프로토콜 변경";
    case "auth_required":
      return "인증 필요";
    default:
      return "알 수 없음";
  }
}

function formatLogTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

function StatusBlock({ socketConnected, state, message }: { socketConnected: boolean; state: string; message: string }) {
  return (
    <div className="status-block">
      <div>
        <span className={`status-dot ${socketConnected ? "is-live" : ""}`} />
        서버 {socketConnected ? "연결됨" : "끊김"}
      </div>
      <div>
        <span className={`status-dot state-${state}`} />
        {message}
      </div>
    </div>
  );
}

function ProviderLogPanel({ logs }: { logs: ProviderDiagnosticLog[] }) {
  return (
    <section className="panel provider-log-panel">
      <div className="panel-title">
        <RadioTower size={20} />
        <h2>연결 로그</h2>
      </div>
      {logs.length === 0 ? (
        <div className="empty-state compact-empty">최근 연결 로그가 없습니다.</div>
      ) : (
        <div className="provider-log-list">
          {logs.slice(0, 8).map((log) => (
            <div className={`provider-log-row level-${log.level}`} key={log.id}>
              <div>
                <strong>{log.provider.toUpperCase()}</strong>
                {log.reason && <span>{failureReasonLabel(log.reason)}</span>}
                <time>{formatLogTime(log.createdAt)}</time>
              </div>
              <p>{log.message}</p>
              {log.channelId && <small>{log.channelId}</small>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange(value: number): void;
}) {
  return (
    <label className="range-field">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output>
        {value}
        {unit}
      </output>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
