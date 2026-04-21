import { useEffect } from "react";
import { useLocation } from "wouter";

interface Props {
  onOpenSearch: () => void;
  onNewJob?: () => void;
}

const SHORTCUTS = [
  { key: 'Q', label: 'New Quote',      path: '/quotes/new' },
  { key: 'D', label: 'Dispatch Board', path: '/jobs' },
  { key: 'E', label: 'Employees',      path: '/employees' },
  { key: 'C', label: 'New Customer',   path: '/customers/new' },
  { key: 'I', label: 'New Invoice',    path: '/invoices?new=1' },
  { key: 'P', label: 'Payroll',        path: '/payroll' },
  { key: 'R', label: 'Insights',       path: '/reports/insights' },
];

export function KeyboardShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9998, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'Plus Jakarta Sans', sans-serif" }}
      onClick={onClose}>
      <div style={{ background:'#FFFFFF', borderRadius:14, padding:'28px 32px', width:360, boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e => e.stopPropagation()}>
        <h3 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 20px 0' }}>Keyboard Shortcuts</h3>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <ShortcutRow k="⇧J" label="New Job"/>
          <ShortcutRow k="⇧/" label="Search"/>
          {SHORTCUTS.map(s => <ShortcutRow key={s.key} k={`⇧${s.key}`} label={s.label}/>)}
          <ShortcutRow k="?" label="Show this overlay"/>
          <ShortcutRow k="ESC" label="Close / Cancel"/>
        </div>
        <p style={{ fontSize:11, color:'#9E9B94', margin:'16px 0 0 0', textAlign:'center' }}>Press ESC to close</p>
      </div>
    </div>
  );
}

function ShortcutRow({ k, label }: { k: string; label: string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <span style={{ fontSize:13, color:'#1A1917' }}>{label}</span>
      <kbd style={{ fontSize:12, fontWeight:700, border:'1px solid #E5E2DC', borderRadius:5, padding:'3px 8px', color:'#6B7280', background:'#F9F9F9', fontFamily:"'Plus Jakarta Sans', sans-serif" }}>{k}</kbd>
    </div>
  );
}

export function useKeyboardShortcuts({ onOpenSearch, onNewJob }: Props) {
  const [, navigate] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || target.isContentEditable
        || target.classList.contains('ProseMirror')
        || target.getAttribute('role') === 'textbox';
      if (isInput) {
        if (e.key === 'Escape') target.blur();
        return;
      }

      if (!e.shiftKey) return;

      if (e.key === '/' || e.key === '?') { e.preventDefault(); onOpenSearch(); return; }
      if (e.key === 'J') { e.preventDefault(); onNewJob?.(); return; }

      for (const s of SHORTCUTS) {
        if (e.key === s.key) { e.preventDefault(); navigate(s.path); return; }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpenSearch, onNewJob, navigate]);
}
