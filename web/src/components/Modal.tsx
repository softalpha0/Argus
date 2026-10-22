import { useEffect, type ReactNode } from 'react';

export default function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className="grid max-h-[90vh] w-full max-w-md gap-4 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
