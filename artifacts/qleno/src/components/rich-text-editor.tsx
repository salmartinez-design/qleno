import { useRef, useEffect, useCallback } from "react";
import { Bold, Italic, Underline, List, ListOrdered, Minus, AlignLeft, Link2, Unlink } from "lucide-react";

// [rich-text-editor] Shared contentEditable WYSIWYG used by the document-template
// editor AND the Customer Messages email editor. The office edits FORMATTED text
// with a small toolbar (bold / lists / headings / links / merge tags) and never
// sees raw HTML tags. Merge tags are passed in so each surface supplies its own
// vocabulary.
export type MergeTag = { key: string; desc?: string };

// ── HTML sanitizer ───────────────────────────────────────────────────────────
// Strips everything that makes imported/pasted HTML a mess — `data-*` attributes
// (the MaidCentral `data-path-to-node` cruft), inline `style`/`class`, font/span
// wrappers, table scaffolding — down to clean semantic markup. Keeps structural
// tags + links. Used BOTH on paste (so the office can never re-introduce garbage)
// and as a one-time cleanup when an old template is opened for editing.
const KEEP_TAGS = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "A",
  "UL", "OL", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "HR",
]);
const UNWRAP_TAGS = new Set([
  "SPAN", "FONT", "CENTER", "SMALL", "BIG", "SECTION", "ARTICLE",
  "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "ABBR", "MARK", "LABEL",
]);

function sanitizeEl(el: Element): void {
  // Depth-first: clean children before deciding what to do with this node.
  Array.from(el.children).forEach(sanitizeEl);
  const tag = el.tagName;
  // Drop every attribute except href on <a>.
  Array.from(el.attributes).forEach((a) => {
    if (tag === "A" && a.name.toLowerCase() === "href") return;
    el.removeAttribute(a.name);
  });
  const parent = el.parentNode;
  if (!parent) return;
  // A block-level <div> becomes a paragraph so line structure survives.
  if (tag === "DIV") {
    const p = document.createElement("p");
    while (el.firstChild) p.appendChild(el.firstChild);
    parent.replaceChild(p, el);
    return;
  }
  // Unwrap styling wrappers and any unknown tag — keep the text, drop the shell.
  if (UNWRAP_TAGS.has(tag) || !KEEP_TAGS.has(tag)) {
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }
}

export function cleanHtml(html: string): string {
  if (!html || typeof document === "undefined") return html || "";
  const root = document.createElement("div");
  root.innerHTML = html;
  root.querySelectorAll("script,style,meta,link,title,head,o\\:p").forEach((n) => n.remove());
  Array.from(root.children).forEach(sanitizeEl);
  return root.innerHTML.replace(/(\s|&nbsp;)+/g, " ").trim();
}

export function RichTextEditor({
  value,
  onChange,
  mergeTags = [],
  minHeight = 320,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mergeTags?: MergeTag[];
  minHeight?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInternalChange = useRef(false);

  useEffect(() => {
    if (ref.current && !isInternalChange.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
    isInternalChange.current = false;
  }, [value]);

  const flush = () => {
    if (ref.current) {
      isInternalChange.current = true;
      onChange(ref.current.innerHTML);
    }
  };

  const exec = useCallback((cmd: string, val?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    ref.current?.focus();
    flush();
  }, [onChange]);

  const onInput = useCallback(() => { flush(); }, [onChange]);

  // Paste comes in CLEAN — strip formatting cruft before it ever lands in the
  // editor, so a paste from MaidCentral / Word / a webpage can't re-create the
  // data-path-to-node mess.
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    const toInsert = html
      ? cleanHtml(html)
      : (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    document.execCommand("insertHTML", false, toInsert);
    flush();
  }, [onChange]);

  const insertVariable = (key: string) => {
    ref.current?.focus();
    document.execCommand("insertText", false, key);
    flush();
  };

  const addLink = () => {
    ref.current?.focus();
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      document.execCommand("createLink", false, url);
    } else {
      document.execCommand("insertHTML", false, `<a href="${url}">${url}</a>`);
    }
    flush();
  };

  const toolBtn = (onClick: () => void, icon: React.ReactNode, title: string) => (
    <button
      key={title}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      style={{
        width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
        background: "none", border: "1px solid #E5E2DC", borderRadius: 5,
        cursor: "pointer", color: "#6B7280",
      }}
    >{icon}</button>
  );

  const divider = (k: string) => <div key={k} style={{ width: 1, background: "#E5E2DC", margin: "2px 2px" }}/>;

  return (
    <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px",
        borderBottom: "1px solid #E5E2DC", background: "#F7F6F3",
      }}>
        {toolBtn(() => exec("bold"), <Bold size={13}/>, "Bold")}
        {toolBtn(() => exec("italic"), <Italic size={13}/>, "Italic")}
        {toolBtn(() => exec("underline"), <Underline size={13}/>, "Underline")}
        {divider("d1")}
        {toolBtn(() => exec("formatBlock", "<h2>"), <span style={{ fontSize: 11, fontWeight: 700 }}>H2</span>, "Heading 2")}
        {toolBtn(() => exec("formatBlock", "<h3>"), <span style={{ fontSize: 11, fontWeight: 700 }}>H3</span>, "Heading 3")}
        {toolBtn(() => exec("formatBlock", "<p>"), <AlignLeft size={13}/>, "Paragraph")}
        {divider("d2")}
        {toolBtn(() => exec("insertUnorderedList"), <List size={13}/>, "Bullet list")}
        {toolBtn(() => exec("insertOrderedList"), <ListOrdered size={13}/>, "Numbered list")}
        {toolBtn(() => exec("insertHorizontalRule"), <Minus size={13}/>, "Divider")}
        {divider("d3")}
        {toolBtn(addLink, <Link2 size={13}/>, "Add link")}
        {toolBtn(() => exec("unlink"), <Unlink size={13}/>, "Remove link")}
        {mergeTags.length > 0 && (
          <>
            {divider("d4")}
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 600 }}>Insert:</span>
              {mergeTags.map(v => (
                <button
                  key={v.key}
                  onMouseDown={e => { e.preventDefault(); insertVariable(v.key); }}
                  title={v.desc}
                  style={{
                    padding: "2px 7px", fontSize: 10, fontWeight: 600, color: "var(--brand)",
                    background: "var(--brand-dim, #E8FDF8)", border: "1px solid var(--brand)",
                    borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
                  }}
                >{v.key.replace(/[{}]/g, "")}</button>
              ))}
            </div>
          </>
        )}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={onInput}
        onPaste={onPaste}
        style={{
          minHeight, padding: 16, outline: "none",
          fontSize: 14, lineHeight: 1.6, color: "#1A1917",
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        }}
      />
    </div>
  );
}
