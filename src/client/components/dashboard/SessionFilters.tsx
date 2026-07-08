export function SessionFilters({
  provider,
  date,
  onProviderChange,
  onDateChange
}: {
  provider: "all" | "chzzk" | "soop";
  date: string;
  onProviderChange(provider: "all" | "chzzk" | "soop"): void;
  onDateChange(date: string): void;
}) {
  return (
    <div className="session-filters">
      <select value={provider} onChange={(event) => onProviderChange(event.target.value as "all" | "chzzk" | "soop")}>
        <option value="all">전체 플랫폼</option>
        <option value="chzzk">CHZZK</option>
        <option value="soop">SOOP</option>
      </select>
      <input value={date} onChange={(event) => onDateChange(event.target.value)} type="date" />
    </div>
  );
}

export function SessionMetaEditor({
  displayName,
  onDisplayNameChange,
  onSave
}: {
  displayName: string;
  onDisplayNameChange(value: string): void;
  onSave(): void;
}) {
  return (
    <form
      className="session-meta-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        <span>세션 이름 · Enter로 저장</span>
        <input value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} placeholder="표시 이름" />
      </label>
    </form>
  );
}
