import { useState, useEffect, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Edit2, ChevronDown } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── ZONE COLORS ─────────────────────────────────────────────────────────────
const ZONE_COLORS = [
  { label: "Pink",   value: "#FF69B4" },
  { label: "Blue",   value: "#5B9BD5" },
  { label: "Green",  value: "#2D6A4F" },
  { label: "Purple", value: "#7F77DD" },
  { label: "Orange", value: "#F97316" },
  { label: "Red",    value: "#E53E3E" },
  { label: "Teal",   value: "#0D9488" },
  { label: "Yellow", value: "#EAB308" },
];

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Zone {
  id: number;
  name: string;
  color: string;
  zip_codes: string[];
  is_active: boolean;
  sort_order: number;
  location: string;
  employee_count: number;
  jobs_this_month: number;
  employees: { id: number; name: string }[];
}

type LocationFilter = "all" | "oak_lawn" | "schaumburg";

function LocationBadge({ loc }: { loc: string }) {
  const isSchaumburg = loc === "schaumburg";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px", borderRadius: 10, fontSize: 10, fontFamily: FF, fontWeight: 600,
      backgroundColor: isSchaumburg ? "#2D6A4F" : "#5B9BD5",
      color: "#FFFFFF", whiteSpace: "nowrap", letterSpacing: "0.03em",
    }}>
      {isSchaumburg ? "Schaumburg" : "Oak Lawn"}
    </span>
  );
}

interface Employee { id: number; name: string; role: string; }

interface ZoneStats {
  id: number;
  name: string;
  color: string;
  job_count: number;
  revenue: number;
  avg_bill: number;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmt$(n: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n); }
