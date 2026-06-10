import type { CSSProperties, ReactNode } from "react";

// [employee-avatar 2026-06-10] One emblem everywhere a person shows up. Renders
// the uploaded profile photo (users.avatar_url) when present, else the brand
// initials chip as fallback. `badge` overlays a corner indicator (e.g. the
// dispatch "clocked in" dot). Size drives the font automatically.
export function EmployeeAvatar({
  name,
  avatarUrl,
  size = 40,
  fontSize,
  badge,
  title,
}: {
  name?: string | null;
  avatarUrl?: string | null;
  size?: number;
  fontSize?: number;
  badge?: ReactNode;
  title?: string;
}) {
  const initials =
    (name || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    position: "relative",
  };

  const inner = avatarUrl ? (
    <img
      src={avatarUrl}
      alt={name || ""}
      title={title}
      style={{ ...base, objectFit: "cover", backgroundColor: "var(--brand-dim)", display: "block" }}
    />
  ) : (
    <div
      title={title}
      style={{
        ...base,
        backgroundColor: "var(--brand-dim)",
        color: "var(--brand)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: fontSize ?? Math.round(size * 0.36),
        fontWeight: 700,
      }}
    >
      {initials}
    </div>
  );

  if (!badge) return inner;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      {inner}
      {badge}
    </div>
  );
}
