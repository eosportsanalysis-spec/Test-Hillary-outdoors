import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient.js";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcStatus(g) {
  const days = Math.floor((new Date(g.expiry) - new Date()) / 86400000);
  const rem  = (g.usage_limit || 9999) - (g.number_of_uses || 0);
  if ((g.usage_limit && g.number_of_uses >= g.usage_limit) || (g.expiry && days < 0)) return "Red";
  if (rem <= 15 || (g.expiry && days / 30 <= 3)) return "Orange";
  if (rem <= 60 || (g.expiry && days / 30 <= 5)) return "Yellow";
  return "Green";
}
function calcPriority(s) { return {Red:1,Orange:2,Yellow:3,Green:4}[s] || 4; }
function fmtDT(dt) { return dt ? new Date(dt).toLocaleString("en-NZ",{dateStyle:"medium",timeStyle:"short"}) : "—"; }
function fmtD(d)   { return d  ? new Date(d).toLocaleDateString("en-NZ",{dateStyle:"medium"}) : "—"; }
function nzd(n)    { return n != null ? "$" + Number(n).toLocaleString("en-NZ",{minimumFractionDigits:2,maximumFractionDigits:2}) : "—"; }
function sq(list, q, fields) {
  if (!q) return list;
  const l = q.toLowerCase();
  return list.filter(r => fields.some(f => { const v = r[f]; return v && String(v).toLowerCase().includes(l); }));
}
function dlCSV(name, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const esc  = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const csv  = [keys.map(esc).join(","), ...rows.map(r => keys.map(k => esc(r[k])).join(","))].join("\n");
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download = name + "_" + new Date().toISOString().slice(0,10) + ".csv";
  a.click();
}
function smartAllocate(items, budget) {
  let rem = budget;
  const map = {};
  [...items].filter(w => w.workflow_stage !== "completed").sort((a,b) => (a.priority||4)-(b.priority||4)).forEach(item => {
    const cost = item.estimated_cost || 0;
    let at, ar;
    if      (item.priority === 1)               { at="budget"; rem-=cost; ar="Critical P1 ("+nzd(cost)+")"; }
    else if (cost > 600 && item.priority > 2)   { at="grant";             ar="Large capital – grant recommended"; }
    else if (cost <= rem && item.priority <= 2) { at="budget"; rem-=cost; ar="High priority, fits budget"; }
    else if (cost <= rem && item.priority === 3){ at="budget"; rem-=cost; ar="Fits remaining budget"; }
    else                                        { at="grant";             ar=cost>rem?"Exceeds budget – grant recommended":"Low urgency – grant preferred"; }
    map[item.wf_id] = {allocated_to:at, allocation_reason:ar};
  });
  return items.map(i => i.workflow_stage==="completed" ? i : {...i,...(map[i.wf_id]||{})});
}

