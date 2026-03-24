import { QlenoMark } from "./QlenoMark";

interface QlenoLogoProps {
  size?: "sm" | "md" | "lg";
  theme?: "light" | "dark";
  layout?: "horizontal" | "stacked";
  className?: string;
}

const SIZES = {
  sm: { markSize: 22, wordFont: 14 },
  md: { markSize: 28, wordFont: 18 },
  lg: { markSize: 34, wordFont: 22 },
};

export function QlenoLogo({
  size = "md",
  theme = "light",
  layout = "horizontal",
  className,
}: QlenoLogoProps) {
  const { markSize, wordFont } = SIZES[size];
  const textColor = theme === "dark" ? "#FFFFFF" : "#0F1117";

  if (layout === "stacked") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: markSize * 0.25,
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

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 7 }}
      className={className}
    >
      <QlenoMark size={markSize} />
      <span
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 700,
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
