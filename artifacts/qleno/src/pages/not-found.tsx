import { Link } from "wouter";

export default function NotFound() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0D0D0D', gap: '16px' }}>
      <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '72px', color: '#F0EDE8', margin: 0, lineHeight: 1 }}>404</h1>
      <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '14px', color: '#888780', margin: 0 }}>This page could not be found.</p>
      <Link href="/dashboard">
        <button style={{ marginTop: '8px', padding: '8px 20px', backgroundColor: 'var(--brand)', color: '#0D0D0D', borderRadius: '6px', fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", border: 'none', cursor: 'pointer' }}>
          Back to Dashboard
        </button>
      </Link>
    </div>
  );
}
