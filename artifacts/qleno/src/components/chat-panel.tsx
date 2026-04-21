import { useState, useEffect, useRef, useCallback } from "react";
import { X, Send, MessageSquare, Users, ChevronLeft, Hash } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function useMessages(channel: string, enabled: boolean) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const poll = useRef<any>(null);

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/messages?channel=${encodeURIComponent(channel)}&limit=40`, { headers: getAuthHeaders() });
      const d = await r.json();
      setMessages(d.messages || []);
    } catch { }
    setLoading(false);
  }, [channel]);

  useEffect(() => {
    if (!enabled) return;
    fetch_();
    poll.current = setInterval(fetch_, 10000);
    return () => clearInterval(poll.current);
  }, [fetch_, enabled]);

  return { messages, loading, refetch: fetch_ };
}

interface Props {
  onClose: () => void;
  userId: number;
}

export function ChatPanel({ onClose, userId }: Props) {
  const [activeChannel, setActiveChannel] = useState('general');
  const [team, setTeam] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<'channels' | 'chat'>('chat');
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, loading, refetch } = useMessages(activeChannel, true);

  useEffect(() => {
    fetch(`${API}/api/messages/team`, { headers: getAuthHeaders() })
      .then(r => r.json()).then(d => setTeam(d.team || [])).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!body.trim() || sending) return;
    setSending(true);
    const isDm = activeChannel.startsWith('dm:');
    const recipientId = isDm ? parseInt(activeChannel.replace('dm:', '')) : undefined;
    try {
      await fetch(`${API}/api/messages`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: activeChannel, body: body.trim(), recipient_id: recipientId }),
      });
      setBody('');
      refetch();
    } catch { }
    setSending(false);
  }

  const channelLabel = activeChannel === 'general' ? '#general' :
    activeChannel === 'dispatch' ? '#dispatch' :
    activeChannel.startsWith('dm:') ? (() => {
      const uid = parseInt(activeChannel.replace('dm:', ''));
      const u = team.find(t => t.id === uid);
      return u ? `${u.first_name} ${u.last_name}` : 'DM';
    })() : activeChannel;

  return (
    <div style={{
      position:'fixed', right:0, top:0, bottom:0, width:320, background:'#FFFFFF',
      borderLeft:'1px solid #E5E2DC', zIndex:1000, display:'flex', flexDirection:'column',
      fontFamily:"'Plus Jakarta Sans', sans-serif", boxShadow:'-4px 0 24px rgba(0,0,0,0.1)',
    }}>
      {/* Header */}
      <div style={{ padding:'14px 16px', borderBottom:'1px solid #E5E2DC', display:'flex', alignItems:'center', gap:10 }}>
        {view === 'channels' ? (
          <>
            <MessageSquare size={16} color="#5B9BD5"/>
            <span style={{ fontSize:14, fontWeight:700, color:'#1A1917', flex:1 }}>Team Chat</span>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9E9B94', padding:2 }}><X size={16}/></button>
          </>
        ) : (
          <>
            <button onClick={() => setView('channels')} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B7280', padding:2 }}><ChevronLeft size={16}/></button>
            <span style={{ fontSize:13, fontWeight:600, color:'#1A1917', flex:1 }}>{channelLabel}</span>
            <button onClick={() => setView('channels')} style={{ background:'none', border:'none', cursor:'pointer', color:'#9E9B94', padding:2 }}><Users size={15}/></button>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#9E9B94', padding:2 }}><X size={16}/></button>
          </>
        )}
      </div>

      {/* Channels/DM Sidebar */}
      {view === 'channels' && (
        <div style={{ flex:1, overflowY:'auto', padding:'12px 0' }}>
          <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.07em', padding:'0 16px 8px', margin:0 }}>Channels</p>
          {['general','dispatch'].map(ch => (
            <button key={ch} onClick={() => { setActiveChannel(ch); setView('chat'); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 16px', background: activeChannel===ch?'#EBF4FF':'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
              <Hash size={13} color={activeChannel===ch?'#5B9BD5':'#9E9B94'}/>
              <span style={{ fontSize:13, color: activeChannel===ch?'#5B9BD5':'#1A1917', fontWeight: activeChannel===ch?600:400 }}>{ch}</span>
            </button>
          ))}
          <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.07em', padding:'16px 16px 8px', margin:0 }}>Direct Messages</p>
          {team.map(u => {
            const ch = `dm:${u.id}`;
            return (
              <button key={u.id} onClick={() => { setActiveChannel(ch); setView('chat'); }}
                style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 16px', background: activeChannel===ch?'#EBF4FF':'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                <div style={{ width:24, height:24, borderRadius:12, background:'#F3F4F6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:700, color:'#6B7280', flexShrink:0 }}>
                  {u.first_name?.[0]}{u.last_name?.[0]}
                </div>
                <span style={{ fontSize:13, color:'#1A1917' }}>{u.first_name} {u.last_name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Messages */}
      {view === 'chat' && (
        <>
          <div style={{ flex:1, overflowY:'auto', padding:'12px', display:'flex', flexDirection:'column', gap:10 }}>
            {loading && <p style={{ fontSize:12, color:'#9E9B94', textAlign:'center', margin:'auto 0' }}>Loading…</p>}
            {!loading && messages.length === 0 && <p style={{ fontSize:12, color:'#9E9B94', textAlign:'center', margin:'auto 0' }}>No messages yet. Start the conversation.</p>}
            {messages.map(m => {
              const isMe = m.sender_id === userId;
              return (
                <div key={m.id} style={{ display:'flex', flexDirection: isMe?'row-reverse':'row', alignItems:'flex-end', gap:6 }}>
                  {!isMe && (
                    <div style={{ width:26, height:26, borderRadius:13, background:'#EBF4FF', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:700, color:'#5B9BD5', flexShrink:0 }}>
                      {m.sender_initials || m.sender_name?.[0] || '?'}
                    </div>
                  )}
                  <div style={{ maxWidth:'75%' }}>
                    {!isMe && <p style={{ fontSize:10, color:'#9E9B94', margin:'0 0 2px 4px', fontWeight:600 }}>{m.sender_name?.split(' ')[0]}</p>}
                    <div style={{
                      padding:'8px 12px', borderRadius: isMe?'12px 12px 4px 12px':'12px 12px 12px 4px',
                      background: isMe?'var(--brand, #5B9BD5)':'#F3F4F6',
                      color: isMe?'#FFFFFF':'#1A1917',
                    }}>
                      <p style={{ fontSize:13, margin:0, lineHeight:1.4 }}>{m.body}</p>
                    </div>
                    <p style={{ fontSize:10, color:'#9E9B94', margin:'2px 0 0', textAlign: isMe?'right':'left' }}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef}/>
          </div>

          {/* Input */}
          <div style={{ padding:'12px', borderTop:'1px solid #E5E2DC', display:'flex', gap:8 }}>
            <input value={body} onChange={e => setBody(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Message…"
              style={{ flex:1, height:36, padding:'0 12px', border:'1px solid #E5E2DC', borderRadius:18, fontSize:13, outline:'none', fontFamily:'inherit' }}/>
            <button onClick={send} disabled={!body.trim() || sending}
              style={{ width:36, height:36, borderRadius:18, background:'var(--brand, #5B9BD5)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', opacity: !body.trim()?0.4:1 }}>
              <Send size={14} color="#FFFFFF"/>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
