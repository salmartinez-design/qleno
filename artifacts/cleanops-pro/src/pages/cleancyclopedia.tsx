import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Search, BookOpen, ChevronRight } from "lucide-react";

const ARTICLES = [
  {
    category: "Techniques",
    items: [
      { title: "Deep Clean Bathroom Protocol", desc: "Step-by-step procedure for a full bathroom deep clean including grout, fixtures, and ventilation.", time: "45 min" },
      { title: "Kitchen Degreasing & Sanitization", desc: "Commercial-grade degreasing techniques for stoves, hoods, and tile surfaces.", time: "30 min" },
      { title: "Move-Out Checklist: 50-Point Inspection", desc: "Complete checklist ensuring every surface meets move-out clean standards.", time: "2.5 hrs" },
      { title: "Carpet Spot Treatment Guide", desc: "Identify stain types and match correct treatment: biological, oil, tannin.", time: "15 min" },
    ]
  },
  {
    category: "Chemicals & Safety",
    items: [
      { title: "Dilution Ratio Reference Card", desc: "Quick reference for concentrates: bleach, degreaser, glass cleaner, disinfectant.", time: "Reference" },
      { title: "Chemical Compatibility Chart", desc: "Never mix these. Safety data for all products in our standard kit.", time: "Reference" },
      { title: "OSHA Compliance for Cleaning Crews", desc: "PPE requirements, SDS binder maintenance, and spill response procedures.", time: "Read" },
    ]
  },
  {
    category: "Client Communication",
    items: [
      { title: "Handling Client Complaints", desc: "De-escalation scripts and resolution process for job quality disputes.", time: "Read" },
      { title: "Pre-Service Walkthrough Script", desc: "What to say and look for during client onboarding and walkthrough.", time: "Read" },
      { title: "Upsell Opportunities Guide", desc: "Identify and pitch add-ons: inside fridge, oven, windows, garage.", time: "Read" },
    ]
  },
];

export default function CleancyclopediaPage() {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = ARTICLES.map(cat => ({
    ...cat,
    items: cat.items.filter(item =>
      !search || item.title.toLowerCase().includes(search.toLowerCase()) || item.desc.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(cat => cat.items.length > 0);

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {/* Header */}
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '42px', color: '#E8E0D0', margin: 0, lineHeight: 1.1 }}>Cleancyclopedia</h1>
          <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 300, fontSize: '13px', color: '#888780', marginTop: '6px' }}>Training library, SOPs, chemical guides, and client communication scripts.</p>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: '480px' }}>
          <Search size={16} strokeWidth={1.5} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#888780' }} />
          <input
            placeholder="Search articles, techniques, chemicals..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', paddingLeft: '44px', paddingRight: '16px', height: '44px', backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', color: '#E8E0D0', fontSize: '14px', fontFamily: "'DM Mono', monospace", outline: 'none' }}
          />
        </div>

        {/* Categories */}
        {filtered.map(cat => (
          <div key={cat.category}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <BookOpen size={16} strokeWidth={1.5} style={{ color: 'var(--tenant-color)' }} />
              <h2 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '20px', color: '#E8E0D0', margin: 0 }}>{cat.category}</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {cat.items.map(article => (
                <div
                  key={article.title}
                  onClick={() => setExpanded(expanded === article.title ? null : article.title)}
                  style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 400, fontSize: '14px', color: '#E8E0D0', margin: '0 0 3px 0' }}>{article.title}</p>
                      <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 300, fontSize: '12px', color: '#888780', margin: 0 }}>{article.desc}</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '16px', flexShrink: 0 }}>
                      <span style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", color: '#888780', backgroundColor: '#0D0D0D', border: '1px solid #252525', padding: '3px 10px', borderRadius: '4px' }}>{article.time}</span>
                      <ChevronRight size={14} strokeWidth={1.5} style={{ color: '#888780', transform: expanded === article.title ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                    </div>
                  </div>
                  {expanded === article.title && (
                    <div style={{ padding: '0 20px 20px', borderTop: '1px solid #252525' }}>
                      <div style={{ paddingTop: '16px' }}>
                        <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 300, fontSize: '13px', color: '#888780', lineHeight: 1.7, margin: 0 }}>
                          {article.desc} This article contains step-by-step instructions, best practices, and quality checkpoints developed by the PHES Cleaning LLC operations team.
                        </p>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
                          <button style={{ padding: '7px 16px', backgroundColor: 'var(--tenant-color)', color: '#0D0D0D', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Mono', monospace", border: 'none', cursor: 'pointer' }}>
                            Read Full Article
                          </button>
                          <button style={{ padding: '7px 16px', border: '1px solid #252525', borderRadius: '6px', backgroundColor: 'transparent', color: '#888780', fontSize: '12px', fontFamily: "'DM Mono', monospace", cursor: 'pointer' }}>
                            Download PDF
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0', border: '1px dashed #252525', borderRadius: '10px' }}>
            <p style={{ fontFamily: "'Playfair Display', serif", fontSize: '18px', color: '#E8E0D0', margin: '0 0 8px 0' }}>No articles found</p>
            <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 300, fontSize: '13px', color: '#888780', margin: 0 }}>Try a different search term.</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
