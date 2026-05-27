import * as React from "react";
import {
  Flame,
  Refrigerator,
  LayoutGrid,
  RectangleHorizontal,
  AppWindow,
  Boxes,
  Car,
  Sliders,
  Shirt,
  BedDouble,
  Frame,
  PawPrint,
  UtensilsCrossed,
  TreePine,
  Microwave,
  Fan,
  Blinds,
  Warehouse,
  Tag,
  type LucideIcon,
} from "lucide-react";

// [addon-icons 2026-05-27] Name-based lucide icon lookup for add-on rows
// in the quote builder and the pricing-settings page. Patterns are
// matched case-insensitively in declaration order — first hit wins, so
// list more specific patterns before generic ones.
//
// New tenant-custom add-ons fall back to the generic Tag icon. If we
// ever ship per-addon icon configuration (column on pricing_addons),
// route the explicit choice through here and use this map only as the
// default. Keep the map readable — one row per add-on family.
// [addon-icons audit 2026-05-27] Replaced the first-pass picks that
// didn't read intuitively:
//   Oven    ChefHat   → Flame       (heat source, not a chef hat)
//   Cabinet Archive   → LayoutGrid  (grid of cabinet doors)
//   Window  RectHoriz → AppWindow   (literal window icon)
//   Basement Layers   → Boxes       (storage-room intent)
// Baseboards keeps RectangleHorizontal — closest match to a long flat
// board. Window-tracks keeps Frame (frame within a window).
const ICON_RULES: Array<{ pattern: RegExp; icon: LucideIcon }> = [
  { pattern: /\boven\b/i,                       icon: Flame },
  { pattern: /\brefrigerator\b|\bfridge\b/i,    icon: Refrigerator },
  { pattern: /\bcabinet/i,                      icon: LayoutGrid },
  { pattern: /\bwindow tracks?\b/i,             icon: Frame },
  { pattern: /\bwindow/i,                       icon: AppWindow },
  { pattern: /\bbaseboard/i,                    icon: RectangleHorizontal },
  { pattern: /\bbasement/i,                     icon: Boxes },
  { pattern: /\bparking/i,                      icon: Car },
  { pattern: /manual adjustment|adjustment/i,   icon: Sliders },
  { pattern: /\blaundry|wash.*fold\b/i,         icon: Shirt },
  { pattern: /\bmake beds?\b|\bbed making\b/i,  icon: BedDouble },
  { pattern: /\bpet (hair|cleanup|dander)\b/i,  icon: PawPrint },
  { pattern: /\bwash dishes|\bdish(es)?\b/i,    icon: UtensilsCrossed },
  { pattern: /\bpatio|\bbalcony/i,              icon: TreePine },
  { pattern: /\bmicrowave/i,                    icon: Microwave },
  { pattern: /\bceiling fan|\bfan dusting\b/i,  icon: Fan },
  { pattern: /\bblinds?\b/i,                    icon: Blinds },
  { pattern: /\bgarage/i,                       icon: Warehouse },
];

export function getAddonIcon(name: string): LucideIcon {
  for (const rule of ICON_RULES) {
    if (rule.pattern.test(name)) return rule.icon;
  }
  return Tag;
}

/** Convenience renderer — keeps call sites short. */
export function AddonIcon({ name, size = 14, color = "#6B6860" }: { name: string; size?: number; color?: string }) {
  const Icon = getAddonIcon(name);
  return <Icon size={size} color={color} />;
}