function useIsMobile() { const [m, setM] = useState(window.innerWidth < 768); useEffect(() => { const h = () => setM(window.innerWidth < 768); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []); return m; }

// ─── ZIP TAG INPUT ────────────────────────────────────────────────────────────
function ZipTagInput({ zips, onChange }: { zips: string[]; onChange: (z: string[]) => void }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");

  const addZip = (raw: string) => {
    const z = raw.trim().replace(/\D/g, "").slice(0, 5);
    if (!z) return;
    if (z.length !== 5) { setErr("Zip codes must be 5 digits"); return; }
    if (zips.includes(z)) { setErr("Already added"); return; }
    setErr("");
    onChange([...zips, z]);
    setInput("");
  };

  const removeZip = (z: string) => onChange(zips.filter(x => x !== z));

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#FAFAF9", minHeight: 44 }}>
        {zips.map(z => (
          <span key={z} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", backgroundColor: "#E8F0F8", color: "#1D4ED8", borderRadius: 12, fontSize: 12, fontFamily: FF, fontWeight: 500 }}>
            {z}
            <button onClick={() => removeZip(z)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6B7280", display: "flex", alignItems: "center" }}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => { setInput(e.target.value); setErr(""); }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addZip(input); } }}
          onBlur={() => { if (input) addZip(input); }}
          placeholder={zips.length === 0 ? "Type a zip code, press Enter" : "Add another..."}
          style={{ border: "none", outline: "none", background: "transparent", fontSize: 13, fontFamily: FF, color: "#1A1917", minWidth: 140, flex: 1 }}
        />
      </div>
      {err && <p style={{ fontSize: 11, color: "#EF4444", margin: "4px 0 0", fontFamily: FF }}>{err}</p>}
      <p style={{ fontSize: 11, color: "#9E9B94", margin: "4px 0 0", fontFamily: FF }}>{zips.length} zip code{zips.length !== 1 ? "s" : ""} added</p>
    </div>
  );
}

// ─── EMPLOYEE MULTI-SELECT ────────────────────────────────────────────────────
function EmployeeMultiSelect({ employees, selected, onChange }: {
  employees: Employee[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const toggle = (id: number) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };

  const selectedEmps = employees.filter(e => selected.includes(e.id));

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen(p => !p)}
        style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, cursor: "pointer", backgroundColor: "#FAFAF9", minHeight: 40 }}
      >
        {selectedEmps.length === 0 && (
          <span style={{ fontSize: 13, color: "#9E9B94", fontFamily: FF }}>Select employees...</span>
        )}
        {selectedEmps.map(e => (
          <span key={e.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", backgroundColor: "#F0EEE9", color: "#1A1917", borderRadius: 12, fontSize: 12, fontFamily: FF }}>
            {e.name}
            <button onClick={ev => { ev.stopPropagation(); toggle(e.id); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6B7280", display: "flex", alignItems: "center" }}>
              <X size={10} />
            </button>
          </span>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <ChevronDown size={14} style={{ color: "#9E9B94", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }} />
        </div>
      </div>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 50, maxHeight: 180, overflowY: "auto" }}>
          {employees.length === 0 && (
            <div style={{ padding: "12px 14px", fontSize: 13, color: "#9E9B94", fontFamily: FF }}>No employees found</div>
          )}
          {employees.map(e => (
            <div
              key={e.id}
              onClick={() => toggle(e.id)}
              style={{ padding: "9px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: FF, color: "#1A1917", backgroundColor: selected.includes(e.id) ? "#EEF4FB" : "transparent" }}
              onMouseEnter={el => (el.currentTarget.style.backgroundColor = selected.includes(e.id) ? "#EEF4FB" : "#F7F6F3")}
              onMouseLeave={el => (el.currentTarget.style.backgroundColor = selected.includes(e.id) ? "#EEF4FB" : "transparent")}
            >
              <div style={{ width: 16, height: 16, border: selected.includes(e.id) ? "2px solid var(--brand)" : "2px solid #E5E2DC", borderRadius: 4, backgroundColor: selected.includes(e.id) ? "var(--brand)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {selected.includes(e.id) && <div style={{ width: 8, height: 8, backgroundColor: "#FFFFFF", borderRadius: 2 }} />}
              </div>
              {e.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ZONE DRAWER (Desktop: right panel for create/edit) ───────────────────────
function ZoneDrawer({ zone, employees, open, onClose, onSave }: {
  zone: Zone | null;
  employees: Employee[];
  open: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#5B9BD5");
  const [zips, setZips] = useState<string[]>([]);
  const [empIds, setEmpIds] = useState<number[]>([]);
  const [location, setLocation] = useState<"oak_lawn" | "schaumburg">("oak_lawn");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (zone) {
      setName(zone.name);
      setColor(zone.color);
      setZips(zone.zip_codes || []);
      setEmpIds(zone.employees.map(e => e.id));
      setLocation((zone.location as any) || "oak_lawn");
    } else {
      setName("");
      setColor("#5B9BD5");
      setZips([]);
      setEmpIds([]);
      setLocation("oak_lawn");
    }
  }, [zone, open]);

  const save = async () => {
    if (!name.trim()) { toast({ title: "Zone name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), color, zip_codes: zips, employee_ids: empIds, location };
      const url = zone ? `${API}/api/zones/${zone.id}` : `${API}/api/zones`;
      const method = zone ? "PATCH" : "POST";
      const r = await fetch(url, { method, headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (err.error === "zip_conflict" && err.conflicts?.length) {
          const first = err.conflicts[0];
          toast({ title: "Zip code conflict", description: `${first.zip} is already in "${first.existingZone}"`, variant: "destructive" });
          return;
        }
        throw new Error(err.error || "Save failed");
      }
      toast({ title: zone ? "Zone updated" : "Zone created" });
      onSave();
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save zone", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {open && <div onClick={onClose} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.35)", zIndex: 40 }} />}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 400,
        backgroundColor: "#FFFFFF", borderLeft: "1px solid #E5E2DC",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.08)",
        zIndex: 50, overflowY: "auto", padding: "28px 28px",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.25s cubic-bezier(0.32,0.72,0,1)",
        display: "flex", flexDirection: "column", gap: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ fontFamily: FF, fontWeight: 700, fontSize: 18, color: "#1A1917", margin: 0 }}>
            {zone ? "Edit Zone" : "Add Zone"}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4, display: "flex", alignItems: "center" }}>
            <X size={18} />
          </button>
        </div>

        {/* Zone Name */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zone Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Southwest Zone"
            style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontFamily: FF, fontSize: 13, color: "#1A1917", outline: "none", backgroundColor: "#FAFAF9" }}
          />
        </div>

        {/* Location */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Location</label>
          <div style={{ display: "flex", borderRadius: 8, border: "1px solid #E5E2DC", overflow: "hidden" }}>
            {([["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setLocation(val)}
                style={{
                  flex: 1, padding: "9px 0", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: 500,
                  backgroundColor: location === val ? (val === "schaumburg" ? "#2D6A4F" : "#5B9BD5") : "#FAFAF9",
                  color: location === val ? "#FFFFFF" : "#6B7280",
                  transition: "all 0.15s",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Zone Color */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zone Color</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {ZONE_COLORS.map(c => (
              <button
                key={c.value}
                title={c.label}
                onClick={() => setColor(c.value)}
                style={{
                  width: 32, height: 32, borderRadius: "50%", backgroundColor: c.value,
                  border: color === c.value ? "3px solid #1A1917" : "3px solid transparent",
                  outline: color === c.value ? "2px solid #FFFFFF" : "none",
                  outlineOffset: -5,
                  cursor: "pointer", transition: "all 0.12s",
                }}
              />
            ))}
          </div>
        </div>

        {/* Zip Codes */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zip Codes</label>
          <ZipTagInput zips={zips} onChange={setZips} />
        </div>

        {/* Assigned Employees */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Assigned Employees</label>
          <EmployeeMultiSelect employees={employees} selected={empIds} onChange={setEmpIds} />
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, marginTop: "auto", paddingTop: 16 }}>
          <button
            onClick={save}
            disabled={saving}
            style={{ flex: 1, padding: "10px 0", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontFamily: FF, fontSize: 14, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Saving..." : "Save Zone"}
          </button>
          <button
            onClick={onClose}
            style={{ padding: "10px 18px", backgroundColor: "transparent", color: "#6B7280", border: "1px solid #E5E2DC", borderRadius: 8, fontFamily: FF, fontSize: 14, cursor: "pointer" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ─── ZONE BOTTOM SHEET (Mobile edit) ──────────────────────────────────────────
function ZoneBottomSheet({ zone, employees, open, onClose, onSave }: {
  zone: Zone | null;
  employees: Employee[];
  open: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#5B9BD5");
  const [empIds, setEmpIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (zone) { setName(zone.name); setColor(zone.color); setEmpIds(zone.employees.map(e => e.id)); }
    else { setName(""); setColor("#5B9BD5"); setEmpIds([]); }
  }, [zone, open]);

  const save = async () => {
    if (!name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), color, employee_ids: empIds };
      const url = zone ? `${API}/api/zones/${zone.id}` : `${API}/api/zones`;
      const method = zone ? "PATCH" : "POST";
      const r = await fetch(url, { method, headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: zone ? "Zone updated" : "Zone created" });
      onSave();
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {open && <div onClick={onClose} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 60 }} />}
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 70,
        backgroundColor: "#FFFFFF", borderRadius: "16px 16px 0 0",
        padding: "16px 20px 32px", paddingBottom: "calc(32px + env(safe-area-inset-bottom))",
        boxShadow: "0 -4px 24px rgba(0,0,0,0.12)",
        transform: open ? "translateY(0)" : "translateY(100%)",
        transition: "transform 0.28s cubic-bezier(0.32,0.72,0,1)",
        display: "flex", flexDirection: "column", gap: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "center", paddingBottom: 4 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#E5E2DC" }} />
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontFamily: FF, fontWeight: 700, fontSize: 17, color: "#1A1917", margin: 0 }}>
            {zone ? "Edit Zone" : "Add Zone"}
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {/* Name */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zone Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ padding: "11px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontFamily: FF, fontSize: 14, color: "#1A1917", outline: "none", backgroundColor: "#FAFAF9" }}
          />
        </div>

        {/* Color swatches */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Color</label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {ZONE_COLORS.map(c => (
              <button key={c.value} onClick={() => setColor(c.value)}
                style={{ width: 36, height: 36, borderRadius: "50%", backgroundColor: c.value, border: color === c.value ? "3px solid #1A1917" : "3px solid transparent", cursor: "pointer" }} />
            ))}
          </div>
        </div>

        {/* Employees */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Assigned Employees</label>
          <EmployeeMultiSelect employees={employees} selected={empIds} onChange={setEmpIds} />
        </div>

        {/* Desktop hint */}
        <p style={{ fontFamily: FF, fontSize: 12, color: "#9E9B94", margin: 0, padding: "8px 12px", backgroundColor: "#F7F6F3", borderRadius: 8 }}>
          Manage zip codes on desktop for full zone coverage settings.
        </p>

        <button
          onClick={save}
          disabled={saving}
          style={{ padding: "13px 0", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 10, fontFamily: FF, fontSize: 15, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}
        >
          {saving ? "Saving..." : "Save Zone"}
        </button>
      </div>
    </>
  );
}

// ─── DESKTOP ZONES PAGE ───────────────────────────────────────────────────────
function DesktopZones({ zones, employees, stats, loading, onRefresh }: {
  zones: Zone[];
  employees: Employee[];
  stats: ZoneStats[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editZone, setEditZone] = useState<Zone | null>(null);
  const [locationFilter, setLocationFilter] = useState<LocationFilter>("all");

  const filteredZones = locationFilter === "all" ? zones : zones.filter(z => z.location === locationFilter);

  const openAdd = () => { setEditZone(null); setDrawerOpen(true); };
  const openEdit = (z: Zone) => { setEditZone(z); setDrawerOpen(true); };

  const toggleActive = async (z: Zone) => {
    try {
      await fetch(`${API}/api/zones/${z.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !z.is_active }),
      });
      onRefresh();
    } catch { toast({ title: "Failed to update zone", variant: "destructive" }); }
  };

  const deleteZone = async (z: Zone) => {
    if (!confirm(`Delete "${z.name}"? This cannot be undone.`)) return;
    try {
      await fetch(`${API}/api/zones/${z.id}`, { method: "DELETE", headers: getAuthHeaders() });
      toast({ title: "Zone deleted" });
      onRefresh();
    } catch { toast({ title: "Failed to delete zone", variant: "destructive" }); }
  };

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: FF, fontWeight: 700, fontSize: 36, color: "#1A1917", margin: 0, lineHeight: 1.1 }}>Service Zones</h1>
          <p style={{ fontFamily: FF, fontWeight: 400, fontSize: 13, color: "#6B7280", margin: "6px 0 0" }}>
            Color-code your coverage areas by zip code. Zones auto-assign to new clients and jobs.
          </p>
        </div>
        <button
          onClick={openAdd}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 18px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontFamily: FF, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          <Plus size={15} />
          Add Zone
        </button>
      </div>

      {/* Location Filter Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid #E5E2DC", paddingBottom: 0 }}>
        {([["all", "All Zones"], ["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setLocationFilter(val)}
            style={{
              padding: "8px 16px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: locationFilter === val ? 500 : 400,
              color: locationFilter === val ? "var(--brand)" : "#6B7280", backgroundColor: "transparent",
              borderBottom: `2px solid ${locationFilter === val ? "var(--brand)" : "transparent"}`, marginBottom: -1,
              transition: "color 0.15s",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Zones Table */}
      <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #E5E2DC", backgroundColor: "#FAFAF9" }}>
              {["", "Zone Name", "Location", "Zip Codes", "Employees", "Jobs This Month", "Active", ""].map((h, i) => (
                <th key={i} style={{ padding: "12px 16px", textAlign: "left", fontFamily: FF, fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", fontFamily: FF, fontSize: 13, color: "#9E9B94" }}>Loading zones...</td></tr>
            ) : filteredZones.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", fontFamily: FF, fontSize: 13, color: "#9E9B94" }}>No zones{locationFilter !== "all" ? " for this location" : ""}. Click "+ Add Zone" to create one.</td></tr>
            ) : (
              filteredZones.map((z, i) => (
                <tr key={z.id} style={{ borderBottom: i < filteredZones.length - 1 ? "1px solid #F0EEE9" : "none", opacity: z.is_active ? 1 : 0.55 }}>
                  <td style={{ padding: "14px 16px", width: 40 }}>
                    <div style={{ width: 18, height: 18, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                  </td>
                  <td style={{ padding: "14px 16px", fontFamily: FF, fontSize: 14, fontWeight: 500, color: "#1A1917" }}>
                    {z.name}
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <LocationBadge loc={z.location} />
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                      {(z.zip_codes || []).slice(0, 3).map(zip => (
                        <span key={zip} style={{ fontSize: 11, fontFamily: FF, padding: "2px 6px", backgroundColor: "#F0EEE9", borderRadius: 4, color: "#6B7280" }}>{zip}</span>
                      ))}
                      {(z.zip_codes || []).length > 3 && (
                        <span style={{ fontSize: 11, fontFamily: FF, color: "#9E9B94" }}>+{z.zip_codes.length - 3} more</span>
                      )}
                      {(z.zip_codes || []).length === 0 && (
                        <span style={{ fontSize: 11, fontFamily: FF, color: "#C0BDB8", fontStyle: "italic" }}>No zip codes</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: "14px 16px", fontFamily: FF, fontSize: 14, color: "#6B7280" }}>
                    {z.employee_count}
                  </td>
                  <td style={{ padding: "14px 16px", fontFamily: FF, fontSize: 14, color: "#6B7280" }}>
                    {z.jobs_this_month}
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <button
                      onClick={() => toggleActive(z)}
                      title={z.is_active ? "Click to deactivate" : "Click to activate"}
                      style={{
                        width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                        backgroundColor: z.is_active ? "var(--brand)" : "#E5E2DC",
                        position: "relative", transition: "background-color 0.2s",
                      }}
                    >
                      <div style={{
                        position: "absolute", top: 3, left: z.is_active ? 19 : 3,
                        width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFFFFF",
                        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                      }} />
                    </button>
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <button
                      onClick={() => openEdit(z)}
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", backgroundColor: "transparent", border: "1px solid #E5E2DC", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontSize: 12, color: "#6B7280" }}
                    >
                      <Edit2 size={12} />
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Zone Performance Table */}
      {stats.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ fontFamily: FF, fontWeight: 700, fontSize: 18, color: "#1A1917", marginBottom: 16 }}>Zone Performance This Month</h2>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #E5E2DC", backgroundColor: "#FAFAF9" }}>
                  {["Zone", "Jobs", "Revenue", "Avg Bill"].map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontFamily: FF, fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: i < stats.length - 1 ? "1px solid #F0EEE9" : "none", borderLeft: `4px solid ${s.color}` }}>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: s.color }} />
                        <span style={{ fontFamily: FF, fontSize: 13, fontWeight: 500, color: "#1A1917" }}>{s.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: "12px 16px", fontFamily: FF, fontSize: 13, color: "#6B7280" }}>{s.job_count}</td>
                    <td style={{ padding: "12px 16px", fontFamily: FF, fontSize: 13, color: "#6B7280" }}>{fmt$(s.revenue)}</td>
                    <td style={{ padding: "12px 16px", fontFamily: FF, fontSize: 13, color: "#6B7280" }}>{s.job_count ? fmt$(s.avg_bill) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drawer */}
      <ZoneDrawer
        zone={editZone}
        employees={employees}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSave={onRefresh}
      />
    </>
  );
}

// ─── MOBILE ZONES PAGE ────────────────────────────────────────────────────────
function MobileZones({ zones, employees, loading, onRefresh }: {
  zones: Zone[];
  employees: Employee[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [activeTab, setActiveTab] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editZone, setEditZone] = useState<Zone | null>(null);

  useEffect(() => {
    if (zones.length > 0 && activeTab === null) setActiveTab(zones[0].id);
  }, [zones]);

  const openAdd = () => { setEditZone(null); setSheetOpen(true); };
  const openEdit = (z: Zone) => { setEditZone(z); setSheetOpen(true); };
  const selectedZone = zones.find(z => z.id === activeTab) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Tab strip */}
      <div style={{ overflowX: "auto", paddingBottom: 2, msOverflowStyle: "none", scrollbarWidth: "none" } as any}>
        <div style={{ display: "flex", gap: 6, padding: "0 0 8px", minWidth: "max-content" }}>
          {loading ? (
            <div style={{ padding: "10px 16px", fontFamily: FF, fontSize: 13, color: "#9E9B94" }}>Loading...</div>
          ) : (
            <>
              {zones.map(z => (
                <button
                  key={z.id}
                  onClick={() => setActiveTab(z.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
                    borderRadius: 20, border: activeTab === z.id ? `2px solid ${z.color}` : "2px solid #E5E2DC",
                    backgroundColor: activeTab === z.id ? `${z.color}20` : "#FFFFFF",
                    cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: 500, color: "#1A1917",
                    whiteSpace: "nowrap",
                  }}
                >
                  <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: z.color }} />
                  {z.name}
                </button>
              ))}
              <button
                onClick={openAdd}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 20, border: "2px dashed #E5E2DC", backgroundColor: "transparent", cursor: "pointer", fontFamily: FF, fontSize: 13, color: "#9E9B94", whiteSpace: "nowrap" }}
              >
                <Plus size={13} />
                Add
              </button>
            </>
          )}
        </div>
      </div>

      {/* Selected zone info */}
      {selectedZone && (
        <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", padding: "20px 20px", display: "flex", flexDirection: "column", gap: 16, borderTop: `4px solid ${selectedZone.color}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2 style={{ fontFamily: FF, fontWeight: 700, fontSize: 22, color: selectedZone.color, margin: 0 }}>
              {selectedZone.name}
            </h2>
            <button
              onClick={() => openEdit(selectedZone)}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "transparent", cursor: "pointer", fontFamily: FF, fontSize: 13, color: "#6B7280" }}
            >
              <Edit2 size={13} />
              Edit Zone
            </button>
          </div>

          <div style={{ display: "flex", gap: 20 }}>
            <div style={{ flex: 1, textAlign: "center", padding: "14px 0", backgroundColor: "#F7F6F3", borderRadius: 8 }}>
              <p style={{ fontFamily: FF, fontSize: 24, fontWeight: 700, color: "#1A1917", margin: 0 }}>{selectedZone.jobs_this_month}</p>
              <p style={{ fontFamily: FF, fontSize: 11, color: "#9E9B94", margin: "4px 0 0" }}>Jobs This Month</p>
            </div>
            <div style={{ flex: 1, textAlign: "center", padding: "14px 0", backgroundColor: "#F7F6F3", borderRadius: 8 }}>
              <p style={{ fontFamily: FF, fontSize: 24, fontWeight: 700, color: "#1A1917", margin: 0 }}>{selectedZone.employee_count}</p>
              <p style={{ fontFamily: FF, fontSize: 11, color: "#9E9B94", margin: "4px 0 0" }}>Employees</p>
            </div>
          </div>

          {selectedZone.employees.length > 0 && (
            <div>
              <p style={{ fontFamily: FF, fontSize: 12, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Assigned Employees</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {selectedZone.employees.map(e => (
                  <span key={e.id} style={{ padding: "4px 10px", backgroundColor: "#F0EEE9", borderRadius: 14, fontFamily: FF, fontSize: 13, color: "#1A1917" }}>
                    {e.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!selectedZone && !loading && zones.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", fontFamily: FF, fontSize: 14, color: "#9E9B94" }}>
          No zones yet. Tap "+ Add" to create your first zone.
        </div>
      )}

      <ZoneBottomSheet
        zone={editZone}
        employees={employees}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSave={onRefresh}
      />
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function ZonesPage() {
  const isMobile = useIsMobile();
  const [zones, setZones] = useState<Zone[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [stats, setStats] = useState<ZoneStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [zRes, eRes, sRes] = await Promise.all([
        fetch(`${API}/api/zones`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/users?role=all&is_active=true`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/zones/stats`, { headers: getAuthHeaders() }),
      ]);
      if (zRes.ok) setZones(await zRes.json());
      if (eRes.ok) {
        const data = await eRes.json();
        const list = Array.isArray(data) ? data : (data.users || data.data || []);
        setEmployees(list.map((u: any) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`.trim(), role: u.role })));
      }
      if (sRes.ok) setStats(await sRes.json());
    } catch (e) {
      console.error("[zones load]", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1100 }}>
        {isMobile ? (
          <MobileZones zones={zones} employees={employees} loading={loading} onRefresh={load} />
        ) : (
          <DesktopZones zones={zones} employees={employees} stats={stats} loading={loading} onRefresh={load} />
        )}
      </div>
    </DashboardLayout>
  );
}
