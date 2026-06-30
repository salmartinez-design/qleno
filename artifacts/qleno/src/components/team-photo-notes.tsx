import { useEffect, useRef, useState } from "react";
import { Camera, Pin, Trash2, Loader2, ImagePlus } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// [team-photo-notes] Pictures + notes the team shares. Two scopes:
//   • Job context (jobId): adds attach to THIS job by default; an operator can
//     tick "Show on every visit" to make it sticky to the job's customer, in
//     which case the job's customer scope (passed via job* props) is pinned.
//   • Customer context (clientId / accountId / accountPropertyId): every note
//     added here is sticky to that customer/property.
// Sticky notes render pinned at the top with a Pin badge on the job panel.
export type TeamPhotoNotesProps = {
  jobId?: number | null;
  clientId?: number | null;
  accountId?: number | null;
  accountPropertyId?: number | null;
  // For a job context: the job's customer scope, so "Show on every visit" can pin.
  jobClientId?: number | null;
  jobAccountId?: number | null;
  jobAccountPropertyId?: number | null;
  title?: string;
};

type Note = {
  id: number;
  job_id: number | null;
  client_id: number | null;
  account_id: number | null;
  account_property_id: number | null;
  is_sticky: boolean;
  image_url: string | null;
  note: string | null;
  created_at: string;
};

const MINT = "#00C9A0";
const INK = "#1A1917";
const MUTE = "#6B7280";
const BORDER = "#E5E2DC";

export function TeamPhotoNotes(props: TeamPhotoNotesProps) {
  const { jobId, clientId, accountId, accountPropertyId } = props;
  const isJobContext = jobId != null;
  // In a job context, a sticky toggle is only meaningful if the job actually has
  // a customer to pin to.
  const jobHasCustomer =
    props.jobClientId != null || props.jobAccountId != null || props.jobAccountPropertyId != null;

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [sticky, setSticky] = useState(!isJobContext); // customer context = always sticky
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function query(): string {
    if (jobId != null) return `job_id=${jobId}`;
    if (clientId != null) return `client_id=${clientId}`;
    if (accountPropertyId != null) return `account_property_id=${accountPropertyId}`;
    if (accountId != null) return `account_id=${accountId}`;
    return "";
  }

  async function load() {
    const q = query();
    if (!q) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/team-photo-notes?${q}`, { headers: getAuthHeaders() });
      setNotes(r.ok ? await r.json() : []);
    } catch { setNotes([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [jobId, clientId, accountId, accountPropertyId]);

  async function add() {
    if (!file && !text.trim()) { setError("Add a picture or a note."); return; }
    setSaving(true); setError("");
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      if (text.trim()) form.append("note", text.trim());

      const makeSticky = isJobContext ? sticky && jobHasCustomer : true;
      form.append("is_sticky", makeSticky ? "true" : "false");

      if (isJobContext) {
        form.append("job_id", String(jobId));
        if (makeSticky) {
          // Pin to the most specific customer scope the job carries.
          if (props.jobClientId != null) form.append("client_id", String(props.jobClientId));
          if (props.jobAccountPropertyId != null) form.append("account_property_id", String(props.jobAccountPropertyId));
          else if (props.jobAccountId != null) form.append("account_id", String(props.jobAccountId));
        }
      } else {
        if (clientId != null) form.append("client_id", String(clientId));
        if (accountPropertyId != null) form.append("account_property_id", String(accountPropertyId));
        else if (accountId != null) form.append("account_id", String(accountId));
      }

      const r = await fetch(`${API}/api/team-photo-notes`, {
        method: "POST",
        headers: getAuthHeaders() as Record<string, string>,
        body: form,
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || "Failed to save"); }
      setFile(null); setText(""); if (fileRef.current) fileRef.current.value = "";
      if (isJobContext) setSticky(false);
      await load();
    } catch (e: any) { setError(e.message || "Failed to save"); }
    finally { setSaving(false); }
  }

  async function remove(id: number) {
    try {
      await fetch(`${API}/api/team-photo-notes/${id}`, { method: "DELETE", headers: getAuthHeaders() });
      setNotes((n) => n.filter((x) => x.id !== id));
    } catch { /* leave it; reload will reconcile */ }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Camera size={16} color={MINT} />
        <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>
          {props.title ?? "Team Photos & Notes"}
        </span>
      </div>

      {/* Add form */}
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, background: "#FFFFFF", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => fileRef.current?.click()}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "7px 12px", background: "#F7F6F3", cursor: "pointer", fontSize: 12, fontWeight: 600, color: INK, fontFamily: "inherit" }}>
            <ImagePlus size={15} color={MUTE} /> {file ? "Change photo" : "Add photo"}
          </button>
          {file && <span style={{ fontSize: 12, color: MUTE, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder="Note for the team — e.g. gate code 2247, park on the south side, dog is friendly"
          style={{ width: "100%", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box", color: INK }} />

        {isJobContext && jobHasCustomer && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: INK, cursor: "pointer" }}>
            <input type="checkbox" checked={sticky} onChange={(e) => setSticky(e.target.checked)} style={{ accentColor: MINT }} />
            <Pin size={13} color={sticky ? "#3B82F6" : MUTE} />
            Show on every visit for this customer (blue) — otherwise just this job (yellow)
          </label>
        )}

        {error && <p style={{ fontSize: 12, color: "#DC2626", margin: 0 }}>{error}</p>}

        <div>
          <button type="button" onClick={add} disabled={saving}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", borderRadius: 8, padding: "8px 16px", background: MINT, color: "#fff", cursor: saving ? "default" : "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
      </div>

      {/* List */}
      {loading && notes.length === 0 ? (
        <p style={{ fontSize: 12, color: MUTE }}>Loading…</p>
      ) : notes.length === 0 ? (
        <p style={{ fontSize: 12, color: MUTE }}>No photos or notes yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {notes.map((n) => (
            // Color encodes scope: blue = shows on every visit for this customer
            // (sticky), light yellow = note for this one job only. Keeps the two
            // purposes visually distinct at a glance.
            <div key={n.id} style={{ display: "flex", gap: 10, border: `1px solid ${n.is_sticky ? "#BBD3F5" : "#F5DFA6"}`, background: n.is_sticky ? "#EFF5FE" : "#FEFCE8", borderRadius: 10, padding: 10 }}>
              {n.image_url && (
                <a href={`${API}${n.image_url}`} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                  <img src={`${API}${n.image_url}`} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: `1px solid ${BORDER}` }} />
                </a>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {n.is_sticky && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "#1D4ED8", background: "#D9E7FA", borderRadius: 999, padding: "2px 7px", marginBottom: 4 }}>
                    <Pin size={10} /> Every visit
                  </span>
                )}
                {n.note && <p style={{ fontSize: 13, color: INK, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.note}</p>}
                <p style={{ fontSize: 11, color: MUTE, margin: "4px 0 0" }}>{new Date(n.created_at).toLocaleDateString()}</p>
              </div>
              <button type="button" onClick={() => remove(n.id)} title="Delete"
                style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: MUTE, padding: 4 }}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
