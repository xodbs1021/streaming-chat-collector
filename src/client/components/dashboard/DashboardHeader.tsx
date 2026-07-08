import { Moon, Sun } from "lucide-react";

export function DashboardHeader({ theme, onToggleTheme }: { theme: "dark" | "light"; onToggleTheme(): void }) {
  return (
    <header className="admin-header">
      <div>
        <p className="eyebrow">CHAT ANALYTICS</p>
        <h1>채팅 분석 대시보드</h1>
      </div>
      <div className="admin-header-actions">
        <button
          className="ghost-button"
          onClick={onToggleTheme}
          title={theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"}
          type="button"
        >
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          {theme === "light" ? "다크" : "라이트"}
        </button>
        <a className="ghost-button" href="/admin">
          관리 화면
        </a>
        <a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">
          OBS 오버레이
        </a>
      </div>
    </header>
  );
}