// ─── TOKENS ───────────────────────────────────────────────────────────────────
const T = {bg:"#0d1a0d",card:"rgba(255,255,255,0.06)",border:"rgba(255,255,255,0.10)",g1:"#1a3a1a",g2:"#2d5a2d",accent:"#e8621a",text:"#e8f0e8",muted:"#6a8a6a",white:"#ffffff"};
const SC = {
  Red:         {bg:"#c0392b",lt:"rgba(192,57,43,0.15)", meaning:"Replace immediately — do not use"},
  Orange:      {bg:"#e67e22",lt:"rgba(230,126,34,0.15)",meaning:"Replace within 3 months"},
  Yellow:      {bg:"#c9a800",lt:"rgba(212,172,13,0.15)",meaning:"Purchase within 5 months"},
  YellowRepair:{bg:"#b8860b",lt:"rgba(184,134,11,0.15)",meaning:"Needs repair — monitor"},
  Green:       {bg:"#27ae60",lt:"rgba(39,174,96,0.15)", meaning:"All clear — safe to use"},
};
const STGC = {
  pending:       {label:"Pending",      color:"#6a8a6a"},
  quoted:        {label:"Quoted",       color:"#4a80c8"},
  grant_applied: {label:"Grant Applied",color:"#9b59b6"},
  grant_approved:{label:"Approved",     color:"#27ae60"},
  ordered:       {label:"Ordered",      color:"#e8621a"},
  arrived:       {label:"Arrived",      color:"#27ae60"},
  entered:       {label:"Completed",    color:"#27ae60"},
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${T.bg};color:${T.text};font-family:'DM Sans',sans-serif;font-size:14px;line-height:1.6;}
  ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:${T.g2};border-radius:3px;}
  input,textarea,select{background:rgba(255,255,255,0.07)!important;border:1px solid rgba(255,255,255,0.14)!important;color:${T.text}!important;border-radius:8px;padding:9px 13px;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;width:100%;transition:border .15s;}
  input:focus,textarea:focus,select:focus{border-color:${T.accent}!important;}
  select option{background:#1a2a1a;}
  button{cursor:pointer;font-family:'DM Sans',sans-serif;}
  table{border-collapse:collapse;width:100%;}
  th{text-align:left;padding:9px 13px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:${T.muted};border-bottom:1px solid ${T.border};white-space:nowrap;}
  td{padding:10px 13px;font-size:14px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:middle;}
  tr:last-child td{border-bottom:none;}
  tr.cl:hover td{background:rgba(255,255,255,0.04);cursor:pointer;}
  .toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a3a1a;border:1px solid ${T.accent};color:${T.text};padding:11px 22px;border-radius:12px;font-size:14px;z-index:9999;white-space:nowrap;animation:fu .25s ease;}
  .mbg{position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:800;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;}
  .mbox{background:#141f14;border:1px solid ${T.border};border-radius:18px;padding:26px;width:100%;max-width:600px;margin:auto;}
  .sx{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  .sb{transition:width .22s ease;overflow:hidden;flex-shrink:0;}
  @keyframes fu{from{opacity:0;transform:translateX(-50%) translateY(10px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
  @keyframes sr{0%{transform:scale(.8);opacity:.8;}100%{transform:scale(1.5);opacity:0;}}
  @keyframes pl{0%,100%{opacity:.6;transform:scale(1);}50%{opacity:1;transform:scale(1.06);}}
`;

// ─── ATOMS ────────────────────────────────────────────────────────────────────
function Card({children, style}) {
  return <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:20,...style}}>{children}</div>;
}
function SBadge({status, small}) {
  const c = SC[status] || SC.Green;
  return <span style={{background:c.bg,color:"#fff",padding:small?"3px 8px":"4px 12px",borderRadius:20,fontSize:small?11:13,fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap"}}>{status}</span>;
}
function StgBadge({stage}) {
  const c = STGC[stage] || STGC.pending;
  return <span style={{background:c.color+"22",color:c.color,border:"1px solid "+c.color+"44",padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:700,textTransform:"uppercase"}}>{c.label}</span>;
}
function FL({children}) {
  return <div style={{fontSize:11,letterSpacing:1.3,textTransform:"uppercase",color:T.muted,marginBottom:6,marginTop:14}}>{children}</div>;
}
function PT({title, sub}) {
  return (
    <div style={{marginBottom:22}}>
      <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,color:T.white}}>{title}</h2>
      {sub && <p style={{fontSize:14,color:T.muted,marginTop:5,lineHeight:1.6}}>{sub}</p>}
    </div>
  );
}
function Btn({children, onClick, color, style, disabled, small, outline}) {
  const col = color || T.accent;
  return (
    <button disabled={disabled} onClick={onClick} style={{background:outline?"transparent":disabled?"rgba(255,255,255,0.08)":col,color:outline?col:disabled?T.muted:"#fff",border:outline?"1px solid "+col:"none",borderRadius:8,padding:small?"6px 12px":"10px 18px",fontSize:small?13:15,fontWeight:600,transition:"all .15s",cursor:disabled?"not-allowed":"pointer",opacity:disabled?.5:1,...style}}>
      {children}
    </button>
  );
}
function Divider() { return <div style={{borderTop:"1px solid "+T.border,margin:"16px 0"}} />; }
function Mdl({children, onClose}) {
  return (
    <div className="mbg" onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div className="mbox">{children}</div>
    </div>
  );
}
function Toast({msg}) { return msg ? <div className="toast">{msg}</div> : null; }
function KV({label, value}) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.05)",gap:16}}>
      <span style={{color:T.muted,fontSize:14,flexShrink:0}}>{label}</span>
      <span style={{fontSize:14,fontWeight:500,textAlign:"right"}}>{value}</span>
    </div>
  );
}
function SBar({value, onChange, ph}) {
  return <input placeholder={"🔍  "+(ph||"Search…")} value={value} onChange={e => onChange(e.target.value)} style={{marginBottom:12}}/>;
}
function Spinner() {
  return <div style={{display:"flex",justifyContent:"center",alignItems:"center",padding:40}}>
    <div style={{width:32,height:32,border:"3px solid rgba(255,255,255,0.1)",borderTop:"3px solid "+T.accent,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>;
}
function DonutChart({data}) {
  const total = Object.values(data).reduce((a,b)=>a+b,0)||1;
  const cols = {Red:"#c0392b",Orange:"#e67e22",Yellow:"#c9a800",Green:"#27ae60"};
  const r=40,cx=50,cy=50,sw=16; let cum=0;
  const segs = ["Red","Orange","Yellow","Green"].map(k=>{const pct=(data[k]||0)/total,s=cum;cum+=pct;return{key:k,pct,start:s};}).filter(s=>s.pct>0);
  function arc(s,e) {
    const sa=s*2*Math.PI-Math.PI/2, ea=e*2*Math.PI-Math.PI/2;
    const x1=cx+r*Math.cos(sa),y1=cy+r*Math.sin(sa),x2=cx+r*Math.cos(ea),y2=cy+r*Math.sin(ea);
    return "M "+x1+" "+y1+" A "+r+" "+r+" 0 "+((e-s)>.5?1:0)+" 1 "+x2+" "+y2;
  }
  return (
    <svg width="96" height="96" viewBox="0 0 100 100">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw}/>
      {segs.map(s => <path key={s.key} d={arc(s.start,s.start+s.pct)} fill="none" stroke={cols[s.key]} strokeWidth={sw} strokeLinecap="butt"/>)}
    </svg>
  );
}

// ─── AUTH LOGIN ───────────────────────────────────────────────────────────────
function LoginScreen({onLogin}) {
  const [email,setEmail]       = useState("");
  const [password,setPassword] = useState("");
  const [loading,setLoading]   = useState(false);
  const [error,setError]       = useState("");

  async function signIn(e) {
    e.preventDefault();
    setLoading(true); setError("");
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message); setLoading(false); return; }
    // Fetch role from instructors table
    const { data: inst } = await supabase.from("instructors").select("role").eq("email", email).single();
    onLogin(data.user, inst?.role || "instructor");
  }

  return (
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 20% 0%, #1a3a1a 0%, "+T.bg+" 60%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28,gap:28}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:48,fontWeight:900,color:T.white,letterSpacing:-2}}>HILLARY</div>
        <div style={{fontSize:11,letterSpacing:8,color:T.muted,textTransform:"uppercase"}}>OUTDOORS</div>
        <div style={{fontSize:14,color:T.muted,marginTop:8}}>Gear Management System</div>
      </div>
      <form onSubmit={signIn} style={{width:"100%",maxWidth:360,display:"flex",flexDirection:"column",gap:12}}>
        {error && <div style={{background:"rgba(192,57,43,0.14)",border:"1px solid rgba(192,57,43,0.4)",borderRadius:9,padding:"10px 14px",fontSize:13,color:"#ff8a7a"}}>{error}</div>}
        <div>
          <FL>Email</FL>
          <input type="email" placeholder="your@email.com" value={email} onChange={e=>setEmail(e.target.value)} required/>
        </div>
        <div>
          <FL>Password</FL>
          <input type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} required/>
        </div>
        <Btn disabled={loading} style={{width:"100%",marginTop:4}} onClick={signIn}>{loading?"Signing in…":"Sign In"}</Btn>
        <p style={{fontSize:12,color:T.muted,textAlign:"center",lineHeight:1.7}}>
          Manager accounts see the full dashboard. Instructor accounts access the scan & sign-in flow.
        </p>
      </form>
    </div>
  );
}

// ─── QUICK SIGN-IN ────────────────────────────────────────────────────────────
function QuickSignInScreen({currentUser, gear, usage, onSignIn, onReport, onSignAll, onBack}) {
  const myOutItems = useMemo(() => {
    const latest = {};
    usage.forEach(u => {
      if (u.instructor === currentUser.name || u.instructor === currentUser.email) {
        if (!latest[u.gear_id] || u.usage_id > latest[u.gear_id].usage_id) latest[u.gear_id] = u;
      }
    });
    return Object.values(latest)
      .filter(u => u.signed_in_out==="OUT" && !u.time_in)
      .map(u => ({u, g:gear.find(g=>g.gear_id===u.gear_id)}))
      .filter(x => x.g);
  }, [gear, usage, currentUser]);

  return (
    <div style={{padding:24,maxWidth:520,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:14,marginBottom:20}}>← Back to Scan</button>
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:T.white}}>My Signed-Out Gear</div>
        <p style={{fontSize:14,color:T.muted,marginTop:4}}>Items currently out under your account</p>
      </div>
      {myOutItems.length === 0 ? (
        <Card><p style={{color:T.muted,fontSize:14,textAlign:"center",padding:20,lineHeight:1.6}}>✅ All your gear is signed back in.</p></Card>
      ) : (
        <div>
          <Btn onClick={()=>onSignAll(myOutItems)} color="#27ae60" style={{width:"100%",marginBottom:14,fontSize:15}}>
            {"✅ Sign All "+myOutItems.length+" Items Back In"}
          </Btn>
          {myOutItems.map(({u, g}) => (
            <Card key={u.usage_id} style={{padding:14,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:15,fontWeight:600,color:T.white}}>{g.item}</div>
                  <div style={{fontSize:13,color:T.muted,marginTop:2}}>{"ID: "+g.gear_id+" · "+g.location}</div>
                  <div style={{fontSize:12,color:T.muted,marginTop:2}}>{"Out since "+fmtDT(u.time_out)}</div>
                </div>
                <SBadge status={g.status} small/>
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn small color="#27ae60" onClick={()=>onSignIn(g)} style={{flex:1}}>Sign In</Btn>
                <Btn small outline color="#e67e22" onClick={()=>onReport(g)} style={{flex:1}}>Report Issue</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SCAN SCREEN ──────────────────────────────────────────────────────────────
function ScanScreen({currentUser, gear, usage, onScan, onQuickSignIn}) {
  const [scanning,setScan] = useState(false);
  const [inp,setInp]       = useState("");

  const myOutCount = useMemo(() => {
    const latest = {};
    usage.forEach(u => {
      if ((u.instructor === currentUser.name || u.instructor === currentUser.email) && (!latest[u.gear_id] || u.usage_id>latest[u.gear_id].usage_id)) latest[u.gear_id]=u;
    });
    return Object.values(latest).filter(u=>u.signed_in_out==="OUT"&&!u.time_in).length;
  }, [usage, currentUser]);

  async function go() {
    setScan(true);
    setTimeout(async () => {
      let found = null;
      const q = inp.trim();
      if (q) {
        // Try gear_id, physical_serial, qr_code, nfc_tag
        const { data } = await supabase.from("gear")
          .select("*")
          .or(`gear_id.eq.${parseInt(q)||0},physical_serial.ilike.${q},qr_code.ilike.${q},nfc_tag.ilike.${q}`)
          .limit(1);
        found = data?.[0] || null;
      } else {
        // Demo: pick a random active gear item
        found = gear[Math.floor(Math.random()*gear.length)] || null;
      }
      setScan(false);
      onScan(found);
      setInp("");
    }, 1000);
  }

  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"80vh",padding:28,gap:22}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:36,fontWeight:900,color:T.white}}>HILLARY</div>
        <div style={{fontSize:11,letterSpacing:7,color:T.muted,textTransform:"uppercase"}}>OUTDOORS</div>
      </div>
      {myOutCount > 0 && (
        <button onClick={onQuickSignIn} style={{width:"100%",maxWidth:340,background:"rgba(39,174,96,0.13)",border:"1px solid rgba(39,174,96,0.4)",borderRadius:12,padding:"12px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,textAlign:"left"}}>
          <div style={{width:36,height:36,borderRadius:"50%",background:"#27ae60",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <span style={{color:"#fff",fontSize:16,fontWeight:700}}>{myOutCount}</span>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:600,color:"#27ae60"}}>{myOutCount+" item"+(myOutCount>1?"s":"")+" signed out"}</div>
            <div style={{fontSize:12,color:T.muted,marginTop:1}}>Tap to quick sign all gear back in →</div>
          </div>
        </button>
      )}
      <div style={{position:"relative",width:150,height:150,display:"flex",alignItems:"center",justifyContent:"center"}}>
        {scanning && [0,1,2].map(i=><div key={i} style={{position:"absolute",width:"100%",height:"100%",border:"2px solid "+T.accent,borderRadius:"50%",animation:"sr 1.8s ease-out "+(i*.5)+"s infinite"}}/>)}
        <div style={{width:108,height:108,borderRadius:"50%",background:scanning?"radial-gradient(circle,"+T.accent+"33,"+T.g1+")":"radial-gradient(circle,"+T.g2+","+T.g1+")",border:"3px solid "+(scanning?T.accent:T.g2),display:"flex",alignItems:"center",justifyContent:"center",animation:scanning?"pl 1s infinite":"none"}}>
          <svg width="44" height="44" viewBox="0 0 52 52" fill="none">
            <circle cx="26" cy="28" r="14" stroke={scanning?T.accent:T.text} strokeWidth="2.5" fill="none"/>
            <path d="M20 20 C20 14 32 14 32 20" stroke={scanning?T.accent:T.text} strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <path d="M14 20 C14 10 38 10 38 20" stroke={scanning?T.accent:T.text} strokeWidth="2" fill="none" strokeLinecap="round" opacity=".5"/>
          </svg>
        </div>
      </div>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:24,fontWeight:700,color:T.white,marginBottom:6}}>Scan Gear</div>
        <div style={{fontSize:14,color:T.muted}}>Hold device near the gear tag</div>
      </div>
      <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:9}}>
        <input placeholder="Gear ID, serial, or QR code — or leave blank" value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!scanning&&go()}/>
        <Btn onClick={go} disabled={scanning}>{scanning?"Scanning…":"Scan / Look Up"}</Btn>
      </div>
      <p style={{fontSize:12,color:T.muted,textAlign:"center",maxWidth:300,lineHeight:1.7}}>
        Enter a gear_id, physical serial (e.g. T-ATC-01), or QR code string. Leave blank to load a random item.
      </p>
    </div>
  );
}

// ─── GEAR DETAIL (instructor) ─────────────────────────────────────────────────
function GearDetailScreen({item, gear, onBack, onSignOut, onSignIn, onReport, lastAct}) {
  const live = gear.find(g=>g.gear_id===item.gear_id) || item;
  const isRed = live.status==="Red";
  const isOut = live.signed_in_out==="OUT";
  const cool  = lastAct && (Date.now()-lastAct)<3000;
  return (
    <div style={{padding:24,maxWidth:440,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:14,marginBottom:20}}>← Back</button>
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:T.white}}>Gear Details</div>
      </div>
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <div style={{fontSize:20,fontWeight:700,color:T.white}}>{live.item}</div>
            <div style={{fontSize:13,color:T.muted,marginTop:2}}>{"ID: "+live.gear_id+(live.physical_serial?" · "+live.physical_serial:"")}</div>
          </div>
          <SBadge status={live.status}/>
        </div>
        <KV label="Location" value={live.location}/>
        <KV label="Uses" value={(live.number_of_uses||0)+" / "+(live.usage_limit||"—")}/>
        <KV label="Expiry" value={fmtD(live.expiry)}/>
        <KV label="State" value={<span style={{color:isOut?T.accent:"#27ae60",fontWeight:600}}>{isOut?"⬆ Signed Out":"⬇ Signed In"}</span>}/>
        {live.notes && <KV label="Notes" value={live.notes}/>}
        {isRed && <div style={{marginTop:12,background:"rgba(192,57,43,0.17)",border:"1px solid rgba(192,57,43,0.4)",borderRadius:9,padding:"10px 14px",fontSize:14,color:"#ff8a7a"}}>⛔ Red status — cannot be used. Report only.</div>}
        {cool  && <div style={{marginTop:10,background:"rgba(232,98,26,0.12)",border:"1px solid rgba(232,98,26,0.3)",borderRadius:9,padding:"10px 14px",fontSize:14,color:T.accent}}>⏳ Please wait 3 seconds.</div>}
      </Card>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {!isRed && !isOut && <Btn onClick={onSignOut} disabled={cool} color={T.accent}>Sign Out</Btn>}
        {!isRed &&  isOut && <Btn onClick={onSignIn}  disabled={cool} color="#27ae60">Sign In</Btn>}
        <Btn onClick={onReport} color="#3a4a3a" style={{border:"1px solid "+T.border}}>Report Issue</Btn>
      </div>
    </div>
  );
}

// ─── REPORT SCREEN ────────────────────────────────────────────────────────────
function ReportScreen({item, onBack, onSubmit}) {
  const [status,setStatus] = useState("Yellow");
  const [notes,setNotes]   = useState("");
  return (
    <div style={{padding:24,maxWidth:440,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:14,marginBottom:20}}>← Back</button>
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:T.white}}>Report Issue</div>
        <div style={{fontSize:14,color:T.muted,marginTop:3}}>{item.item+" — ID: "+item.gear_id}</div>
      </div>
      <Card style={{marginBottom:16}}>
        <FL>Condition Status</FL>
        {["Red","Orange","Yellow","YellowRepair","Green"].map(s => (
          <label key={s} style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer",padding:"10px 12px",borderRadius:9,background:status===s?(SC[s]||SC.Green).lt:"transparent",border:"1px solid "+(status===s?(SC[s]||SC.Green).bg:"transparent"),marginBottom:7,transition:"all .15s"}}>
            <input type="radio" name="rs" checked={status===s} onChange={()=>setStatus(s)} style={{width:"auto"}}/>
            <div style={{width:11,height:11,borderRadius:"50%",background:(SC[s]||SC.Green).bg,flexShrink:0}}/>
            <div style={{flex:1}}>
              <span style={{fontSize:15,fontWeight:status===s?700:500,color:T.white}}>{s}</span>
              <span style={{fontSize:13,color:T.muted,marginLeft:10}}>{"— "+(SC[s]||SC.Green).meaning}</span>
            </div>
          </label>
        ))}
        <FL>Notes</FL>
        <textarea rows={3} placeholder="Describe what you observed…" value={notes} onChange={e=>setNotes(e.target.value)} style={{resize:"vertical",lineHeight:1.6}}/>
      </Card>
      <Btn onClick={()=>onSubmit(status,notes)} color="#c0392b">Submit Report</Btn>
    </div>
  );
}

// ─── GEAR DETAIL MODAL (manager) ──────────────────────────────────────────────
function DetailModal({itemType, item, onClose, gear, setGear, showToast, workflow, setWorkflow}) {
  const [edit,setEdit] = useState({...item});
  function upd(k,v) { setEdit(e=>({...e,[k]:v})); }

  async function saveGearChanges() {
    const newStatus = calcStatus(edit);
    const { error } = await supabase.from("gear").update({
      item:edit.item, location:edit.location, expiry:edit.expiry,
      usage_limit:Number(edit.usage_limit), number_of_uses:Number(edit.number_of_uses),
      status:newStatus, signed_in_out:edit.signed_in_out, notes:edit.notes
    }).eq("gear_id", item.gear_id);
    if (error) { showToast("❌ "+error.message); return; }
    setGear(g=>g.map(x=>x.gear_id===item.gear_id?{...edit,status:newStatus}:x));
    showToast("✅ Gear item updated"); onClose();
  }

  async function retireGear() {
    const g = gear.find(x=>x.gear_id===item.gear_id);
    if (!g) return;
    await supabase.from("retired_gear").insert({gearlog_id:g.gearlog_id,physical_serial:g.physical_serial,item:g.item,category_id:g.category_id,status:g.status,expiry:g.expiry,number_of_uses:g.number_of_uses,usage_limit:g.usage_limit,location:g.location,notes:g.notes});
    await supabase.from("gear").update({active:false}).eq("gear_id",item.gear_id);
    setGear(gg=>gg.filter(x=>x.gear_id!==item.gear_id));
    showToast("♻️ "+item.item+" retired"); onClose();
  }

  const TITLES = {gear:"Gear Detail"};
  return (
    <Mdl onClose={onClose}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:T.white}}>{TITLES[itemType]||"Detail"}</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:T.muted,fontSize:22,lineHeight:1}}>×</button>
      </div>
      {itemType==="gear" && (
        <div>
          <FL>Item Name</FL><input value={edit.item||""} onChange={e=>upd("item",e.target.value)}/>
          <FL>Location</FL><input value={edit.location||""} onChange={e=>upd("location",e.target.value)}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
            <div><FL>Expiry Date</FL><input type="date" value={edit.expiry?.slice(0,10)||""} onChange={e=>upd("expiry",e.target.value)}/></div>
            <div><FL>Usage Limit</FL><input type="number" value={edit.usage_limit||""} onChange={e=>upd("usage_limit",Number(e.target.value))}/></div>
            <div><FL>Current Uses</FL><input type="number" value={edit.number_of_uses||0} onChange={e=>upd("number_of_uses",Number(e.target.value))}/></div>
            <div>
              <FL>State</FL>
              <select value={edit.signed_in_out||"IN"} onChange={e=>upd("signed_in_out",e.target.value)}>
                <option value="IN">IN — Stored</option><option value="OUT">OUT — In Use</option>
              </select>
            </div>
          </div>
          <FL>Notes</FL>
          <textarea rows={2} value={edit.notes||""} onChange={e=>upd("notes",e.target.value)}/>
          <KV label="Physical Serial" value={item.physical_serial||"—"}/>
          <KV label="QR Code" value={item.qr_code||"—"}/>
          <KV label="NFC Tag" value={item.nfc_tag||"—"}/>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:18}}>
            <Btn onClick={saveGearChanges} color={T.accent}>Save Changes</Btn>
            <Btn onClick={retireGear} outline color="#c0392b">Retire Item</Btn>
          </div>
        </div>
      )}
      {itemType==="usage" && (
        <div>
          <KV label="Usage ID"    value={item.usage_id}/>
          <KV label="Item"        value={item.item}/>
          <KV label="Gear ID"     value={item.gear_id}/>
          <KV label="Action"      value={<span style={{color:item.signed_in_out==="OUT"?T.accent:"#27ae60",fontWeight:600}}>{item.signed_in_out}</span>}/>
          <KV label="Time Out"    value={fmtDT(item.time_out)}/>
          <KV label="Time In"     value={fmtDT(item.time_in)}/>
          <KV label="Instructor"  value={item.instructor}/>
        </div>
      )}
      {itemType==="report" && (
        <div>
          <KV label="Report ID"  value={item.report_id}/>
          <KV label="Item"       value={item.item}/>
          <KV label="Gear ID"    value={item.gear_id}/>
          <KV label="Status"     value={<SBadge status={item.status} small/>}/>
          <KV label="Notes"      value={item.notes}/>
          <KV label="Instructor" value={item.instructor}/>
          <KV label="Reported"   value={fmtDT(item.time_reported)}/>
        </div>
      )}
      {itemType==="workflow" && (
        <div>
          <KV label="Item"  value={item.item}/>
          <KV label="Stage" value={<StgBadge stage={item.workflow_stage}/>}/>
          <KV label="Type"  value={item.purchase_type}/>
          <KV label="Est. Cost" value={nzd(item.estimated_cost)}/>
          {item.grant_name && <KV label="Grant" value={item.grant_name}/>}
          <KV label="Notes" value={item.notes||"—"}/>
        </div>
      )}
    </Mdl>
  );
}

// ─── OVERVIEW TAB ─────────────────────────────────────────────────────────────
function OverviewTab({gear, usage, reports}) {
  const sc = ["Red","Orange","Yellow","Green"].reduce((a,s)=>({...a,[s]:gear.filter(g=>g.status===s).length}),{});
  const recent = [...reports].sort((a,b)=>new Date(b.time_reported)-new Date(a.time_reported)).slice(0,6);
  return (
    <div>
      <PT title="Dashboard" sub="Live gear status, recent activity and upcoming needs."/>
      <div style={{display:"flex",gap:10,marginBottom:18,flexWrap:"wrap"}}>
        {[["Total Gear",gear.length,"#7ab0ff"],["Signed Out",gear.filter(g=>g.signed_in_out==="OUT").length,T.accent],["Red — Unsafe",sc.Red,"#c0392b"],["Orange",sc.Orange,"#e67e22"],["Yellow",sc.Yellow,"#c9a800"],["Green — OK",sc.Green,"#27ae60"]].map(([l,v,c])=>(
          <div key={l} style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"11px 17px",minWidth:95}}>
            <div style={{fontSize:22,fontWeight:700,color:c}}>{v}</div>
            <div style={{fontSize:12,color:T.muted,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      <Card style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:600,color:T.white,marginBottom:14}}>Gear Status Breakdown</p>
        <div style={{display:"flex",alignItems:"center",gap:22,flexWrap:"wrap"}}>
          <DonutChart data={sc}/>
          <div style={{flex:1,minWidth:200}}>
            {["Red","Orange","Yellow","Green"].map(s=>(
              <div key={s} style={{display:"flex",alignItems:"center",gap:9,padding:"7px 0",borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:SC[s].bg,flexShrink:0}}/>
                <SBadge status={s} small/>
                <span style={{fontWeight:600,color:T.white,minWidth:22}}>{sc[s]||0}</span>
                <span style={{fontSize:12,color:T.muted,lineHeight:1.5}}>{SC[s].meaning}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
      <Card>
        <p style={{fontSize:15,fontWeight:600,color:T.white,marginBottom:12}}>Recent Reports</p>
        {recent.length===0 ? <p style={{color:T.muted,fontSize:14,lineHeight:1.6}}>No reports yet.</p> : recent.map(r=>(
          <div key={r.report_id} style={{display:"flex",alignItems:"flex-start",gap:11,padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
            <SBadge status={r.status} small/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:500,color:T.white}}>{r.item+" "}<span style={{fontSize:12,color:T.muted}}>{"by "+r.instructor}</span></div>
              <div style={{fontSize:13,color:T.muted,marginTop:2,lineHeight:1.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.notes}</div>
            </div>
            <div style={{fontSize:12,color:T.muted,whiteSpace:"nowrap"}}>{new Date(r.time_reported).toLocaleDateString("en-NZ",{day:"numeric",month:"short"})}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─── GEAR LIST TAB ────────────────────────────────────────────────────────────
function GearListTab({gear, setGear, showToast}) {
  const [q,setQ]         = useState("");
  const [detail,setDetail] = useState(null);
  const [statusF,setStatusF] = useState("all");
  const filtered = useMemo(()=>{
    let r = sq(gear,q,["item","gear_id","location","status","notes","physical_serial"]);
    if (statusF!=="all") r = r.filter(g=>g.status===statusF);
    return r;
  },[gear,q,statusF]);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:12}}>
        <PT title="Gear List" sub={gear.length+" active items · "+filtered.length+" shown"}/>
        <Btn small color="#27ae60" onClick={()=>dlCSV("GearInventory",gear)}>⬇ Export CSV</Btn>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        {["all","Red","Orange","Yellow","Green"].map(s=>(
          <button key={s} onClick={()=>setStatusF(s)} style={{background:statusF===s?(SC[s]||{bg:T.g2}).bg:T.card,color:statusF===s?"#fff":T.muted,border:"1px solid "+(statusF===s?(SC[s]||{bg:T.g2}).bg:T.border),borderRadius:20,padding:"5px 14px",fontSize:12,fontWeight:600}}>{s==="all"?"All Statuses":s}</button>
        ))}
      </div>
      <SBar value={q} onChange={setQ} ph="Search by name, serial, ID, location, status…"/>
      <p style={{fontSize:13,color:T.muted,marginBottom:10}}>Click any row to edit</p>
      <Card>
        <div className="sx">
          <table>
            <thead><tr><th>ID</th><th>Serial</th><th>Item</th><th>Status</th><th>Location</th><th>Uses</th><th>Expiry</th><th>State</th></tr></thead>
            <tbody>
              {filtered.slice(0,200).map(g=>(
                <tr key={g.gear_id} className="cl" onClick={()=>setDetail(g)}>
                  <td style={{color:T.muted}}>{g.gear_id}</td>
                  <td style={{color:T.muted,fontSize:12}}>{g.physical_serial||"—"}</td>
                  <td style={{fontWeight:500}}>{g.item}</td>
                  <td><SBadge status={g.status} small/></td>
                  <td style={{color:T.muted}}>{g.location}</td>
                  <td>
                    <div style={{display:"flex",alignItems:"center",gap:7}}>
                      <span>{(g.number_of_uses||0)+"/"+(g.usage_limit||"—")}</span>
                      {g.usage_limit && <div style={{width:40,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:Math.min(((g.number_of_uses||0)/g.usage_limit)*100,100)+"%",background:(SC[g.status]||SC.Green).bg,borderRadius:2}}/></div>}
                    </div>
                  </td>
                  <td style={{color:T.muted,fontSize:13,whiteSpace:"nowrap"}}>{fmtD(g.expiry)}</td>
                  <td><span style={{fontSize:13,color:g.signed_in_out==="OUT"?T.accent:"#27ae60",fontWeight:600}}>{g.signed_in_out}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length>200 && <p style={{color:T.muted,fontSize:13,padding:"10px 13px"}}>Showing 200 of {filtered.length} — refine your search to see more.</p>}
        </div>
      </Card>
      {detail && <DetailModal itemType="gear" item={detail} onClose={()=>setDetail(null)} gear={gear} setGear={setGear} showToast={showToast}/>}
    </div>
  );
}

// ─── ADD GEAR TAB ─────────────────────────────────────────────────────────────
function GearEntryTab({gear, setGear, showToast}) {
  const blank = {item:"",status:"Green",expiry:"",number_of_uses:0,signed_in_out:"IN",notes:"",location:"",usage_limit:200,physical_serial:"",category_id:""};
  const [form,setForm] = useState(blank);
  const [qty,setQty]   = useState(1);
  const [cloneQ,setCloneQ] = useState("");
  const [showCP,setShowCP] = useState(false);
  const [cloned,setCloned] = useState(null);
  const [saving,setSaving] = useState(false);
  function upd(k,v) { setForm(f=>({...f,[k]:v})); }
  const filteredClone = useMemo(()=>sq(gear,cloneQ,["item","gear_id","physical_serial","location"]),[gear,cloneQ]);

  async function submit() {
    if (!form.item||!form.location) { showToast("⚠ Fill Item and Location"); return; }
    setSaving(true);
    const rows = [];
    for (let i=0;i<qty;i++) {
      rows.push({
        item:form.item, location:form.location, expiry:form.expiry||null,
        usage_limit:Number(form.usage_limit)||200, number_of_uses:Number(form.number_of_uses)||0,
        status:calcStatus({...form,number_of_uses:Number(form.number_of_uses)||0}),
        signed_in_out:form.signed_in_out, notes:form.notes||"",
        physical_serial:form.physical_serial||(qty>1?form.item.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4)+"-"+String(Date.now()).slice(-4)+"-"+i:""),
        qr_code:"QR-"+Date.now()+"-"+i, nfc_tag:"NFC-"+Date.now()+"-"+i,
        category_id:form.category_id||null, active:true
      });
    }
    const { data, error } = await supabase.from("gear").insert(rows).select();
    if (error) { showToast("❌ "+error.message); setSaving(false); return; }
    setGear(g=>[...g,...data]);
    setForm(blank); setCloned(null); setQty(1); setSaving(false);
    showToast("✅ Added "+rows.length+" item"+(rows.length>1?"s":"")+" to inventory");
  }

  return (
    <div>
      <PT title="Add Gear" sub="Add one item or batch-add many copies at once."/>
      <Card>
        {cloned && (
          <div style={{background:"rgba(74,128,200,0.12)",border:"1px solid rgba(74,128,200,0.3)",borderRadius:10,padding:"11px 14px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
            <div style={{fontSize:14,color:"#7ab0ff",fontWeight:600}}>{"📋 Pre-filled from: "+cloned.item}</div>
            <button onClick={()=>{setCloned(null);setForm(blank);}} style={{background:"none",border:"none",color:T.muted,fontSize:20}}>×</button>
          </div>
        )}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div>
            <span style={{fontSize:13,color:T.muted,marginRight:8}}>Quantity:</span>
            <input type="number" min={1} max={200} value={qty} onChange={e=>setQty(Math.max(1,parseInt(e.target.value)||1))} style={{width:70,display:"inline-block"}}/>
          </div>
          <Btn small outline color="#4a80c8" onClick={()=>setShowCP(x=>!x)}>⎘ Clone From Existing</Btn>
        </div>
        {showCP && (
          <div style={{background:"rgba(74,128,200,0.08)",border:"1px solid rgba(74,128,200,0.2)",borderRadius:9,padding:13,marginBottom:13}}>
            <SBar value={cloneQ} onChange={setCloneQ} ph="Search by name or serial…"/>
            <div style={{maxHeight:180,overflowY:"auto"}}>
              {filteredClone.slice(0,8).map(g=>(
                <div key={g.gear_id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:7,cursor:"pointer",marginBottom:4,background:"rgba(255,255,255,0.03)",border:"1px solid "+T.border}}>
                  <span style={{fontSize:14,color:T.white}}>{g.item+" "}<span style={{fontSize:12,color:T.muted}}>#{g.gear_id}</span></span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}><SBadge status={g.status} small/><Btn small color="#4a80c8" onClick={()=>{setForm({item:g.item,status:g.status,expiry:g.expiry?.slice(0,10)||"",number_of_uses:0,signed_in_out:"IN",notes:"",location:g.location||"",usage_limit:g.usage_limit||200,physical_serial:"",category_id:g.category_id||""});setCloned(g);setShowCP(false);showToast("📋 Pre-filled — edit before saving");}}>Use</Btn></div>
                </div>
              ))}
            </div>
          </div>
        )}
        <FL>Item Name *</FL>
        <input placeholder="e.g. Belay Device" value={form.item} onChange={e=>upd("item",e.target.value)}/>
        <FL>Location *</FL>
        <input placeholder="e.g. L04" value={form.location} onChange={e=>upd("location",e.target.value)}/>
        <FL>Physical Serial</FL>
        <input placeholder="e.g. T-ATC-01 (leave blank to auto-generate)" value={form.physical_serial} onChange={e=>upd("physical_serial",e.target.value)}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
          <div><FL>Expiry Date</FL><input type="date" value={form.expiry} onChange={e=>upd("expiry",e.target.value)}/></div>
          <div><FL>Usage Limit</FL><input type="number" value={form.usage_limit} onChange={e=>upd("usage_limit",Number(e.target.value))}/></div>
        </div>
        <FL>Initial State</FL>
        <select value={form.signed_in_out} onChange={e=>upd("signed_in_out",e.target.value)}>
          <option value="IN">IN — Stored</option><option value="OUT">OUT — In Use</option>
        </select>
        <FL>Notes</FL>
        <textarea rows={2} placeholder="Any initial notes…" value={form.notes} onChange={e=>upd("notes",e.target.value)}/>
        <div style={{display:"flex",gap:10,marginTop:14}}>
          <Btn onClick={submit} color={T.accent} style={{flex:1}} disabled={saving}>{saving?"Saving…":qty>1?"Add "+qty+" Items":"Add to Inventory"}</Btn>
          {form.item && <Btn onClick={()=>{setForm(blank);setCloned(null);setQty(1);}} outline color={T.muted} small>Clear</Btn>}
        </div>
      </Card>
    </div>
  );
}

// ─── USAGE TAB ────────────────────────────────────────────────────────────────
function UsageTab({usage, openDetail}) {
  const [q,setQ] = useState("");
  const filtered = useMemo(()=>sq([...usage].reverse(),q,["item","gear_id","instructor","signed_in_out"]),[usage,q]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:12}}>
        <PT title="Usage Log"/>
        <Btn small color="#27ae60" onClick={()=>dlCSV("UsageLog",usage)}>⬇ Export CSV</Btn>
      </div>
      <SBar value={q} onChange={setQ} ph="Search by item, gear ID, instructor…"/>
      <Card>
        <div className="sx">
          <table>
            <thead><tr><th>ID</th><th>Item</th><th>Gear ID</th><th>Action</th><th>Time Out</th><th>Time In</th><th>Instructor</th></tr></thead>
            <tbody>
              {filtered.slice(0,500).map(u=>(
                <tr key={u.usage_id} className="cl" onClick={()=>openDetail("usage",u)}>
                  <td style={{color:T.muted}}>{u.usage_id}</td>
                  <td style={{fontWeight:500}}>{u.item}</td>
                  <td style={{color:T.muted}}>{u.gear_id}</td>
                  <td><span style={{fontSize:13,color:u.signed_in_out==="OUT"?T.accent:"#27ae60",fontWeight:600}}>{u.signed_in_out}</span></td>
                  <td style={{fontSize:13,color:T.muted,whiteSpace:"nowrap"}}>{fmtDT(u.time_out)}</td>
                  <td style={{fontSize:13,color:T.muted,whiteSpace:"nowrap"}}>{fmtDT(u.time_in)}</td>
                  <td>{u.instructor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── REPORTS TAB ──────────────────────────────────────────────────────────────
function ReportsTab({reports, openDetail}) {
  const [q,setQ] = useState("");
  const filtered = useMemo(()=>sq([...reports].reverse(),q,["item","gear_id","instructor","status","notes"]),[reports,q]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:12}}>
        <PT title="Issue Reports"/>
        <Btn small color="#27ae60" onClick={()=>dlCSV("Reports",reports)}>⬇ Export CSV</Btn>
      </div>
      <SBar value={q} onChange={setQ} ph="Search by item, instructor, status, notes…"/>
      <Card>
        <div className="sx">
          <table>
            <thead><tr><th>ID</th><th>Item</th><th>Gear ID</th><th>Status</th><th>Notes</th><th>Instructor</th><th>Reported</th></tr></thead>
            <tbody>
              {filtered.slice(0,500).map(r=>(
                <tr key={r.report_id} className="cl" onClick={()=>openDetail("report",r)}>
                  <td style={{color:T.muted}}>{r.report_id}</td>
                  <td style={{fontWeight:500}}>{r.item}</td>
                  <td style={{color:T.muted}}>{r.gear_id}</td>
                  <td><SBadge status={r.status} small/></td>
                  <td style={{fontSize:13,color:T.muted,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.notes}</td>
                  <td style={{whiteSpace:"nowrap"}}>{r.instructor}</td>
                  <td style={{fontSize:13,color:T.muted,whiteSpace:"nowrap"}}>{fmtDT(r.time_reported)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── RETIRED TAB ──────────────────────────────────────────────────────────────
function RetiredTab({retired}) {
  const [q,setQ] = useState("");
  const filtered = useMemo(()=>sq(retired,q,["item","gear_id","notes","location"]),[retired,q]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:12}}>
        <PT title="Retired Gear"/>
        <Btn small color="#27ae60" onClick={()=>dlCSV("RetiredGear",retired)}>⬇ Export CSV</Btn>
      </div>
      <SBar value={q} onChange={setQ} ph="Search retired items…"/>
      <Card>
        <div className="sx">
          <table>
            <thead><tr><th>ID</th><th>Item</th><th>Status</th><th>Uses</th><th>Location</th><th>Notes</th></tr></thead>
            <tbody>
              {filtered.map(r=>(
                <tr key={r.gear_id} style={{opacity:.7}}>
                  <td style={{color:T.muted}}>{r.gear_id}</td>
                  <td style={{textDecoration:"line-through",color:T.muted}}>{r.item}</td>
                  <td><SBadge status={r.status} small/></td>
                  <td style={{color:T.muted}}>{(r.number_of_uses||0)+"/"+(r.usage_limit||"—")}</td>
                  <td style={{color:T.muted}}>{r.location}</td>
                  <td style={{fontSize:13,color:T.muted}}>{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── PURCHASING TAB ───────────────────────────────────────────────────────────
function PurchasingTab({workflow, setWorkflow, prevPurchases, showToast, openDetail}) {
  const [sub,setSub]       = useState("pipeline");
  const [budget,setBudget] = useState(6000);

  function updItem(id,ch) {
    setWorkflow(w=>w.map(x=>x.wf_id===id?{...x,...ch}:x));
    supabase.from("workflow").update(ch).eq("wf_id",id);
  }
  function runAlloc() { setWorkflow(smartAllocate(workflow,budget)); setSub("allocation"); showToast("🧠 Smart allocation complete"); }

  const active = workflow.filter(w=>w.workflow_stage!=="entered");
  const bi = active.filter(w=>w.allocated_to==="budget");
  const gi = active.filter(w=>w.allocated_to==="grant");
  const ua = active.filter(w=>!w.allocated_to||w.allocated_to==="unallocated");
  const bs = bi.reduce((a,b)=>a+(b.estimated_cost||0),0);
  const ga = gi.reduce((a,b)=>a+(b.estimated_cost||0),0);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:12}}>
        <PT title="Purchasing Workflow"/>
        <div style={{display:"flex",gap:9,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,background:T.card,border:"1px solid "+T.border,borderRadius:9,padding:"7px 13px"}}>
            <span style={{fontSize:13,color:T.muted}}>Budget NZD</span>
            <input type="number" value={budget} onChange={e=>setBudget(Number(e.target.value))} style={{width:88,padding:"4px 8px",fontSize:14}}/>
          </div>
          <Btn small color="#4a80c8" onClick={runAlloc}>🧠 Smart Allocate</Btn>
        </div>
      </div>
      <div style={{display:"flex",marginBottom:20,borderBottom:"1px solid "+T.border}}>
        {[{id:"pipeline",label:"Pipeline"},{id:"allocation",label:"Budget Allocation"},{id:"previous",label:"Previous Purchases"}].map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)} style={{padding:"8px 17px",background:"none",border:"none",borderBottom:sub===t.id?"2px solid "+T.accent:"2px solid transparent",color:sub===t.id?T.white:T.muted,fontSize:14,fontWeight:sub===t.id?600:400,marginBottom:-1}}>
            {t.label}{t.id==="pipeline"&&active.length>0?<span style={{marginLeft:5,background:T.accent,color:"#fff",borderRadius:10,padding:"0 5px",fontSize:10,fontWeight:700}}>{active.length}</span>:null}
          </button>
        ))}
      </div>
      {sub==="pipeline" && (
        <Card>
          {active.length===0 ? <p style={{color:T.muted,fontSize:14,lineHeight:1.6}}>No active workflow items.</p>
            : [...active].sort((a,b)=>(a.priority||4)-(b.priority||4)).map(w=>(
              <div key={w.wf_id} onClick={()=>openDetail("workflow",w)} style={{background:T.card,border:"1px solid "+T.border,borderRadius:10,padding:14,marginBottom:10,cursor:"pointer"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                  <div>
                    <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:14,fontWeight:600,color:T.white}}>{w.item}</span>
                      {w.status && <SBadge status={w.status} small/>}
                      <StgBadge stage={w.workflow_stage}/>
                    </div>
                    <div style={{fontSize:12,color:T.muted,marginTop:4}}>{"P"+(w.priority||"—")+(w.estimated_cost?" · Est "+nzd(w.estimated_cost):"")}</div>
                  </div>
                  <div style={{display:"flex",gap:7}}>
                    <select value={w.workflow_stage} onChange={e=>{e.stopPropagation();updItem(w.wf_id,{workflow_stage:e.target.value});}} onClick={e=>e.stopPropagation()} style={{width:"auto",padding:"4px 8px",fontSize:12}}>
                      {Object.keys(STGC).map(s=><option key={s} value={s}>{STGC[s].label}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ))}
        </Card>
      )}
      {sub==="allocation" && (
        <div>
          {ua.length>0 && <Card style={{marginBottom:14,border:"1px solid rgba(74,120,200,0.3)"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}><p style={{fontSize:14,fontWeight:600,color:"#7ab0ff"}}>{ua.length+" item(s) not allocated"}</p><Btn small color="#4a80c8" onClick={runAlloc}>Run Allocation</Btn></div></Card>}
          <Card style={{marginBottom:14,border:"1px solid rgba(39,174,96,0.28)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <p style={{fontSize:15,fontWeight:600,color:"#27ae60"}}>💰 Operational Budget</p>
              <div style={{textAlign:"right"}}><div style={{fontSize:18,fontWeight:700,color:T.white}}>{nzd(bs)}</div><div style={{fontSize:12,color:bs>budget?"#ff8a7a":"#7adf9a"}}>{bs>budget?"⚠ over by "+nzd(bs-budget):nzd(budget-bs)+" remaining"}</div></div>
            </div>
            {bi.length===0 ? <p style={{color:T.muted,fontSize:14}}>No items in budget yet.</p>
              : bi.map(w=><div key={w.wf_id} style={{padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.05)"}}><span style={{fontSize:14,color:T.white}}>{w.item}</span><span style={{float:"right",fontSize:13,color:"#7adf9a"}}>{nzd(w.estimated_cost)}</span></div>)}
          </Card>
          <Card style={{border:"1px solid rgba(74,120,200,0.28)"}}>
            <p style={{fontSize:15,fontWeight:600,color:"#7ab0ff",marginBottom:12}}>🏛 Grant Application — {nzd(ga)}</p>
            {gi.length===0 ? <p style={{color:T.muted,fontSize:14}}>No items for grant yet.</p>
              : gi.map(w=><div key={w.wf_id} style={{padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.05)"}}><span style={{fontSize:14,color:T.white}}>{w.item}</span><span style={{float:"right",fontSize:13,color:"#7ab0ff"}}>{nzd(w.estimated_cost)}</span></div>)}
          </Card>
        </div>
      )}
      {sub==="previous" && (
        <Card>
          {prevPurchases.length===0 ? <p style={{color:T.muted,fontSize:14,lineHeight:1.6}}>No previous purchases recorded.</p>
            : (
              <div className="sx">
                <table>
                  <thead><tr><th>Item</th><th>Type</th><th>Cost</th><th>Supplier</th><th>Date</th></tr></thead>
                  <tbody>
                    {prevPurchases.map(p=>(
                      <tr key={p.prev_id}>
                        <td style={{fontWeight:500}}>{p.item}</td>
                        <td><span style={{fontSize:11,background:p.purchase_type==="grant"?"rgba(74,120,200,0.14)":"rgba(39,174,96,0.14)",color:p.purchase_type==="grant"?"#7ab0ff":"#27ae60",padding:"2px 7px",borderRadius:20,fontWeight:700}}>{(p.purchase_type||"").toUpperCase()}</span></td>
                        <td style={{fontWeight:600}}>{nzd(p.final_cost)}</td>
                        <td style={{color:T.muted}}>{p.supplier||"—"}</td>
                        <td style={{color:T.muted,fontSize:13}}>{fmtD(p.purchase_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      )}
    </div>
  );
}

// ─── EXPORTS TAB ──────────────────────────────────────────────────────────────
function ExportsTab({gear, usage, reports, retired}) {
  const rows = [
    {label:"Full Gear Inventory",   desc:"All active gear — ID, status, expiry, uses, location",        icon:"📦",col:"#27ae60",fn:()=>dlCSV("GearInventory",  gear)},
    {label:"Usage Log",             desc:"Complete sign in/out history with instructors and timestamps", icon:"📋",col:"#4a80c8",fn:()=>dlCSV("UsageLog",       usage)},
    {label:"Issue Reports",         desc:"All reported issues with status levels and notes",             icon:"⚠", col:"#e67e22",fn:()=>dlCSV("Reports",         reports)},
    {label:"Retired Gear Archive",  desc:"Archive of all retired equipment",                            icon:"♻", col:"#6a8a6a",fn:()=>dlCSV("RetiredGear",     retired)},
  ];
  return (
    <div>
      <PT title="Audit Exports" sub="Download CSV files for audits, compliance, or board reports."/>
      <div style={{display:"grid",gap:10}}>
        {rows.map(ex=>(
          <div key={ex.label} style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:16,display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}>
            <div style={{display:"flex",gap:14,alignItems:"center"}}>
              <div style={{width:44,height:44,borderRadius:10,background:ex.col+"22",border:"1px solid "+ex.col+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{ex.icon}</div>
              <div>
                <p style={{fontSize:15,fontWeight:600,color:T.white}}>{ex.label}</p>
                <p style={{fontSize:13,color:T.muted,marginTop:2,lineHeight:1.5}}>{ex.desc}</p>
              </div>
            </div>
            <Btn small color={ex.col} onClick={ex.fn} style={{flexShrink:0}}>⬇ Export</Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── INSTRUCTORS TAB ──────────────────────────────────────────────────────────
function InstructorsTab({instructors, setInstructors, showToast}) {
  const [name,setName]   = useState("");
  const [email,setEmail] = useState("");
  const [role,setRole]   = useState("instructor");
  const [sent,setSent]   = useState(null);
  const [sending,setSending] = useState(false);

  async function sendInvite() {
    if (!name||!email) return;
    setSending(true);
    // Insert into instructors table so they appear immediately
    const { data, error } = await supabase.from("instructors").insert({name,email,role,status:"pending",joined_date:new Date().toISOString().slice(0,10)}).select().single();
    // Trigger Supabase Auth invite (manager must have service key in an Edge Function for this in production)
    // For now we record in the table and show confirmation
    if (error) { showToast("❌ "+error.message); setSending(false); return; }
    setInstructors(p=>[...p,data]);
    setSent({name,email}); setName(""); setEmail(""); setSending(false);
    showToast("✅ Instructor added — send them their invite link");
  }

  return (
    <div>
      <PT title="Instructor Accounts" sub="Manage team access."/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,alignItems:"start"}}>
        <Card>
          <p style={{fontSize:15,fontWeight:600,color:T.white,marginBottom:14}}>Add Instructor</p>
          {sent && (
            <div style={{background:"rgba(39,174,96,0.12)",border:"1px solid rgba(39,174,96,0.3)",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
              <p style={{fontSize:14,fontWeight:600,color:"#27ae60",marginBottom:4}}>{"✅ "+sent.name+" added"}</p>
              <p style={{fontSize:13,color:T.muted,lineHeight:1.7}}>Next: go to your Supabase project → Authentication → Users → Invite user, and enter <strong style={{color:T.text}}>{sent.email}</strong>. They will receive a magic link to set their password.</p>
            </div>
          )}
          <FL>Full Name</FL>
          <input placeholder="e.g. Aroha Tane" value={name} onChange={e=>setName(e.target.value)}/>
          <FL>Email Address</FL>
          <input type="email" placeholder="e.g. aroha@hillaryoutdoors.co.nz" value={email} onChange={e=>setEmail(e.target.value)}/>
          <FL>Role</FL>
          <select value={role} onChange={e=>setRole(e.target.value)}>
            <option value="instructor">Instructor — scan, sign in/out, report</option>
            <option value="manager">Manager — full dashboard access</option>
          </select>
          <div style={{marginTop:14}}>
            <Btn onClick={sendInvite} disabled={!name||!email||sending} color={T.accent} style={{width:"100%"}}>{sending?"Adding…":"Add Instructor"}</Btn>
          </div>
        </Card>
        <Card>
          <p style={{fontSize:14,fontWeight:600,color:T.white,marginBottom:8}}>Production invite flow</p>
          <p style={{fontSize:13,color:T.muted,lineHeight:1.8}}>
            1. Add the instructor here (records them in the DB)<br/>
            2. Supabase Dashboard → Auth → Users → Invite User<br/>
            3. Enter their email — they get a magic sign-in link<br/>
            4. They click the link, set a password, and are live<br/>
            5. Their role (instructor/manager) controls what they see
          </p>
        </Card>
      </div>
      <Card style={{marginTop:14}}>
        <p style={{fontSize:14,fontWeight:600,color:T.white,marginBottom:12}}>{"Team ("+instructors.length+")"}</p>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
          <tbody>
            {instructors.map(i=>(
              <tr key={i.id}>
                <td style={{fontWeight:500}}>{i.name}</td>
                <td style={{color:T.muted}}>{i.email}</td>
                <td><span style={{fontSize:11,background:"rgba(74,128,200,0.14)",color:"#7ab0ff",padding:"2px 8px",borderRadius:20,fontWeight:700}}>{(i.role||"instructor").toUpperCase()}</span></td>
                <td><span style={{fontSize:11,background:i.status==="active"?"rgba(39,174,96,0.14)":"rgba(212,172,13,0.14)",color:i.status==="active"?"#27ae60":"#c9a800",padding:"2px 8px",borderRadius:20,fontWeight:700}}>{(i.status||"active").toUpperCase()}</span></td>
                <td style={{color:T.muted,fontSize:13}}>{fmtD(i.joined_date||i.joined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── DASHBOARD SHELL ──────────────────────────────────────────────────────────
function Dashboard({currentUser, gear, setGear, usage, reports, retired, workflow, setWorkflow, prevPurchases, showToast, instructors, setInstructors}) {
  const [tab,setTab]   = useState("overview");
  const [open,setOpen] = useState(true);
  const [detail,setDetail] = useState(null);

  function openDetail(type,item) { setDetail({type,item}); }
  function closeDetail() { setDetail(null); }

  const activePurch = workflow.filter(w=>w.workflow_stage!=="entered").length;
  const TABS = [
    {id:"overview",   label:"Dashboard",  icon:"◈"},
    {id:"gear",       label:"Gear List",  icon:"☰"},
    {id:"addgear",    label:"Add Gear",   icon:"+"},
    {id:"usage",      label:"Usage Log",  icon:"↕"},
    {id:"reports",    label:"Reports",    icon:"⚠"},
    {id:"purchasing", label:"Purchasing", icon:"$",badge:activePurch},
    {id:"retired",    label:"Retired",    icon:"✕"},
    {id:"exports",    label:"Exports",    icon:"📊"},
    {id:"instructors",label:"Instructors",icon:"👤"},
  ];

  return (
    <div style={{display:"flex",height:"100vh",overflow:"hidden"}}>
      <div className="sb" style={{width:open?215:46,background:"rgba(0,0,0,0.32)",borderRight:"1px solid "+T.border,display:"flex",flexDirection:"column",position:"relative"}}>
        <button onClick={()=>setOpen(o=>!o)} style={{position:"absolute",top:14,right:-15,zIndex:20,width:30,height:30,borderRadius:"50%",background:"#1a3a1a",border:"1px solid "+T.border,color:T.text,fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.5)"}}>
          {open?"‹":"›"}
        </button>
        {open && (
          <div style={{padding:"18px 18px 15px",borderBottom:"1px solid "+T.border}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:900,color:T.white}}>HILLARY</div>
            <div style={{fontSize:9,letterSpacing:5,color:T.muted,textTransform:"uppercase"}}>OUTDOORS</div>
            <div style={{fontSize:11,color:T.muted,marginTop:6}}>{currentUser.name||currentUser.email}</div>
          </div>
        )}
        <nav style={{flex:1,padding:open?"12px 0":"10px 0",overflowY:"auto",overflowX:"hidden"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} title={!open?t.label:undefined} style={{display:"flex",width:"100%",textAlign:"left",padding:open?"9px 18px":"9px 0",justifyContent:open?"space-between":"center",background:tab===t.id?"rgba(255,255,255,0.08)":"none",border:"none",borderLeft:open&&tab===t.id?"3px solid "+T.accent:"3px solid transparent",color:tab===t.id?T.white:T.muted,fontSize:12,fontWeight:tab===t.id?600:400,transition:"all .12s",alignItems:"center",overflow:"hidden",whiteSpace:"nowrap"}}>
              {open ? (
                <span style={{display:"flex",justifyContent:"space-between",width:"100%",alignItems:"center"}}>
                  <span>{t.label}</span>
                  {t.badge>0 && <span style={{background:T.accent,color:"#fff",borderRadius:10,padding:"0 6px",fontSize:10,fontWeight:700}}>{t.badge}</span>}
                </span>
              ) : (
                <div style={{position:"relative",width:24,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <span style={{fontSize:13}}>{t.icon}</span>
                  {t.badge>0 && <span style={{position:"absolute",top:-4,right:-4,background:T.accent,color:"#fff",borderRadius:"50%",width:12,height:12,fontSize:8,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{t.badge}</span>}
                </div>
              )}
            </button>
          ))}
        </nav>
        {open && <div style={{padding:"10px 18px",fontSize:11,color:T.muted}}>Manager View</div>}
      </div>

      <div style={{flex:1,overflow:"auto",padding:24}}>
        {tab==="overview"    && <OverviewTab    gear={gear} usage={usage} reports={reports}/>}
        {tab==="gear"        && <GearListTab    gear={gear} setGear={setGear} showToast={showToast}/>}
        {tab==="addgear"     && <GearEntryTab   gear={gear} setGear={setGear} showToast={showToast}/>}
        {tab==="usage"       && <UsageTab       usage={usage} openDetail={openDetail}/>}
        {tab==="reports"     && <ReportsTab     reports={reports} openDetail={openDetail}/>}
        {tab==="purchasing"  && <PurchasingTab  workflow={workflow} setWorkflow={setWorkflow} prevPurchases={prevPurchases} showToast={showToast} openDetail={openDetail}/>}
        {tab==="retired"     && <RetiredTab     retired={retired}/>}
        {tab==="exports"     && <ExportsTab     gear={gear} usage={usage} reports={reports} retired={retired}/>}
        {tab==="instructors" && <InstructorsTab instructors={instructors} setInstructors={setInstructors} showToast={showToast}/>}
      </div>

      {detail && (
        <DetailModal
          itemType={detail.type} item={detail.item} onClose={closeDetail}
          gear={gear} setGear={setGear} showToast={showToast}
          workflow={workflow} setWorkflow={setWorkflow}
        />
      )}
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App() {
  const [authUser,  setAuthUser]  = useState(null);
  const [userRole,  setUserRole]  = useState(null);
  const [loading,   setLoading]   = useState(true);

  // Data state
  const [gear,          setGear]          = useState([]);
  const [usage,         setUsage]         = useState([]);
  const [reports,       setReports]       = useState([]);
  const [retired,       setRetired]       = useState([]);
  const [workflow,      setWorkflow]      = useState([]);
  const [prevPurchases, setPrevPurchases] = useState([]);
  const [instructors,   setInstructors]   = useState([]);

  // Instructor view state
  const [view,     setView]     = useState("scan");
  const [selected, setSelected] = useState(null);
  const [fromQuick,setFromQuick]= useState(false);
  const [lastAct,  setLastAct]  = useState(null);
  const [toast,    setToast]    = useState("");

  // ── Auth init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const { data: inst } = await supabase.from("instructors").select("*").eq("email", session.user.email).single();
        setAuthUser({...session.user, name: inst?.name || session.user.email});
        setUserRole(inst?.role || "instructor");
      }
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        const { data: inst } = await supabase.from("instructors").select("*").eq("email", session.user.email).single();
        setAuthUser({...session.user, name: inst?.name || session.user.email});
        setUserRole(inst?.role || "instructor");
      } else {
        setAuthUser(null); setUserRole(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Load data when authed ──────────────────────────────────────────────────
  useEffect(() => {
    if (!authUser) return;
    loadData();
  }, [authUser]);

  async function loadData() {
    const [g, u, r, ret, wf, pp, ins] = await Promise.all([
      supabase.from("gear").select("*").eq("active",true).order("gear_id"),
      supabase.from("usage_log").select("*").order("usage_id", {ascending:false}).limit(1000),
      supabase.from("reports").select("*").order("report_id", {ascending:false}).limit(500),
      supabase.from("retired_gear").select("*").order("gear_id", {ascending:false}).limit(500),
      supabase.from("workflow").select("*").order("priority"),
      supabase.from("previous_purchases").select("*").order("prev_id", {ascending:false}),
      supabase.from("instructors").select("*").order("name"),
    ]);
    if (g.data)   setGear(g.data);
    if (u.data)   setUsage(u.data);
    if (r.data)   setReports(r.data);
    if (ret.data) setRetired(ret.data);
    if (wf.data)  setWorkflow(wf.data);
    if (pp.data)  setPrevPurchases(pp.data);
    if (ins.data) setInstructors(ins.data);
  }

  function showToast(m) { setToast(m); setTimeout(()=>setToast(""),3200); }

  // ── Instructor actions ─────────────────────────────────────────────────────
  async function doSignIn(g) {
    if (g.signed_in_out==="IN") { showToast("⚠ Already signed in"); return; }
    await supabase.from("gear").update({signed_in_out:"IN"}).eq("gear_id",g.gear_id);
    await supabase.from("usage_log").update({time_in:new Date().toISOString(),signed_in_out:"IN"})
      .eq("gear_id",g.gear_id).is("time_in",null);
    setGear(gg=>gg.map(x=>x.gear_id===g.gear_id?{...x,signed_in_out:"IN"}:x));
    setUsage(u=>u.map(x=>x.gear_id===g.gear_id&&!x.time_in?{...x,time_in:new Date().toISOString(),signed_in_out:"IN"}:x));
    showToast("✅ "+g.item+" signed in");
  }

  async function doSignOut(g) {
    if (g.status==="Red")        { showToast("⛔ Red — cannot sign out"); return; }
    if (g.signed_in_out==="OUT") { showToast("⚠ Already signed out"); return; }
    const nu = (g.number_of_uses||0)+1;
    const ns = calcStatus({...g,number_of_uses:nu});
    await supabase.from("gear").update({signed_in_out:"OUT",number_of_uses:nu,status:ns}).eq("gear_id",g.gear_id);
    const newUsage = {gear_id:g.gear_id,item:g.item,signed_in_out:"OUT",time_out:new Date().toISOString(),time_in:null,instructor:authUser.name||authUser.email,use_number_on_item:nu};
    const { data: ud } = await supabase.from("usage_log").insert(newUsage).select().single();
    setGear(gg=>gg.map(x=>x.gear_id===g.gear_id?{...x,signed_in_out:"OUT",number_of_uses:nu,status:ns}:x));
    if (ud) setUsage(u=>[ud,...u]);
    showToast("✅ "+g.item+" signed out");
  }

  async function handleReport(status, notes) {
    const g = gear.find(x=>x.gear_id===selected.gear_id);
    const newReport = {gear_id:g.gear_id,item:g.item,status,notes,instructor:authUser.name||authUser.email,time_reported:new Date().toISOString()};
    const { data: rd } = await supabase.from("reports").insert(newReport).select().single();
    await supabase.from("gear").update({status,notes}).eq("gear_id",g.gear_id);
    setGear(gg=>gg.map(x=>x.gear_id===g.gear_id?{...x,status,notes}:x));
    if (rd) setReports(r=>[rd,...r]);
    if (fromQuick) { doSignIn(g); setFromQuick(false); }
    showToast("📋 Report submitted — "+status);
    setView("scan");
  }

  function handleScan(item) {
    if (!item) { showToast("⚠ Gear not found"); return; }
    setSelected(item); setView("detail");
  }

  function handleSignOut() {
    const now = Date.now();
    if (lastAct&&now-lastAct<3000) { showToast("⏳ Wait 3 seconds"); return; }
    const g = gear.find(x=>x.gear_id===selected.gear_id);
    doSignOut(g); setLastAct(now); setView("scan");
  }
  function handleSignIn() {
    const now = Date.now();
    if (lastAct&&now-lastAct<3000) { showToast("⏳ Wait 3 seconds"); return; }
    const g = gear.find(x=>x.gear_id===selected.gear_id);
    doSignIn(g); setLastAct(now); setView("scan");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setAuthUser(null); setUserRole(null); setGear([]); setUsage([]); setReports([]);
  }

  const bg = {minHeight:"100vh",background:"radial-gradient(ellipse at 20% 0%, #1a3a1a 0%, "+T.bg+" 60%)"};

  if (loading) return <><style>{CSS}</style><div style={{...bg,display:"flex",justifyContent:"center",alignItems:"center"}}><Spinner/></div></>;
  if (!authUser) return <><style>{CSS}</style><LoginScreen onLogin={(user,role)=>{setAuthUser(user);setUserRole(role);}}/><Toast msg={toast}/></>;

  if (userRole==="instructor") return (
    <>
      <style>{CSS}</style>
      <div style={bg}>
        <div style={{position:"fixed",top:12,right:12,zIndex:100}}>
          <button onClick={handleLogout} style={{background:"rgba(0,0,0,0.4)",border:"1px solid "+T.border,color:T.muted,borderRadius:8,padding:"5px 13px",fontSize:12}}>Sign Out</button>
        </div>
        {view==="scan"        && <ScanScreen       currentUser={authUser} gear={gear} usage={usage} onScan={handleScan} onQuickSignIn={()=>setView("quickSignIn")}/>}
        {view==="quickSignIn" && <QuickSignInScreen currentUser={authUser} gear={gear} usage={usage} onSignIn={doSignIn} onReport={g=>{setSelected(g);setFromQuick(true);setView("report");}} onSignAll={items=>{items.forEach(({g})=>doSignIn(g));showToast("✅ All items signed in");setView("scan");}} onBack={()=>setView("scan")}/>}
        {view==="detail"      && selected && <GearDetailScreen item={selected} gear={gear} onBack={()=>setView("scan")} onSignOut={handleSignOut} onSignIn={handleSignIn} onReport={()=>setView("report")} lastAct={lastAct}/>}
        {view==="report"      && selected && <ReportScreen item={selected} onBack={()=>setView(fromQuick?"quickSignIn":"detail")} onSubmit={handleReport}/>}
      </div>
      <Toast msg={toast}/>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div style={bg}>
        <div style={{position:"fixed",top:12,right:12,zIndex:100}}>
          <button onClick={handleLogout} style={{background:"rgba(0,0,0,0.4)",border:"1px solid "+T.border,color:T.muted,borderRadius:8,padding:"5px 13px",fontSize:12}}>Sign Out</button>
        </div>
        <Dashboard
          currentUser={authUser}
          gear={gear} setGear={setGear}
          usage={usage} reports={reports}
          retired={retired}
          workflow={workflow} setWorkflow={setWorkflow}
          prevPurchases={prevPurchases}
          showToast={showToast}
          instructors={instructors} setInstructors={setInstructors}
        />
      </div>
      <Toast msg={toast}/>
    </>
  );
}
