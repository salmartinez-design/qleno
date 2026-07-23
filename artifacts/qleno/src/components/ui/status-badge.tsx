import * as React from "react";

export type StatusType =
  | 'scheduled' | 'in_progress' | 'complete' | 'cancelled'
  | 'draft' | 'sent' | 'paid' | 'overdue' | 'active' | 'inactive';

interface StatusBadgeProps {
  status: StatusType;
  className?: string;
}

const BADGE_STYLES: Record<string, React.CSSProperties> = {
  complete:    { background: '#0F2A1A', color: '#4ADE80', border: '1px solid #0F7A63' },
  paid:        { background: '#0F2A1A', color: '#4ADE80', border: '1px solid #0F7A63' },
  active:      { background: '#0F2A1A', color: '#4ADE80', border: '1px solid #0F7A63' },
  scheduled:   { background: '#0F1E2A', color: '#60A5FA', border: '1px solid #2F3646' },
  sent:        { background: '#0F1E2A', color: '#60A5FA', border: '1px solid #2F3646' },
  in_progress: { background: '#2A1F0A', color: '#FBBF24', border: '1px solid #B45309' },
  overdue:     { background: '#2A0F0F', color: '#F87171', border: '1px solid #B3261E' },
  cancelled:   { background: '#2A0F0F', color: '#F87171', border: '1px solid #B3261E' },
  draft:       { background: '#1A1A1A', color: '#7A7873', border: '1px solid #333' },
  inactive:    { background: '#1A1A1A', color: '#7A7873', border: '1px solid #333' },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const style = BADGE_STYLES[status] || BADGE_STYLES.draft;
  const label = status.replace('_', ' ');
  return (
    <span
      className={className}
      style={{
        ...style,
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
