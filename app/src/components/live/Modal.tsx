'use client';
import { useEffect } from 'react';

export function Modal({ open, onClose, children, width = 460 }: { open: boolean; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="pop-in relative max-h-[92vh] w-full overflow-y-auto rounded-2xl border border-line bg-[#0c0e13] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-white/5 hover:text-ink" aria-label="Close">
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}
