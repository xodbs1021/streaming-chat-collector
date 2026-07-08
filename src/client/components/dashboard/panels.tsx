import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import type { AnalyticsRankItem, WindowComparisonSummary } from "../../../shared/types";

export function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="metric-tile">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <em className="metric-detail">{detail}</em>}
    </div>
  );
}

export function RankList({ items }: { items: AnalyticsRankItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  if (items.length === 0) {
    return <div className="empty-state">데이터 없음</div>;
  }

  return (
    <div className="rank-list">
      {items.map((item) => (
        <div className="rank-row" key={item.label}>
          <span>{item.label}</span>
          <div className="rank-bar">
            <i style={{ width: `${Math.max(6, (item.count / max) * 100)}%` }} />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

export function WindowComparisonPanel({
  comparison
}: {
  comparison: WindowComparisonSummary;
}) {
  return (
    <section className="panel comparison-panel">
      <div className="panel-title">
        <BarChart3 size={20} />
        <h2>윈도우 비교</h2>
      </div>
      {comparison.items.length === 0 ? (
        <div className="empty-state compact-empty">비교할 데이터가 없습니다.</div>
      ) : (
        <div className="comparison-grid">
          {comparison.items.map((item) => (
            <div className="comparison-card" key={item.windowSec}>
              <strong>{item.windowSec}초</strong>
              <span>평균 {item.activeWindowMean}</span>
              <span>P95 {item.p95}</span>
              <span>피크 {item.max}</span>
              <span>후보 {item.candidateWindowCount}</span>
              <span>강한 후보 {item.strongCount}</span>
              <em>{item.topScore}x</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
