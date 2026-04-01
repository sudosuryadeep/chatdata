// ═══════════════════════════════════════════════════
// BOTDESK SHARED DASHBOARD ENGINE — dashboard-base.js
// ═══════════════════════════════════════════════════
'use strict';

// ── State ──────────────────────────────────────────
let SB=null, SESSION=null, BOT_TOKEN='';
let users={}, currentCid=null, lastUpdateId=0;
let pollTimer=null, sentCount=0, blockedUsers=new Set();

// ── Init SB ────────────────────────────────────────
function initSB(){
  const url=localStorage.getItem('sb_url'),key=localStorage.getItem('sb_key');
  if(url&&key){ try{SB=supabase.createClient(url,key);}catch(e){} }
}

// ── Boot ───────────────────────────────────────────
async function boot(){
  initSB();
  const raw=localStorage.getItem('bds');
  if(!raw){window.location.href='index.html';return;}
  try{ SESSION=JSON.parse(raw); }catch(e){window.location.href='index.html';return;}
  if(!SESSION.bot_token){window.location.href='index.html';return;}
  BOT_TOKEN=SESSION.bot_token;
  // Fill topbar
  const bi=SESSION.bot_info||{};
  qs('#tb-botname').textContent=bi.first_name||SESSION.name||'Bot';
  qs('#tb-username').textContent=bi.username?'@'+bi.username:'';
  qs('#tb-admin').textContent=SESSION.name||SESSION.email||'Admin';
  // Load data
  await loadBlockedFromDB();
  await loadMsgsFromDB();
  await fetchUpdates();
  startPoll();
  log('Connected: '+(bi.username||SESSION.email),'ok');
}

// ── TG API ─────────────────────────────────────────
const TG=(m,p={})=>fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}).then(r=>r.json());

// ── Fetch updates ──────────────────────────────────
async function fetchUpdates(){
  const rbtn=qs('#refresh-btn');
  if(rbtn)rbtn.classList.add('spinning');
  try{
    const res=await TG('getUpdates',{offset:lastUpdateId+1,limit:100,timeout:0,allowed_updates:['message']});
    if(res.ok&&res.result.length){
      for(const u of res.result) await processUpdate(u);
      lastUpdateId=res.result[res.result.length-1].update_id;
      renderSidebar();
      if(currentCid)renderMsgs(currentCid);
      updateStats();
    }
  }catch(e){log('Fetch error: '+e.message,'err');}
  if(rbtn)rbtn.classList.remove('spinning');
}

async function processUpdate(update){
  const msg=update.message; if(!msg) return;
  const chat=msg.chat, from=msg.from||{};
  const cid=String(chat.id);
  if(blockedUsers.has(cid))return;
  if(!users[cid]){
    const name=[from.first_name,from.last_name].filter(Boolean).join(' ')||chat.title||'User';
    users[cid]={chatId:cid,name,username:from.username||'',msgs:[],unread:0,langCode:from.language_code||'',chatType:chat.type||'private',db_id:null};
    await saveUserDB(users[cid]);
  }
  const u=users[cid];
  if(!u.msgs.find(m=>m.msgId===msg.message_id)){
    const m={msgId:msg.message_id,text:msg.text||msg.caption||'',type:getMsgType(msg),date:msg.date,out:false};
    u.msgs.push(m);
    if(cid!==currentCid)u.unread++;
    await saveMsgDB(cid,m);
    await saveUserDB(u);
    log('↩ '+u.name+': '+(msg.text||'[media]').slice(0,28));
  }
}

function getMsgType(m){
  if(m.photo)return'photo';if(m.video)return'video';if(m.document)return'document';
  if(m.audio)return'audio';if(m.voice)return'voice';if(m.sticker)return'sticker';
  if(m.location)return'location';if(m.contact)return'contact';if(m.poll)return'poll';
  return'text';
}

