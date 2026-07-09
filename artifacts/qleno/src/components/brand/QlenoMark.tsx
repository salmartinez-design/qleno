interface QlenoMarkProps {
  size?: number;
  className?: string;
}

export function QlenoMark({ size = 32, className }: QlenoMarkProps) {
  const r = Math.round(size * 0.22);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0, display: "block" }}
      aria-label="Qleno"
    >
      <rect width="64" height="64" rx={r * (64 / size)} fill="#00C9A0" />
      <line x1="23" y1="21" x2="14" y2="12" stroke="white" strokeWidth="3" strokeLinecap="round" />
      <line x1="20" y1="32" x2="9"  y2="32" stroke="white" strokeWidth="3" strokeLinecap="round" />
      <line x1="23" y1="43" x2="14" y2="52" stroke="white" strokeWidth="3" strokeLinecap="round" />
      <text
        x="41" y="32"
        fontFamily="'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="36"
        fill="white"
        textAnchor="middle"
        dominantBaseline="central"
      >Q</text>
    </svg>
  );
}
