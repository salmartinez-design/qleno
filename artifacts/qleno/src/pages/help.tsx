// [help-center 2026-06-20] In-app Help & Guides. Plain-English, visual guides so
// the office can self-serve answers (invoicing workflow, reading an invoice,
// payroll, adding users). Reachable from the sidebar "Help & Guides" link.
import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ChevronDown, FileText, DollarSign, UserPlus, BookOpen, LifeBuoy } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "10px 0" }}>
      <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: "50%", background: "#0A0E1A", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 }}>{n}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>{title}</div>
        <div style={{ fontSize: 14, color: "#57544E", marginTop: 2, lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

function Callout({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  const c = tone === "warn"
    ? { bg: "#FAEEDA", bd: "#EF9F27", tx: "#633806" }
    : { bg: "#E1F5EE", bd: "#0F6E56", tx: "#085041" };
  return (
    <div style={{ background: c.bg, borderLeft: `3px solid ${c.bd}`, color: c.tx, padding: "10px 14px", borderRadius: 6, fontSize: 13.5, lineHeight: 1.55, margin: "10px 0" }}>{children}</div>
  );
}

function Section({ icon, title, subtitle, open, onToggle, children }: {
  icon: React.ReactNode; title: string; subtitle: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
      <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: FF }}>
        <div style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 9, background: "#F1EFE9", display: "flex", alignItems: "center", justifyContent: "center", color: "#0A0E1A" }}>{icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1A1917" }}>{title}</div>
          <div style={{ fontSize: 13, color: "#9E9B94", marginTop: 1 }}>{subtitle}</div>
        </div>
        <ChevronDown size={18} color="#9E9B94" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && <div style={{ padding: "4px 18px 20px 70px", borderTop: "1px solid #F0EEE9" }}>{children}</div>}
    </div>
  );
}

