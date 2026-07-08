import { Flame, Save, Tag, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { HighlightAnnotation, HighlightCandidate, HighlightCategory, HighlightLevel, HighlightSummary } from "../../../shared/types";
import { HIGHLIGHT_CATEGORIES } from "./constants";
import { formatCandidateRange, formatDuration, formatTime } from "./format";
import { categoryLabel, getAnnotationRange, getSavedAnnotations, levelLabel } from "./highlight";

export function HighlightMemoPanel({
  summary,
  selectedCandidate,
  saveState,
  onClearSelection,
  onDeleteAnnotation,
  onFocusAnnotation,
  onSave
}: {
  summary: HighlightSummary;
  selectedCandidate?: HighlightCandidate;
  saveState: Record<string, "saving" | "saved" | "error">;
  onClearSelection(): void;
  onDeleteAnnotation(sessionId: string, candidateId: string): Promise<void>;
  onFocusAnnotation(annotation: HighlightAnnotation): void;
  onSave(candidate: HighlightCandidate, category: HighlightCategory, note: string): Promise<void>;
}) {
  const savedAnnotations = getSavedAnnotations(summary.annotations);
  const annotationSessionId = summary.session?.sessionId;

  return (
    <section className="panel highlight-panel">
      <div className="highlight-panel-header">
        <div className="panel-title">
          <Flame size={20} />
          <h2>하이라이트 메모</h2>
        </div>
        <div className="threshold-strip">
          <span>평균 {summary.thresholds.activeWindowMean}</span>
          <span>P95 {summary.thresholds.p95}</span>
          <span>P99 {summary.thresholds.p99}</span>
          <strong>{savedAnnotations.length}개 메모</strong>
          {selectedCandidate && (
            <button className="ghost-button compact-button clear-selection-button" onClick={onClearSelection} type="button">
              <X size={15} />
              선택 해제
            </button>
          )}
        </div>
      </div>

      {!summary.canSaveAnnotations && (
        <div className="highlight-save-notice">
          <Tag size={16} />
          저장 가능한 세션 없음
        </div>
      )}

      {selectedCandidate ? (
        <HighlightMemoEditor
          candidate={selectedCandidate}
          canSave={summary.canSaveAnnotations}
          saveState={saveState[selectedCandidate.id]}
          onClearSelection={onClearSelection}
          onDelete={selectedCandidate.annotation ? () => onDeleteAnnotation(selectedCandidate.sessionId, selectedCandidate.id) : undefined}
          onSave={onSave}
        />
      ) : (
        <div className="empty-state compact-empty">선택된 윈도우 구간이 없습니다.</div>
      )}

      <div className="saved-memo-section">
        <h3>저장된 메모</h3>
        {savedAnnotations.length === 0 ? (
          <div className="empty-state compact-empty">저장된 메모가 없습니다.</div>
        ) : (
          <div className="saved-memo-list">
            {savedAnnotations.map((annotation) => (
              <SavedMemoRow
                annotation={annotation}
                canDelete={Boolean(annotationSessionId)}
                key={annotation.candidateId}
                onDelete={annotationSessionId ? () => onDeleteAnnotation(annotationSessionId, annotation.candidateId) : undefined}
                onFocus={onFocusAnnotation}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SavedMemoRow({
  annotation,
  canDelete,
  onDelete,
  onFocus
}: {
  annotation: HighlightAnnotation;
  canDelete: boolean;
  onDelete?(): void;
  onFocus(annotation: HighlightAnnotation): void;
}) {
  const range = getAnnotationRange(annotation);

  return (
    <div className="saved-memo-row">
      <button className="saved-memo-focus" onClick={() => onFocus(annotation)} type="button">
        <div>
          <strong>{range ? `${formatTime(range.startAt)} ~ ${formatTime(range.endAt)}` : annotation.candidateId}</strong>
          <span>
            {categoryLabel(annotation.category)}
            {range ? ` · ${range.windowSec}초` : ""}
          </span>
        </div>
        {(annotation.peakCount !== undefined || annotation.totalMessages !== undefined) && (
          <div className="saved-memo-meta">
            {annotation.peakCount !== undefined && <span>Peak {annotation.peakCount}</span>}
            {annotation.totalMessages !== undefined && <span>총 {annotation.totalMessages}</span>}
            {annotation.topTerms?.slice(0, 3).map((term) => (
              <span key={term.label}>{term.label}</span>
            ))}
          </div>
        )}
        <p>{annotation.note || "메모 없음"}</p>
      </button>
      <button className="ghost-button compact-button memo-delete-button" disabled={!canDelete} onClick={onDelete} type="button">
        <Trash2 size={15} />
        삭제
      </button>
    </div>
  );
}

function HighlightMemoEditor({
  candidate,
  canSave,
  saveState,
  onClearSelection,
  onDelete,
  onSave
}: {
  candidate: HighlightCandidate;
  canSave: boolean;
  saveState?: "saving" | "saved" | "error";
  onClearSelection(): void;
  onDelete?(): void;
  onSave(candidate: HighlightCandidate, category: HighlightCategory, note: string): Promise<void>;
}) {
  const [category, setCategory] = useState<HighlightCategory>(candidate.annotation?.category ?? "other");
  const [note, setNote] = useState(candidate.annotation?.note ?? "");

  useEffect(() => {
    setCategory(candidate.annotation?.category ?? "other");
    setNote(candidate.annotation?.note ?? "");
  }, [candidate.annotation?.category, candidate.annotation?.note, candidate.id]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave(candidate, category, note);
  }

  return (
    <form className={`highlight-row memo-editor-row level-${candidate.level}`} onSubmit={submit}>
      <div className="highlight-main">
        <div className="highlight-time">
          <LevelBadge level={candidate.level} />
          <strong>{formatCandidateRange(candidate)}</strong>
          <span>{formatDuration(candidate.durationSec)}</span>
        </div>
        <div className="highlight-stats">
          <span>Peak {candidate.peakCount}</span>
          <span>{candidate.score}x</span>
          <span>참여자 {candidate.uniqueChatters}</span>
          <span>총 {candidate.totalMessages}</span>
        </div>
        <div className="term-chip-list">
          {candidate.topTerms.length === 0 ? (
            <span className="muted-chip">단어 없음</span>
          ) : (
            candidate.topTerms.map((term) => (
              <span className="term-chip" key={term.label}>
                {term.label} {term.count}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="highlight-editor">
        <select disabled={!canSave} value={category} onChange={(event) => setCategory(event.target.value as HighlightCategory)}>
          {HIGHLIGHT_CATEGORIES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input disabled={!canSave} value={note} onChange={(event) => setNote(event.target.value)} placeholder="어떤 하이라이트였는지 메모" />
        <button className="ghost-button compact-button" disabled={!canSave || saveState === "saving"} type="submit">
          <Save size={15} />
          {saveState === "saving" ? "저장 중" : saveState === "saved" ? "저장됨" : saveState === "error" ? "실패" : "저장"}
        </button>
        {onDelete && (
          <button className="ghost-button compact-button memo-delete-button" disabled={saveState === "saving"} onClick={onDelete} type="button">
            <Trash2 size={15} />
            삭제
          </button>
        )}
        <button className="ghost-button compact-button" onClick={onClearSelection} type="button">
          <X size={15} />
          해제
        </button>
      </div>
    </form>
  );
}

function LevelBadge({ level }: { level: HighlightLevel }) {
  return <span className={`level-badge level-${level}`}>{levelLabel(level)}</span>;
}