// ── DB ops ─────────────────────────────────────────
async function loadMsgsFromDB(){
  if(!SB||!SESSION.admin_id)return;
  try{
    const{data}=await SB.from('bot_users').select('*,messages(*)').eq('admin_id',SESSION.admin_id);
    if(!data)return;
    data.forEach(u=>{
      const cid=String(u.chat_id);
      if(!users[cid])users[cid]={chatId:cid,name:u.name,username:u.username||'',msgs:[],unread:u.unread_count||0,langCode:u.lang_code||'',chatType:u.chat_type||'private',db_id:u.id};
      if(u.messages){
        u.messages.sort((a,b)=>a.tg_message_id-b.tg_message_id).forEach(m=>{
          if(!users[cid].msgs.find(x=>x.msgId===m.tg_message_id))
            users[cid].msgs.push({msgId:m.tg_message_id,text:m.text||'',type:m.msg_type||'text',date:m.date_ts,out:m.is_out});
        });
      }
    });
    renderSidebar(); updateStats();
  }catch(e){console.error(e);}
}
async function saveUserDB(u){
  if(!SB||!SESSION.admin_id)return;
  try{
    const{data}=await SB.from('bot_users').upsert({admin_id:SESSION.admin_id,chat_id:u.chatId,name:u.name,username:u.username||'',lang_code:u.langCode||'',chat_type:u.chatType||'private',unread_count:u.unread||0,is_blocked:blockedUsers.has(u.chatId),updated_at:new Date().toISOString()},{onConflict:'admin_id,chat_id'}).select('id').single();
    if(data&&!u.db_id)u.db_id=data.id;
  }catch(e){}
}
async function saveMsgDB(cid,m){
  if(!SB||!SESSION.admin_id)return;
  const u=users[cid];
  if(!u.db_id)await saveUserDB(u);
  if(!u.db_id)return;
  try{
    await SB.from('messages').upsert({admin_id:SESSION.admin_id,user_id:u.db_id,tg_message_id:m.msgId,text:m.text||'',msg_type:m.type||'text',date_ts:m.date,is_out:m.out},{onConflict:'admin_id,tg_message_id'});
  }catch(e){}
}
async function loadBlockedFromDB(){
  if(!SB||!SESSION.admin_id)return;
  try{
    const{data}=await SB.from('bot_users').select('chat_id').eq('admin_id',SESSION.admin_id).eq('is_blocked',true);
    if(data)data.forEach(r=>blockedUsers.add(String(r.chat_id)));
  }catch(e){}
}

// ── Send ───────────────────────────────────────────
async function doSend(){
  if(!currentCid)return;
  const ta=qs('#msg-ta');
  const text=ta.value.trim(); if(!text)return;
  const sbtn=qs('#send-btn'); if(sbtn)sbtn.disabled=true;
  try{
    const res=await TG('sendMessage',{chat_id:currentCid,text});
    if(res.ok){
      const m={msgId:res.result.message_id,text,type:'text',date:Math.floor(Date.now()/1000),out:true};
      users[currentCid].msgs.push(m); sentCount++;
      ta.value=''; ta.style.height='auto';
      await saveMsgDB(currentCid,m);
      renderMsgs(currentCid); renderSidebar(); updateStats();
      log('↗ Sent: '+text.slice(0,32),'ok');
    } else throw new Error(res.description);
  }catch(e){toast('Send failed: '+e.message,'err');log('Err: '+e.message,'err');}
  if(sbtn)sbtn.disabled=false;
  ta.focus();
}

// ── Broadcast ──────────────────────────────────────
async function doBroadcast(){
  const ta=qs('#bc-ta'),res=qs('#bc-res'),btn=qs('#bc-btn');
  const text=ta.value.trim();
  if(!text){toast('Message likho pehle','err');return;}
  const list=Object.values(users).filter(u=>!blockedUsers.has(u.chatId));
  if(!list.length){toast('Koi user nahi','err');return;}
  btn.disabled=true; btn.textContent='Sending…'; if(res)res.style.display='none';
  let ok=0,fail=0;
  for(const u of list){
    try{
      const r=await TG('sendMessage',{chat_id:u.chatId,text});
      if(r.ok){ok++;sentCount++;const m={msgId:r.result.message_id,text,type:'text',date:Math.floor(Date.now()/1000),out:true};u.msgs.push(m);await saveMsgDB(u.chatId,m);}
      else fail++;
      await new Promise(r=>setTimeout(r,35));
    }catch{fail++;}
  }
  if(SB&&SESSION.admin_id)await SB.from('broadcast_log').insert({admin_id:SESSION.admin_id,message:text,sent_count:ok,fail_count:fail,created_at:new Date().toISOString()});
  btn.disabled=false; btn.textContent='Broadcast All';
  if(res){res.style.display='';res.className='bc-res'+(fail?'fail':'ok');res.textContent=`✓ ${ok} delivered${fail?' · ✕ '+fail+' failed':''}`;}
  log('Broadcast: '+ok+'/'+list.length,'ok');
  if(currentCid)renderMsgs(currentCid);
  renderSidebar(); updateStats();
}

