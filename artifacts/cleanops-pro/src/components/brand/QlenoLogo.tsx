import { QlenoMark } from "./QlenoMark";

interface QlenoLogoProps {
  size?: "sm" | "md" | "lg";
  theme?: "light" | "dark";
  layout?: "horizontal" | "stacked";
  className?: string;
}

// Size config: r = circle radius, qFont = Q size inside circle, wordFont = "leno" size
const SIZES = {
  sm: { r: 10, qFont: 12, wordFont: 14 },
  md: { r: 14, qFont: 16, wordFont: 18 },
  lg: { r: 18, qFont: 21, wordFont: 22 },
};

// Renders the circle + Q + left-side mint shine lines (used in horizontal layout)
function CircleMark({ r, qFont }: { r: number; qFont: number }) {
  // Layout: left padding = r (for shine lines), circle diameter = 2r, right pad = 4
  const W  = r * 3 + 4;
  const H  = r * 2 + 8;
  const cx = r * 2;       // circle center x (leaves r on left for shine lines)
  const cy = r + 4;       // circle center y (vertically centered)

  const shineLen   = r * 0.62;
  const cos30      = 0.866;
  const sin30      = 0.5;
  const cos45      = 0.7071;
  const sw         = Math.max(1.2, r * 0.135); // stroke-width proportional to r

  // 10 o'clock position on circle edge (150° from +x axis)
  const ulx = cx - r * cos30;
  const uly = cy - r * sin30;
  // 8 o'clock position on circle edge (210°)
  const llx = cx - r * cos30;
  const lly = cy + r * sin30;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, display: "block" }}
    >
      {/* Mint circle */}
      <circle cx={cx} cy={cy} r={r} fill="#00C9A0" />

      {/* Shine lines: mint green, radiate left from circle edge */}
      {/* Upper-left: from 10 o'clock, 45° up-left */}
      <line
        x1={ulx} y1={uly}
        x2={ulx - shineLen * cos45} y2={uly - shineLen * cos45}
        stroke="#00C9A0" strokeWidth={sw} strokeLinecap="round"
      />
      {/* Left: perfectly horizontal from 9 o'clock */}
      <line
        x1={cx - r} y1={cy}
        x2={cx - r - shineLen} y2={cy}
        stroke="#00C9A0" strokeWidth={sw} strokeLinecap="round"
      />
      {/* Lower-left: from 8 o'clock, 45° down-left */}
      <line
        x1={llx} y1={lly}
        x2={llx - shineLen * cos45} y2={lly + shineLen * cos45}
        stroke="#00C9A0" strokeWidth={sw} strokeLinecap="round"
      />

      {/* Bold white Q inside circle */}
      <text
        x={cx}
        y={cy}
        fontFamily="'Plus Jakarta Sans', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize={qFont}
        fill="white"
        textAnchor="middle"
        dominantBaseline="central"
      >
        Q
      </text>
    </svg>
  );
}

export function QlenoLogo({
  size = "md",
  theme = "light",
  layout = "horizontal",
  className,
}: QlenoLogoProps) {
  const { r, qFont, wordFont } = SIZES[size];
  const textColor = theme === "dark" ? "#FFFFFF" : "#0F1117";

  if (layout === "stacked") {
    const markSize = r * 2.4;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: r * 0.6,
        }}
        className={className}
      >
        <QlenoMark size={markSize} />
        <span
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontWeight: 600,
            fontSize: wordFont,
            color: textColor,
            letterSpacing: "2px",
            lineHeight: 1,
          }}
        >
          QLENO
        </span>
      </div>
    );
  }

  // Horizontal layout: CircleMark + "leno" text
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 4 }}
      className={className}
    >
      <CircleMark r={r} qFont={qFont} />
      <span
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 600,
          fontSize: wordFont,
          color: textColor,
          letterSpacing: "-0.5px",
          lineHeight: 1,
        }}
      >
        leno
      </span>
    </div>
  );
}
