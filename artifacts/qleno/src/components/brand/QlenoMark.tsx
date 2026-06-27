interface QlenoMarkProps {
  size?: number;
  className?: string;
}

export function QlenoMark({ size = 32, className }: QlenoMarkProps) {
  return (
    <img
      src="/images/logo-mark.png"
      width={size}
      height={size}
      alt="Qleno"
      className={className}
      style={{
        flexShrink: 0,
        display: "block",
        borderRadius: Math.round(size * 0.22),
        objectFit: "cover",
      }}
    />
  );
}