// ── Block / Clear ──────────────────────────────────
async function toggleBlock(){
  if(!currentCid)return;
  const u=users[currentCid];
  const btn=qs('#block-btn');
  if(blockedUsers.has(currentCid)){
    blockedUsers.delete(currentCid);
    toast(u.name+' unblocked');
    if(btn)btn.textContent='Block';
  }else{
    blockedUsers.add(currentCid);
    toast(u.name+' blocked','err');
    if(btn)btn.textContent='Unblock';
    log('Blocked: '+u.name,'err');
  }
  await saveUserDB(u); renderSidebar();
  updateUserInfo(currentCid);
}
async function clearChat(){
  if(!currentCid)return;
  users[currentCid].msgs=[];
  if(SB&&users[currentCid].db_id)await SB.from('messages').delete().eq('user_id',users[currentCid].db_id);
  renderMsgs(currentCid); toast('Chat cleared');
}

// ── Open chat ──────────────────────────────────────
function openChat(cid){
  currentCid=cid;
  const u=users[cid]; if(!u)return;
  u.unread=0; saveUserDB(u);
  qs('#no-chat')?.style && (qs('#no-chat').style.display='none');
  const cv=qs('#chat-view');
  if(cv){cv.style.display='flex';}
  // header
  const[bg,fg]=pal(parseInt(cid));
  const av=qs('#ch-av');
  if(av){av.style.cssText=`background:${bg};color:${fg};`;av.textContent=ini(u.name);}
  const cn=qs('#ch-name');if(cn)cn.textContent=u.name;
  const cs=qs('#ch-sub');if(cs)cs.textContent=(u.username?'@'+u.username+' · ':'')+cid;
  const bb=qs('#block-btn');if(bb)bb.textContent=blockedUsers.has(cid)?'Unblock':'Block';
  updateUserInfo(cid);
  renderMsgs(cid);
  document.querySelectorAll('[data-cid]').forEach(el=>el.classList.toggle('active',el.dataset.cid===cid));
  updateStats();
  qs('#msg-ta')?.focus?.();
}

function updateUserInfo(cid){
  const u=users[cid]; if(!u)return;
  const uic=qs('#user-info-card');
  if(uic) uic.innerHTML=`
    <div class="uic-row"><span>Chat ID</span><span>${cid}</span></div>
    ${u.username?`<div class="uic-row"><span>Username</span><span>@${esc(u.username)}</span></div>`:''}
    <div class="uic-row"><span>Messages</span><span>${u.msgs.length}</span></div>
    <div class="uic-row"><span>Lang</span><span>${u.langCode||'—'}</span></div>
    <div class="uic-row"><span>Status</span><span style="color:${blockedUsers.has(cid)?'var(--danger)':'var(--ok)'}">${blockedUsers.has(cid)?'Blocked':'Active'}</span></div>
  `;
}

// ── Render sidebar ─────────────────────────────────
function renderSidebar(q=''){
  const ul=qs('#user-list'); if(!ul)return;
  const list=Object.values(users).filter(u=>!q||u.name.toLowerCase().includes(q.toLowerCase())||(u.username||'').toLowerCase().includes(q.toLowerCase()))
    .sort((a,b)=>(b.msgs[b.msgs.length-1]?.date||0)-(a.msgs[a.msgs.length-1]?.date||0));
  if(!list.length){ul.innerHTML='<div class="empty-msg">Koi user nahi aaya abhi 💤</div>';return;}
  ul.innerHTML='';
  list.forEach(u=>{
    const last=u.msgs[u.msgs.length-1];
    const preview=last?(last.out?'↗ ':'')+( last.text||'['+last.type+']'):'—';
    const[bg,fg]=pal(parseInt(u.chatId));
    const el=document.createElement('div');
    el.className='uitem'+(u.chatId===currentCid?' active':'')+(blockedUsers.has(u.chatId)?' blocked':'');
    el.dataset.cid=u.chatId;
    el.innerHTML=`<div class="u-av" style="background:${bg};color:${fg};">${ini(u.name)}</div><div class="u-meta"><div class="u-name">${esc(u.name)}</div><div class="u-prev">${esc(preview.slice(0,38))}${preview.length>38?'…':''}</div></div><div class="u-r">${u.unread>0?`<span class="u-bdg">${u.unread}</span>`:''}${last?`<span class="u-tm">${ts(last.date)}</span>`:''}</div>`;
    el.onclick=()=>{openChat(u.chatId);closeMobileSidebar?.();};
    ul.appendChild(el);
  });
}

