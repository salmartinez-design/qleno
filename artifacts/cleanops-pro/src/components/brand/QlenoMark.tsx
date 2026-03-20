interface QlenoMarkProps {
  size?: number;
  theme?: "mint" | "dark" | "light";
  className?: string;
}

export function QlenoMark({ size = 32, theme = "mint", className }: QlenoMarkProps) {
  const stroke = theme === "light" ? "#0A0E1A" : "#00C9A0";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <g stroke={stroke} strokeLinecap="round" fill="none" strokeWidth="5.5">
        <path d="M43,38 A19,19 0 1 0 46,30" />
        <line x1="43" y1="38" x2="51" y2="52" />
        <line x1="45" y1="56" x2="57" y2="49" />
      </g>
    </svg>
  );
}
