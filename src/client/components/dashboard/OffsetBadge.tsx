import { Clock3 } from "lucide-react";
import type { OffsetBadgeView } from "./offsetBadgeText";

/**
 * SOOP↔치지직 싱크 배지 — 라이브(offset:live)·병합(offset.json)에서 계산한 문구를 그대로 렌더한다.
 * tone에 따라 색만 다르고, 문구는 순수 포매터(offsetBadge.ts)가 정한다(프레젠테이션은 pure).
 */
export function OffsetBadge({ view }: { view: OffsetBadgeView }) {
  return (
    <span className={`offset-badge offset-${view.tone}`} title="SOOP 채팅을 치지직 시각에 맞춘 보정값">
      <Clock3 size={14} />
      {view.text}
    </span>
  );
}