// ── Render messages ────────────────────────────────
function renderMsgs(cid){
  const u=users[cid]; if(!u)return;
  const area=qs('#messages'); if(!area)return;
  area.innerHTML='';
  const typeIcons={photo:'🖼️',video:'🎬',document:'📎',audio:'🎵',voice:'🎤',sticker:'🎭',location:'📍',contact:'👤',poll:'📊'};
  let lastDate='';
  u.msgs.forEach(msg=>{
    const d=new Date((msg.date||0)*1000);
    const ds=d.toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});
    if(ds!==lastDate){
      const sep=document.createElement('div');sep.className='date-sep';
      sep.innerHTML=`<span>${ds}</span>`;area.appendChild(sep);lastDate=ds;
    }
    const row=document.createElement('div');
    row.className='msg-row'+(msg.out?' out':'');
    let inner='';
    if(msg.type!=='text')inner+=`<div class="media-tag">${typeIcons[msg.type]||'📎'} ${msg.type}</div>`;
    if(msg.text)inner+=`<div>${esc(msg.text)}</div>`;
    inner+=`<span class="bt">${ft(msg.date)}</span>`;
    const bub=document.createElement('div');
    bub.className='bubble'+(msg.out?' out':' in');
    bub.innerHTML=inner;
    row.appendChild(bub);
    area.appendChild(row);
  });
  area.scrollTop=area.scrollHeight;
}

// ── Stats ──────────────────────────────────────────
function updateStats(){
  const uc=Object.keys(users).length;
  const mc=Object.values(users).reduce((a,u)=>a+u.msgs.length,0);
  const ur=Object.values(users).reduce((a,u)=>a+u.unread,0);
  setText('s-users',uc);setText('s-msgs',mc);setText('s-unread',ur);setText('s-sent',sentCount);
  setText('tb-users',uc);
}
function setText(id,v){const e=qs('#'+id);if(e)e.textContent=v;}

// ── Poll ───────────────────────────────────────────
function startPoll(){
  stopPoll();
  const tog=qs('#auto-poll');
  if(!tog||tog.checked)pollTimer=setInterval(fetchUpdates,5000);
}
function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function togglePoll(){
  if(qs('#auto-poll')?.checked){startPoll();log('Auto-refresh ON','ok');}
  else{stopPoll();log('Auto-refresh OFF');}
}

// ── Log ────────────────────────────────────────────
function log(text,type=''){
  const ll=qs('#log-list');if(!ll)return;
  const el=document.createElement('div');
  el.className='log-item'+(type?' '+type:'');
  el.textContent=`[${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}] ${text}`;
  ll.prepend(el);
  while(ll.children.length>30)ll.removeChild(ll.lastChild);
}

// ── Toast ──────────────────────────────────────────
let _tt;
function toast(msg,type=''){
  const t=qs('#toast');if(!t)return;
  t.textContent=msg;t.className='toast show'+(type?' '+type:'');
  clearTimeout(_tt);_tt=setTimeout(()=>t.className='toast',2600);
}

// ── Logout ─────────────────────────────────────────
function doLogout(){
  stopPoll();
  if(SB)SB.auth.signOut();
  localStorage.removeItem('bds');
  window.location.href='index.html';
}

// ── Helpers ────────────────────────────────────────
const qs=s=>document.querySelector(s);
const PALETTES=[['#1a2820','#4ade80'],['#1a1e30','#60a5fa'],['#2a1a1a','#f87171'],['#201a2a','#c084fc'],['#2a221a','#fbbf24'],['#1a2a2a','#34d399'],['#2a1a22','#f472b6'],['#1a1e2a','#818cf8']];
function pal(id){return PALETTES[Math.abs(id||0)%PALETTES.length];}
function ini(n){return(n||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ts(t){if(!t)return'';const d=new Date(t*1000),n=new Date();return d.toDateString()===n.toDateString()?d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString('en-IN',{day:'numeric',month:'short'});}
function ft(t){if(!t)return'';return new Date(t*1000).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});}

// ── Textarea auto-height ───────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  const ta=qs('#msg-ta');
  if(ta){
    ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}});
    ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,110)+'px';});
  }
  qs('#user-search')?.addEventListener('input',e=>renderSidebar(e.target.value));
  boot();
});