export default function HelpPage() {
  const [open, setOpen] = useState<string>("invoicing");
  const toggle = (id: string) => setOpen(o => (o === id ? "" : id));

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, fontFamily: FF }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1A1917", margin: "0 0 4px", display: "flex", alignItems: "center", gap: 10 }}>
            <LifeBuoy size={24} /> Help &amp; Guides
          </h1>
          <p style={{ fontSize: 14, color: "#9E9B94", margin: 0 }}>Plain-English answers to how Qleno works. Click a topic to expand.</p>
        </div>

        {/* INVOICING */}
        <Section icon={<FileText size={19} />} title="How invoicing works" subtitle="The #1 question — read this first"
          open={open === "invoicing"} onToggle={() => toggle("invoicing")}>
          <p style={{ fontSize: 14, color: "#57544E", lineHeight: 1.6, marginTop: 12 }}>
            Qleno invoices <strong>one invoice per visit</strong> (Jobber-style). Everything is <strong>manual and on your schedule</strong> — Qleno never charges a card or emails a customer on its own.
          </p>

          <Callout tone="warn">
            <strong>A “Draft” is not a real invoice.</strong> It’s a placeholder. Nobody has been billed and nothing has been sent until <em>you</em> send it or record the payment.
          </Callout>
          <Callout tone="info">
            <strong>Qleno does not auto-bill.</strong> No automatic charges, no automatic emails. You are always the one who clicks send / mark paid.
          </Callout>

          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", textTransform: "uppercase", letterSpacing: ".05em", margin: "16px 0 4px" }}>The flow, step by step</div>
          <Step n={1} title="A job gets completed">When a cleaner finishes a job, Qleno creates a <strong>draft invoice</strong> for it. (Draft = saved, not sent.)</Step>
          <Step n={2} title="Open the Invoices tab">Go to <strong>Invoices</strong> in the left menu. You see every invoice. Use <strong>Search</strong> to find one by invoice number, client name, or “INV-00622”.</Step>
          <Step n={3} title="Click an invoice to open it">Click the row (or <strong>View</strong>) to see the line items, amount, and due date. You can edit line items here if needed.</Step>
          <Step n={4} title="Send it or record payment">When you’re ready, <strong>Send</strong> the invoice or <strong>Mark Paid</strong> / record how they paid. (Sending by email is paused while communications are off — record payments manually for now.)</Step>
          <Step n={5} title="Monthly / commercial clients">Batch (monthly) clients collect their visits into <strong>one monthly invoice</strong>. Commercial buildings consolidate per account with <strong>Generate Invoice</strong> on the account page.</Step>

          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", textTransform: "uppercase", letterSpacing: ".05em", margin: "18px 0 8px" }}>Coming from MaidCentral?</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" }}>MaidCentral</div>
              <div style={{ fontSize: 13.5, color: "#57544E", marginTop: 4, lineHeight: 1.5 }}>The daily “Invoicing &amp; Job Records” page — pick a date, see every job with its timesheet + invoice.</div>
            </div>
            <div style={{ background: "#E1F5EE", border: "1px solid #9FE1CB", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#0F6E56", textTransform: "uppercase" }}>Qleno</div>
              <div style={{ fontSize: 13.5, color: "#085041", marginTop: 4, lineHeight: 1.5 }}>The <strong>Invoices</strong> tab is your hub — search, open, send, mark paid. (A per-day “all jobs + invoices” view like MC’s is on the roadmap.)</div>
            </div>
          </div>
        </Section>

        {/* READING AN INVOICE */}
        <Section icon={<BookOpen size={19} />} title="Reading an invoice" subtitle="What the fields mean"
          open={open === "reading"} onToggle={() => toggle("reading")}>
          <ul style={{ fontSize: 14, color: "#57544E", lineHeight: 1.7, paddingLeft: 18, marginTop: 12 }}>
            <li><strong>Status</strong> — <em>Draft</em> (not sent), <em>Sent</em> (out to the customer), <em>Paid</em>, or <em>Overdue</em>.</li>
            <li><strong>Line items</strong> — the service + any add-ons (e.g. Parking Fee), each with an amount.</li>
            <li><strong>Subtotal / Tips / Total</strong> — the math. Total is what the customer owes.</li>
            <li><strong>Due date</strong> — when payment is due (based on the client’s terms).</li>
            <li><strong>Balance</strong> — what’s still owed ($0.00 once paid).</li>
          </ul>
          <Callout tone="info">If a $ stat box (Outstanding / Paid / YTD) shows $0, it’s because those count <strong>sent/paid</strong> invoices — drafts don’t count until you send them.</Callout>
        </Section>

        {/* PAYROLL */}
        <Section icon={<DollarSign size={19} />} title="How cleaners get paid" subtitle="Commission, allowed hours, and the per-job switch"
          open={open === "payroll"} onToggle={() => toggle("payroll")}>
          <ul style={{ fontSize: 14, color: "#57544E", lineHeight: 1.7, paddingLeft: 18, marginTop: 12 }}>
            <li><strong>House cleans</strong> — paid a <strong>commission %</strong> of the job, split between the cleaners by the hours each worked.</li>
            <li><strong>Commercial / hourly jobs</strong> — paid the job’s <strong>allowed (budgeted) hours</strong>, split between the cleaners. Fast or slow, they earn the budget.</li>
            <li><strong>One-off exception</strong> — on a job you can switch the pay to <strong>Hourly</strong> and type the real hours (for a job that ran long).</li>
          </ul>
          <Callout tone="info">Hours shown on the payroll screen are <strong>for records</strong>. Cleaners are paid on commission + mileage, not by the hour, unless you set a job to Hourly.</Callout>
        </Section>

        {/* ADDING USERS */}
        <Section icon={<UserPlus size={19} />} title="Adding a user" subtitle="Office staff, cleaners, or a view-only CPA"
          open={open === "users"} onToggle={() => toggle("users")}>
          <Step n={1} title="Go to Employees → Add">Open <strong>Employees</strong> and add the person.</Step>
          <Step n={2} title="Pick their role">
            <strong>Office</strong> = full day-to-day access · <strong>Technician</strong> = the cleaner app · <strong>Accountant</strong> = <em>view-only</em> (sees Customers + Invoices, can’t change anything — for your CPA).
          </Step>
          <Step n={3} title="Set their password">Since communications are off, set the password yourself when you add them and share it securely. They can change it later.</Step>
          <Callout tone="warn">The <strong>Accountant</strong> role can look at everything it’s given but <strong>cannot edit, delete, or send anything</strong> — safe for an outside accountant.</Callout>
        </Section>

        <div style={{ textAlign: "center", fontSize: 13, color: "#9E9B94", padding: "8px 0 4px" }}>
          Still stuck? Message the Phes office team and we’ll add the answer here.
        </div>
      </div>
    </DashboardLayout>
  );
}
