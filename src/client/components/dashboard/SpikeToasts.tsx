import { Flame } from "lucide-react";

export function SpikeToasts({ toasts }: { toasts: Array<{ id: number; message: string }> }) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="spike-toast-stack" role="status">
      {toasts.map((toast) => (
        <div className="spike-toast" key={toast.id}>
          <Flame size={15} />
          {toast.message}
        </div>
      ))}
    </div>
  );
}
