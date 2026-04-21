interface QlenoMarkProps {
  size?: number;
  className?: string;
}

export function QlenoMark({ size = 32, className }: QlenoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0, display: "block" }}
    >
      {/* Mint green rounded square */}
      <rect width="64" height="64" rx="14" fill="#00C9A0" />

      {/* Three white shine lines — short, crisp rays on the left */}
      {/* Upper-left (~10 o'clock), 45° diagonal */}
      <line
        x1="23" y1="21"
        x2="14" y2="12"
        stroke="white" strokeWidth="3" strokeLinecap="round"
      />
      {/* Left — perfectly horizontal */}
      <line
        x1="20" y1="32"
        x2="9"  y2="32"
        stroke="white" strokeWidth="3" strokeLinecap="round"
      />
      {/* Lower-left (~8 o'clock), 45° diagonal */}
      <line
        x1="23" y1="43"
        x2="14" y2="52"
        stroke="white" strokeWidth="3" strokeLinecap="round"
      />

      {/* Bold white Q — centered right to balance shine lines */}
      <text
        x="41"
        y="32"
        fontFamily="'Plus Jakarta Sans', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="36"
        fill="white"
        textAnchor="middle"
        dominantBaseline="central"
      >
        Q
      </text>
    </svg>
  );
}
