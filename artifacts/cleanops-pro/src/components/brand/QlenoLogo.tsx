import { QlenoMark } from "./QlenoMark";

const SIZES = {
  sm: { mark: 20, text: 16 },
  md: { mark: 28, text: 22 },
  lg: { mark: 40, text: 32 },
};

interface QlenoLogoProps {
  size?: "sm" | "md" | "lg";
  theme?: "light" | "dark";
  layout?: "horizontal" | "stacked";
  className?: string;
}

export function QlenoLogo({
  size = "md",
  theme = "light",
  layout = "horizontal",
  className,
}: QlenoLogoProps) {
  const { mark: markSize, text: textSize } = SIZES[size];
  const markTheme = theme === "dark" ? "dark" : "mint";
  const textColor = theme === "dark" ? "#FFFFFF" : "#0A0E1A";

  if (layout === "stacked") {
    return (
      <div
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}
        className={className}
      >
        <QlenoMark size={markSize} theme={markTheme} />
        <span
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontWeight: 700,
            fontSize: textSize,
            color: textColor,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          qleno
        </span>
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 10 }}
      className={className}
    >
      <QlenoMark size={markSize} theme={markTheme} />
      <span
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 700,
          fontSize: textSize,
          color: textColor,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        qleno
      </span>
    </div>
  );
}
