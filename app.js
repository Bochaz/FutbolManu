/* ============================
   CONFIG — TU JSONBIN
   ============================ */
const BIN_ID = "695ec4fed0ea881f405b8cdf";
const X_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

const API_BASE = "https://api.jsonbin.io/v3/b";
const LS_KEY = "manu_futbol_data_v2";

/* ============================
   UTIL
   ============================ */
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

function uuid(){
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now();
}

function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=>t.classList.remove("show"), 1800);
}

function overlay(show, text="Procesando…"){
  const o = $("#overlay");
  const ot = $("#overlayText");
  ot.textContent = text;
  o.classList.toggle("hidden", !show);
}

function toISODateInput(d=new Date()){
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function fmtDate(iso){
  if (!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  const pad = n => String(n).padStart(2,"0");
  return `${pad(d)}/${pad(m)}/${y}`;
}

function clampInt(v){
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizeUrl(u){
  const s = (u || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low.startsWith("javascript:") || low.startsWith("data:")) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("www.")) return "https://" + s;
  // Basic guess: if it looks like a domain, prefix https://
  if (s.includes(".") && !s.includes(" ")) return "https://" + s;
  return s;
}



function extractYouTubeId(url){
  const u = (url || "").trim();
  if (!u) return null;
  try{
    const nu = normalizeUrl(u);
    const parsed = new URL(nu);
    const host = (parsed.hostname || "").replace(/^www\./i,"").toLowerCase();

    // youtu.be/<id>
    if (host === "youtu.be"){
      const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      return id ? id.slice(0, 32) : null;
    }

    if (host.endsWith("youtube.com")){
      // /watch?v=<id>
      const v = parsed.searchParams.get("v");
      if (v) return v.slice(0, 32);

      // /embed/<id>
      const parts = parsed.pathname.split("/").filter(Boolean);
      const embedIdx = parts.indexOf("embed");
      if (embedIdx >= 0 && parts[embedIdx+1]) return parts[embedIdx+1].slice(0, 32);

      // /shorts/<id>
      const shortsIdx = parts.indexOf("shorts");
      if (shortsIdx >= 0 && parts[shortsIdx+1]) return parts[shortsIdx+1].slice(0, 32);
    }
  }catch(e){
    return null;
  }
  return null;
}

function canonicalYouTubeUrl(url){
  const id = extractYouTubeId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
}

function youTubeEmbedUrl(url){
  const id = extractYouTubeId(url);
  if (!id) return "";
  // rel=0: related videos from same channel (current YouTube behavior)
  return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`;
}



function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* ============================
   DATA MODEL (v2)
   ============================ */
function defaultData(){
  return {
    version: 2,
    players: [],
    matches: [],
    updatedAt: new Date().toISOString()
  };
}

let state = {
  data: defaultData(),
  stats: null,
  draft: null,
  editingMatchId: null,
  ui: {
    expandedMatches: new Set(),
    expandedVotes: new Set(),
    playerQuery: "",
    nmQuery: ""
  }};

/* ============================
   JSONBIN IO + LOCAL CACHE
   ============================ */
async function loadRemote(){
  const url = `${API_BASE}/${BIN_ID}/latest`;
  const res = await fetch(url, { headers: { "X-Access-Key": X_ACCESS_KEY } });
  if (!res.ok) throw new Error(`GET failed ${res.status}`);
  const json = await res.json();
  return json?.record ?? defaultData();
}

async function saveRemote(record){
  const url = `${API_BASE}/${BIN_ID}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Key": X_ACCESS_KEY
    },
    body: JSON.stringify(record)
  });
  if (!res.ok) throw new Error(`PUT failed ${res.status}`);
  return await res.json();
}

function loadLocal(){
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function saveLocal(record){
  localStorage.setItem(LS_KEY, JSON.stringify(record));
}

/* ============================
   SANITIZE + MIGRATE
   ============================ */
function sanitizeData(d){
  const base = defaultData();
  if (!d || typeof d !== "object") return base;

  const out = {
    version: 2,
    players: Array.isArray(d.players) ? d.players.filter(p => p && p.id && p.name) : [],
    matches: Array.isArray(d.matches) ? d.matches.filter(m => m && m.id && m.date) : [],
    updatedAt: d.updatedAt || new Date().toISOString()
  };

  for (const m of out.matches){
    m.teamA = Array.isArray(m.teamA) ? m.teamA : [];
    m.teamB = Array.isArray(m.teamB) ? m.teamB : [];

    // playersPerTeam (format: 5v5 .. 8v8)
    if (m.playersPerTeam === undefined || m.playersPerTeam === null){
      const guess = Math.max(m.teamA.length, m.teamB.length);
      m.playersPerTeam = (guess >= 5 && guess <= 8) ? guess : 7;
    } else {
      m.playersPerTeam = clampInt(m.playersPerTeam);
      if (m.playersPerTeam < 5 || m.playersPerTeam > 8) m.playersPerTeam = 7;
    }
    m.createdAt = m.createdAt || new Date().toISOString();

        const _v = (typeof m.videoUrl === "string") ? normalizeUrl(m.videoUrl).slice(0, 600) : "";
    m.videoUrl = canonicalYouTubeUrl(_v);

    if (!m.playerStats || typeof m.playerStats !== "object") m.playerStats = {};

    if (Array.isArray(m.goals) && m.goals.length){
      for (const g of m.goals){
        const scorer = g?.scorerId;
        const assist = g?.assistId;
        if (scorer){
          m.playerStats[scorer] = m.playerStats[scorer] || { goals: 0, assists: 0 };
          m.playerStats[scorer].goals += 1;
        }
        if (assist){
          m.playerStats[assist] = m.playerStats[assist] || { goals: 0, assists: 0 };
          m.playerStats[assist].assists += 1;
        }
      }
    }
    delete m.goals;

    if (!Array.isArray(m.mvpVotes)) m.mvpVotes = [];
    if (Array.isArray(m.mvp) && m.mvp.some(Boolean) && m.mvpVotes.length === 0){
      m.mvpVotes.push({ voter: "Legacy", picks: [m.mvp[0]||null, m.mvp[1]||null, m.mvp[2]||null], createdAt: new Date().toISOString() });
    }
    delete m.mvp;

    for (const [pid, ps] of Object.entries(m.playerStats)){
      if (!ps || typeof ps !== "object") { delete m.playerStats[pid]; continue; }
      m.playerStats[pid] = { goals: clampInt(ps.goals), assists: clampInt(ps.assists) };
    }

    m.mvpVotes = m.mvpVotes
      .filter(v => v && (v.voterId || v.voter))
      .map(v => {
        const voterId = (typeof v.voterId === "string" && v.voterId.trim()) ? v.voterId.trim() : null;
        const voter = (typeof v.voter === "string") ? v.voter.trim().slice(0, 40) : "";
        return {
          voterId,
          voter,
          picks: Array.isArray(v.picks) ? [v.picks[0]||null, v.picks[1]||null, v.picks[2]||null] : [null,null,null],
          createdAt: v.createdAt || new Date().toISOString()
        };
      });
  }

  return out;
}

/* ============================
   COMPUTED
   ============================ */
function computeMatchScore(m){
  const sumGoals = (ids) => (ids || []).reduce((acc, pid) => {
    const ps = m.playerStats?.[pid];
    return acc + (ps ? clampInt(ps.goals) : 0);
  }, 0);
  return { a: sumGoals(m.teamA), b: sumGoals(m.teamB) };
}

function computeMatchVoteTally(m){
  const points = {};
  const pickedCount = {};
  const firstCount = {};
  const secondCount = {};
  const thirdCount = {};
  const pts = [3,2,1];

  for (const v of (m.mvpVotes || [])){
    const picks = Array.isArray(v.picks) ? v.picks : [];
    for (let i=0;i<3;i++){
      const pid = picks[i];
      if (!pid) continue;
      points[pid] = (points[pid] || 0) + pts[i];
      pickedCount[pid] = (pickedCount[pid] || 0) + 1;
      if (i===0) firstCount[pid] = (firstCount[pid] || 0) + 1;
      if (i===1) secondCount[pid] = (secondCount[pid] || 0) + 1;
      if (i===2) thirdCount[pid] = (thirdCount[pid] || 0) + 1;
    }
  }
  return { points, pickedCount, firstCount, secondCount, thirdCount };
}

function computeMatchMvpWinner(m, nameOf=(pid)=>pid){
  const tally = computeMatchVoteTally(m);
  const participants = [...new Set([...(m.teamA||[]), ...(m.teamB||[])])];

  let bestId = null;
  let best = { pts:-1, first:-1, picked:-1, name:"" };

  for (const pid of participants){
    const pts = tally.points[pid] || 0;
    if (pts <= 0) continue;
    const first = tally.firstCount[pid] || 0;
    const picked = tally.pickedCount[pid] || 0;
    const name = String(nameOf(pid) || "").toLowerCase();

    const better =
      (pts > best.pts) ||
      (pts === best.pts && first > best.first) ||
      (pts === best.pts && first === best.first && picked > best.picked) ||
      (pts === best.pts && first === best.first && picked === best.picked && (bestId===null || name < best.name));

    if (better){
      best = { pts, first, picked, name };
      bestId = pid;
    }
  }

  return { winnerId: bestId, winnerPoints: best.pts, tally };
}


function computeStats(data){
  const playersById = new Map(data.players.map(p => [p.id, p]));
  const stats = {};
  for (const p of data.players){
    stats[p.id] = { id:p.id, name:p.name, played:0, goals:0, assists:0, mvpStars:0, mvpPoints:0, mvp1:0, mvp2:0, mvp3:0, wins:0, draws:0, losses:0, gf:0, ga:0 };
  }

  for (const m of data.matches){
    const teamA = new Set(m.teamA || []);
    const participants = new Set([...(m.teamA||[]), ...(m.teamB||[])]);

    for (const pid of participants){
      const s = stats[pid];
      if (!s) continue;
      s.played += 1;
      const ps = m.playerStats?.[pid];
      if (ps){ s.goals += clampInt(ps.goals); s.assists += clampInt(ps.assists); }
    }

    const { a:gA, b:gB } = computeMatchScore(m);
    for (const pid of participants){
      const s = stats[pid];
      if (!s) continue;
      const isA = teamA.has(pid);
      const my = isA ? gA : gB;
      const opp = isA ? gB : gA;
      s.gf += my; s.ga += opp;
      if (my > opp) s.wins += 1;
      else if (my < opp) s.losses += 1;
      else s.draws += 1;
    }

    const pts = [3,2,1];
    for (const v of (m.mvpVotes || [])){
      const picks = Array.isArray(v.picks) ? v.picks : [];
      for (let i=0;i<3;i++){
        const pid = picks[i];
        if (!pid || !stats[pid]) continue;
        stats[pid].mvpPoints += pts[i];
        if (i===0) stats[pid].mvp1 += 1;
        if (i===1) stats[pid].mvp2 += 1;
        if (i===2) stats[pid].mvp3 += 1;
      }
    }


    const w = computeMatchMvpWinner(m, pid => playersById.get(pid)?.name || "");
    if (w.winnerId && stats[w.winnerId]) stats[w.winnerId].mvpStars += 1;
  }

  const list = Object.values(stats);
  const byGoals = [...list].sort((a,b)=> b.goals - a.goals || b.assists - a.assists || b.mvpPoints - a.mvpPoints);
  const byAssists = [...list].sort((a,b)=> b.assists - a.assists || b.goals - a.goals || b.mvpPoints - a.mvpPoints);
  const byMvp = [...list].sort((a,b)=> (b.mvpStars - a.mvpStars) || (b.mvpPoints - a.mvpPoints) || (b.goals - a.goals) || (b.assists - a.assists));

  return { playersById, statsById: stats, byGoals, byAssists, byMvp };
}

/* ============================
   ROUTING
   ============================ */
function setView(name){
  const map = { players:$("#viewPlayers"), newMatch:$("#viewNewMatch"), matches:$("#viewMatches"), leaderboard:$("#viewLeaderboard") };
  for (const [k, el] of Object.entries(map)) el.classList.toggle("hidden", k !== name);
  $$(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === name));
  renderAll();
}

function playerName(pid){ return state.stats?.playersById?.get(pid)?.name ?? "—"; }

function sortMatchesDesc(a,b){
  return (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "");
}

/* ============================
   PERSIST
   ============================ */
async function persist(msg){
  try{
    overlay(true, "Guardando…");
    state.data.updatedAt = new Date().toISOString();
    saveLocal(state.data);
    await saveRemote(state.data);
    toast(msg);
  }catch(err){
    console.error(err);
    saveLocal(state.data);
    toast(msg + " (offline)");
  }finally{
    overlay(false);
    state.stats = computeStats(state.data);
    renderAll();
  }
}

function normalizeMatchAfterEdit(m){
  const participants = new Set([...(m.teamA||[]), ...(m.teamB||[])]);
  if (!m.playerStats || typeof m.playerStats !== "object") m.playerStats = {};
  for (const pid of Object.keys(m.playerStats)){
    if (!participants.has(pid)) delete m.playerStats[pid];
  }
  m.mvpVotes = Array.isArray(m.mvpVotes) ? m.mvpVotes : [];
  m.mvpVotes = m.mvpVotes.map(v => ({ ...v, picks: (v.picks||[]).map(pid => (pid && participants.has(pid)) ? pid : null) }));
}

function openRenamePlayerModal(player){
  const modal = document.createElement("div");
  modal.className = "overlay";
  modal.innerHTML = `
    <div class="card" style="width:min(720px,92vw); padding:16px; border-radius:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div><div class="h1" style="margin:0;">Editar jugador</div></div>
        <button class="btn" id="close">Cerrar</button>
      </div>

      <div class="hr"></div>

      <div class="h2">Nombre</div>
      <input class="input" id="name" maxlength="50" value="${escapeHtml(player.name)}" />

      <div class="hr"></div>

      <div class="row" style="justify-content:flex-end;">
        <button class="btn btn-primary" id="save">Guardar</button>
      </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  $("#close", modal).onclick = () => modal.remove();
  $("#save", modal).onclick = async () => {
    const name = ($("#name", modal).value || "").trim();
    if (!name) return toast("Nombre requerido");
    if (state.data.players.some(p => p.id !== player.id && p.name.toLowerCase() === name.toLowerCase())){
      return toast("Ya existe");
    }
    const p = state.data.players.find(x => x.id === player.id);
    if (p) p.name = name;
    modal.remove();
    await persist("Jugador actualizado");
  };
}


/* ============================
   PLAYERS
   ============================ */
function renderPlayers(){
  const el = $("#viewPlayers");
  const data = state.data;
  const stats = state.stats;

  const __focusPlayers = (document.activeElement && document.activeElement.id === "playerSearch")
    ? { pos: document.activeElement.selectionStart || 0 }
    : null;

  el.innerHTML = `
    <div class="h1">Jugadores</div>

    <div class="row players-toolbar" style="align-items:end;">
      <div style="flex:1; min-width:260px;">
        <div class="h2">Agregar</div>
        <input class="input" id="playerName" placeholder="Nombre" />
      </div>
      <div style="min-width:180px;">
        <button class="btn btn-primary" id="btnAddPlayer">+ Agregar</button>
      </div>
      <div style="flex:1; min-width:260px;">
        <div class="h2">Buscar</div>
        <input class="input" id="playerSearch" placeholder="Buscar…" value="${escapeHtml(state.ui.playerQuery||"")}" />
      </div>
    </div>

    <div class="hr"></div>

    <table class="table">
      <thead>
        <tr>
          <th>Jugador</th>
          <th>PJ</th>
          <th>G</th>
          <th>A</th>
          <th>MVP</th>
          <th>W-D-L</th>
                    <th></th>
        </tr>
      </thead>
      <tbody id="playersTbody"></tbody>
    </table>
  `;

  const q = (state.ui.playerQuery || "").trim().toLowerCase();
  const rows = data.players
    .map(p => ({ p, s: stats.statsById[p.id] }))
    .filter(x => !q || x.p.name.toLowerCase().includes(q))
    .sort((a,b)=> (b.s.mvpStars - a.s.mvpStars) || (b.s.mvpPoints - a.s.mvpPoints) || (b.s.goals - a.s.goals) || a.p.name.localeCompare(b.p.name));

  $("#playersTbody").innerHTML = rows.length ? rows.map(({p,s}) => `
    <tr>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${s.played}</td>
      <td>${s.goals}</td>
      <td>${s.assists}</td>
      <td>${s.mvpStars}</td>
      <td>${s.wins}-${s.draws}-${s.losses}</td>
            <td class="row" style="gap:8px; justify-content:flex-end;"><button class="btn btn-small" data-rename-player="${p.id}">Editar</button><button class="btn btn-small btn-danger" data-del-player="${p.id}">Eliminar</button></td>
    </tr>
  `).join("") : `<tr><td colspan="7">Sin jugadores</td></tr>`;

  $("#btnAddPlayer").onclick = async () => {
    const name = ($("#playerName").value || "").trim();
    if (!name) return toast("Nombre requerido");
    if (state.data.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast("Ya existe");
    state.data.players.push({ id: uuid(), name });
    await persist("Jugador agregado");
    $("#playerName").value = "";
  };

  $("#playerSearch").oninput = (e) => { state.ui.playerQuery = e.target.value; renderPlayers(); };
  if (__focusPlayers){
    const __el = $("#playerSearch");
    if (__el){ __el.focus(); try{ __el.setSelectionRange(__focusPlayers.pos, __focusPlayers.pos); }catch(e){} }
  }


  el.onclick = async (e) => {
    const ren = e.target.closest("[data-rename-player]");
    if (ren){
      const pid = ren.dataset.renamePlayer;
      const current = state.data.players.find(p=>p.id===pid);
      if (!current) return;
      openRenamePlayerModal(current);
      return;
    }

    const btn = e.target.closest("[data-del-player]");
    if (!btn) return;
    const pid = btn.dataset.delPlayer;
    const used = state.data.matches.some(m => (m.teamA||[]).includes(pid) || (m.teamB||[]).includes(pid));
    if (used && !confirm("Ese jugador aparece en partidos. ¿Eliminar igual?")) return;

    state.data.players = state.data.players.filter(p => p.id !== pid);
    for (const m of state.data.matches){
      m.teamA = (m.teamA||[]).filter(x => x !== pid);
      m.teamB = (m.teamB||[]).filter(x => x !== pid);
      if (m.playerStats) delete m.playerStats[pid];
      m.mvpVotes = (m.mvpVotes||[]).map(v => ({ ...v, picks: (v.picks||[]).map(x => x === pid ? null : x) }));
    }
    await persist("Jugador eliminado");
  };
}

/* ============================
   NEW MATCH (players left, teams right)
   ============================ */
function renderNewMatch(){
  const el = $("#viewNewMatch");
  const data = state.data;

  const __focusNM = (document.activeElement && document.activeElement.id === "nmSearch")
    ? { pos: document.activeElement.selectionStart || 0 }
    : null;

  if (!state.draft){
    if (state.editingMatchId){
      const m = state.data.matches.find(x => x.id === state.editingMatchId);
      state.draft = m ? { id:m.id, date:m.date, videoUrl: (m.videoUrl||""), playersPerTeam: m.playersPerTeam || 5, activeTeam: 'A', teamA:[...(m.teamA||[])], teamB:[...(m.teamB||[])], createdAt:m.createdAt||new Date().toISOString() }
                      : { id:uuid(), date:toISODateInput(new Date()), videoUrl: "", playersPerTeam: 7, activeTeam: 'A', teamA:[], teamB:[], createdAt:new Date().toISOString() };
    } else {
      state.draft = { id:uuid(), date:toISODateInput(new Date()), videoUrl: "", playersPerTeam: 7, activeTeam: 'A', teamA:[], teamB:[], createdAt:new Date().toISOString() };
    }
  }
  const d = state.draft;
  if (d.videoUrl === undefined || d.videoUrl === null) d.videoUrl = "";
  if (!d.playersPerTeam) d.playersPerTeam = 7;
  if (!d.activeTeam) d.activeTeam = 'A';
  const isEdit = !!state.editingMatchId;

  const q = (state.ui.nmQuery || "").trim().toLowerCase();
  const players = data.players.slice().sort((a,b)=>a.name.localeCompare(b.name)).filter(p => !q || p.name.toLowerCase().includes(q));

  const listHtml = players.length ? players.map(p => {
    const team = d.teamA.includes(p.id) ? "A" : d.teamB.includes(p.id) ? "B" : "N";
    const pill = team === "A" ? `<span class="pill teamA">A</span>` : team === "B" ? `<span class="pill teamB">B</span>` : "";
    return `<div class="player-item" draggable="true" data-player-id="${p.id}" data-team="${team}">
              <div>${escapeHtml(p.name)}</div><div>${pill}</div>
            </div>`;
  }).join("") : `<div>Sin jugadores</div>`;

  const teamZone = (team) => {
    const max = d.playersPerTeam || 5;
    const ids = team === "A" ? d.teamA : d.teamB;
    const zoneClass = team === "A" ? "teamA" : "teamB";
    const label = team === "A" ? "Equipo A" : "Equipo B";

    const overflow = Math.max(0, ids.length - max);
    const missing = Math.max(0, max - ids.length);
    const statusClass = overflow ? "overflow" : (missing ? "underfilled" : "");
    const statusText = overflow ? `⚠️ Sobran ${overflow}` : (missing ? `Faltan ${missing}` : "Completo");
    const statusTone = overflow ? "bad" : (missing ? "warn" : "ok");

    const chips = ids.map((pid, i) => {
      const over = i >= max;
      return `<div class="player-chip ${over ? "slot-over" : ""}" draggable="true" data-player-id="${pid}" data-team="${team}"><span class="grab">⋮⋮</span><span class="pname">${escapeHtml(playerName(pid))}</span></div>`;
    }).join(" ");

    const empties = Array.from({length: missing}).map(()=> `<span class="slot-empty">Vacío</span>`).join("");

    return `
      <div class="panel">
        <div class="row" style="align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div class="teamTag ${zoneClass}">${label}</div>
          <div class="teamTag ${zoneClass}">${ids.length} / ${max}</div>
        </div>
        <div class="dropzone teamlist ${zoneClass} ${statusClass}" data-zone="${team}">
          ${chips} ${empties}
        </div>
        <div class="team-status ${statusTone}">${statusText}</div>
      </div>
    `;
  };

  el.innerHTML = `
    <div class="h1">${isEdit ? "Editar partido" : "Nuevo partido"}</div>

    <div class="row nm-topbar" style="align-items:end; justify-content:space-between; flex-wrap:wrap; gap:10px;">
      <div style="flex:1; min-width:260px;">
        <div class="h2">Fecha</div>
        <input class="input" type="date" id="matchDate" value="${d.date}" />
      </div>

      <div style="min-width:200px;">
        <div class="h2">Formato</div>
        <select class="select" id="playersPerTeam">
          <option value="5" ${d.playersPerTeam===5 ? "selected" : ""}>5v5</option>
          <option value="6" ${d.playersPerTeam===6 ? "selected" : ""}>6v6</option>
          <option value="7" ${d.playersPerTeam===7 ? "selected" : ""}>7v7</option>
          <option value="8" ${d.playersPerTeam===8 ? "selected" : ""}>8v8</option>
        </select>
      </div>
      <div class="row" style="gap:8px; justify-content:flex-end;">
        ${isEdit ? `<button class="btn" id="btnCancelEdit">Cancelar</button><button class="btn btn-danger" id="btnDeleteMatch">Eliminar</button>` : `<button class="btn" id="btnResetDraft"><span class="btn-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></span><span class="btn-label">Reiniciar</span></button>`}
        <button class="btn btn-primary" id="btnSaveMatch"><span class="btn-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V7l4-4h10l4 4v12a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v4h8"/></svg></span><span class="btn-label">${isEdit ? "Guardar cambios" : "Guardar partido"}</span></button>
      </div>
    </div>

    <div class="hr"></div>

    <div class="hr"></div>

    <div class="newmatch-layout">
      <div class="team-select nm-team-select">
        <div class="h2" style="margin:0;">Cargando en</div>
        <button class="team-toggle teamA ${d.activeTeam==='A' ? 'is-active' : ''}" id="selTeamA">Equipo A</button>
        <button class="team-toggle teamB ${d.activeTeam==='B' ? 'is-active' : ''}" id="selTeamB">Equipo B</button>
      </div>

      <div class="panel">
        <div class="h2">Jugadores</div>
        <input class="input" id="nmSearch" placeholder="Buscar…" value="${escapeHtml(state.ui.nmQuery||"")}" />
        <div style="height:10px;"></div>
        <div class="player-list" id="playerList">${listHtml}</div>
      </div>

      ${teamZone("A")}
      ${teamZone("B")}
    </div>`;

  $("#matchDate").onchange = (e) => { d.date = e.target.value; };
  $("#playersPerTeam").onchange = (e) => { d.playersPerTeam = clampInt(e.target.value); autoSwitchTeamIfNeeded(); renderNewMatch(); };
  $("#selTeamA").onclick = () => { d.activeTeam = "A"; renderNewMatch(); };
  $("#selTeamB").onclick = () => { d.activeTeam = "B"; renderNewMatch(); };
  $("#nmSearch").oninput = (e) => { state.ui.nmQuery = e.target.value; renderNewMatch(); };
  if (__focusNM){
    const __el = $("#nmSearch");
    if (__el){ __el.focus(); try{ __el.setSelectionRange(__focusNM.pos, __focusNM.pos); }catch(e){} }
  }


  if (isEdit){
    $("#btnCancelEdit").onclick = () => { state.draft=null; state.editingMatchId=null; setView("matches"); };
    $("#btnDeleteMatch").onclick = async () => {
      const id = state.editingMatchId;
      if (!id) return;
      if (!confirm("¿Eliminar partido?")) return;
      if (!confirm("Confirmá de nuevo: esto borra resultado, stats y votos. ¿Eliminar?")) return;
      state.data.matches = state.data.matches.filter(m => m.id !== id);
      state.ui.expandedMatches.delete(id);
      state.ui.expandedVotes.delete(id);
      state.draft = null;
      state.editingMatchId = null;
      await persist("Partido eliminado");
      setView("matches");
    };
  } else {
    $("#btnResetDraft").onclick = () => { if (!confirm("¿Reiniciar?")) return; state.draft=null; renderNewMatch(); };
  }

  $("#btnSaveMatch").onclick = async () => {
    if (!d.date) return toast("Fecha requerida");
    const participants = [...new Set([...(d.teamA||[]), ...(d.teamB||[])])];
    if (participants.length < 2) return toast("Sumá jugadores");
    const max = d.playersPerTeam || 0;
    if (!max) return toast("Elegí formato");
    const overA = d.teamA.length - max;
    const overB = d.teamB.length - max;
    if (overA > 0 || overB > 0) return toast(`Sobran jugadores (A ${d.teamA.length}/${max}, B ${d.teamB.length}/${max})`);
    if (d.teamA.length < max || d.teamB.length < max) return toast(`Faltan jugadores (A ${d.teamA.length}/${max}, B ${d.teamB.length}/${max})`);

    if (isEdit){
      const m = state.data.matches.find(x => x.id === state.editingMatchId);
      if (!m) return toast("No se encontró");
      m.date = d.date;
      m.playersPerTeam = d.playersPerTeam || 5;
      m.teamA = [...d.teamA];
      m.teamB = [...d.teamB];
      normalizeMatchAfterEdit(m);
      state.draft = null;
      state.editingMatchId = null;
      await persist("Partido actualizado");
      setView("matches");
    } else {
      state.data.matches.push({ id:d.id, date:d.date, videoUrl: "", playersPerTeam: d.playersPerTeam || 5, teamA:[...d.teamA], teamB:[...d.teamB], playerStats:{}, mvpVotes:[], createdAt:d.createdAt });
      state.draft = null;
      await persist("Partido creado");
      setView("matches");
    }
  };

  setupNewMatchInteractions();

  function setupNewMatchInteractions(){
    const root = $("#viewNewMatch");

    root.onclick = (e) => {
      const item = e.target.closest("[data-player-id]");
      if (!item) return;
      const pid = item.dataset.playerId;
      toggleAssignment(pid);
      renderNewMatch();
    };

    $$("[draggable='true'][data-player-id]", root).forEach(node => {
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", node.dataset.playerId);
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".dropzone[data-zone]", root).forEach(zone => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("is-over");
        const pid = e.dataTransfer.getData("text/plain");
        if (!pid) return;
        const team = zone.dataset.zone;
        d.activeTeam = team;
        assignTo(pid, team);
        renderNewMatch();
      });
    });

    // Drop on the player list to remove from teams
    const playerList = $("#playerList", root);
    if (playerList){
      playerList.addEventListener("dragover", (e) => { e.preventDefault(); playerList.classList.add("is-over"); });
      playerList.addEventListener("dragleave", () => playerList.classList.remove("is-over"));
      playerList.addEventListener("drop", (e) => {
        e.preventDefault();
        playerList.classList.remove("is-over");
        const pid = e.dataTransfer.getData("text/plain");
        if (!pid) return;
        unassign(pid);
        renderNewMatch();
      });
    }
  }

  function autoSwitchTeamIfNeeded(){
    const max = d.playersPerTeam || 0;
    if (!max) return;
    const aFull = d.teamA.length >= max;
    const bFull = d.teamB.length >= max;
    if (d.activeTeam === "A" && aFull && !bFull) d.activeTeam = "B";
    else if (d.activeTeam === "B" && bFull && !aFull) d.activeTeam = "A";
  }

  function toggleAssignment(pid){
    const max = d.playersPerTeam || 0;
    let active = d.activeTeam || "A";
    const inA = d.teamA.includes(pid);
    const inB = d.teamB.includes(pid);

    // clicking player already in active team removes it
    if ((active === "A" && inA) || (active === "B" && inB)){
      unassign(pid);
      return;
    }

    // if adding a new player and active team is full, auto switch (click-flow avoids overflow)
    if (!inA && !inB && max){
      const aFull = d.teamA.length >= max;
      const bFull = d.teamB.length >= max;
      if (active === "A" && aFull && !bFull) active = "B";
      if (active === "B" && bFull && !aFull) active = "A";
      if ((d.teamA.length >= max) && (d.teamB.length >= max)){
        toast("Equipos completos");
        return;
      }
    }

    d.activeTeam = active;
    assignTo(pid, active);

    autoSwitchTeamIfNeeded();
  }
  function assignTo(pid, team){
    unassign(pid);
    if (team === "A") d.teamA.push(pid);
    if (team === "B") d.teamB.push(pid);
  }
  function unassign(pid){
    d.teamA = d.teamA.filter(x => x !== pid);
    d.teamB = d.teamB.filter(x => x !== pid);
  }
}

/* ============================
   MATCHES (collapse + edit)
   ============================ */
function isInteractiveTarget(target){
  return !!(
    target.closest("button, a, input, select, textarea, label, [role='button']") ||
    target.closest("[data-del-match], [data-edit-match], [data-vote], [data-toggle-votes], [data-edit-player]") ||
    target.closest("table")
  );
}


function renderMatches(){
  const el = $("#viewMatches");
  const list = state.data.matches.slice().sort(sortMatchesDesc);

  el.innerHTML = `
    <div class="h1">PARTIDOS</div>
    <div id="matchesWrap">
      ${list.length ? list.map(m => renderMatchCard(m)).join("") : `<div>Sin partidos</div>`}
    </div>
  `;

  el.onclick = async (e) => {
    const btnSaveVideo = e.target.closest("[data-save-video]");
    if (btnSaveVideo){
      const id = btnSaveVideo.dataset.saveVideo;
      const m = state.data.matches.find(x => x.id === id);
      if (!m) return;
      const inp = el.querySelector(`[data-video-input="${id}"]`);
      const raw = inp ? inp.value : "";
      const canon = raw.trim() ? canonicalYouTubeUrl(raw) : "";
      if (raw.trim() && !canon){
        toast("Link de YouTube inválido");
        return;
      }
      m.videoUrl = canon;
      await persist("Video guardado");
      return;
    }

    const btnVotes = e.target.closest("[data-toggle-votes]");
    if (btnVotes){
      const id = btnVotes.dataset.toggleVotes;
      if (state.ui.expandedVotes.has(id)) state.ui.expandedVotes.delete(id);
      else state.ui.expandedVotes.add(id);
      renderMatches();
      return;
    }

    const btnEdit = e.target.closest("[data-edit-match]");
    if (btnEdit){
      const id = btnEdit.dataset.editMatch;
      state.editingMatchId = id;
      state.draft = null;
      setView("newMatch");
      return;
    }

    const btnVote = e.target.closest("[data-vote]");
    if (btnVote){
      const id = btnVote.dataset.vote;
      const m = state.data.matches.find(x => x.id === id);
      if (!m) return;
      openVoteModal(m);
      return;
    }

    const pbtn = e.target.closest("[data-edit-player]");
    if (pbtn){
      const matchId = pbtn.dataset.matchId;
      const pid = pbtn.dataset.editPlayer;
      const m = state.data.matches.find(x => x.id === matchId);
      if (!m) return;
      openPlayerStatModal(m, pid);
      return;
    }

    const card = e.target.closest("[data-card-match]");
    if (card && !isInteractiveTarget(e.target)){
      const id = card.dataset.cardMatch;
      if (state.ui.expandedMatches.has(id)) state.ui.expandedMatches.delete(id);
      else state.ui.expandedMatches.add(id);
      renderMatches();
      return;
    }
  };

  function renderMatchCard(m){
    const expanded = state.ui.expandedMatches.has(m.id);
    const showVotes = state.ui.expandedVotes.has(m.id);
    const { a, b } = computeMatchScore(m);
    const mvp = computeMatchMvpWinner(m, playerName);
    const mvpWinnerId = mvp.winnerId;
    const tally = mvp.tally;
    const winner = a === b ? null : (a > b ? 'A' : 'B');
    const votesCount = (m.mvpVotes || []).length;
    const format = (m.playersPerTeam ? (m.playersPerTeam + "v" + m.playersPerTeam) : "7v7");
    const embedUrl = m.videoUrl ? youTubeEmbedUrl(m.videoUrl) : "";

    if (!expanded){
      return `
        <div class="match-card" data-card-match="${m.id}">
          <div class="match-header">
            <div class="match-left">
              <div class="match-date">${fmtDate(m.date)}</div>
              <div class="match-meta"><span class="meta-format">${format}</span> <span class="meta-sep">•</span> <span class="meta-mvp">🌟 ${mvpWinnerId ? escapeHtml(playerName(mvpWinnerId)) : "Sin MVP"}</span></div>
            </div>

            <div class="match-score">
              <div class="scoreline">
                <span class="team-tag teamA ${winner==='A' ? 'winner-pill' : ''}">A</span>
                <span class="big teamA">${a}</span>
                <span class="dash">—</span>
                <span class="big teamB">${b}</span>
                <span class="team-tag teamB ${winner==='B' ? 'winner-pill' : ''}">B</span>
              </div>
            </div>

            <div class="match-actions row" style="gap:8px; justify-content:flex-end;">
              <button class="btn btn-small" data-edit-match="${m.id}">Editar</button>
            </div>
          </div>
        </div>
      `;
    }

    const renderTeam = (ids) => {
      if (!ids.length) return ``;
      return ids.map(pid => {
        const ps = m.playerStats?.[pid] || { goals:0, assists:0 };
        const g = clampInt(ps.goals);
        const as = clampInt(ps.assists);
        const pts = tally.points[pid] || 0;
        const votes = tally.pickedCount[pid] || 0;
        const hasVotes = votes > 0;

        return `
          <button class="player-row ${hasVotes ? "has-votes" : ""} ${pid===mvpWinnerId ? "mvp-winner" : ""}"
            data-edit-player="${pid}" data-match-id="${m.id}">
            <span><b>${escapeHtml(playerName(pid))}</b>${pid===mvpWinnerId ? ` <span class="icon-pill">🌟 MVP</span>${pts ? ` <span class="icon-pill">⭐ ${pts}</span>` : ""}` : (hasVotes ? ` <span class="icon-pill">⭐ ${pts}</span>` : "")}</span>
            <span class="icons">
              ${g ? `<span class="icon-pill">G ${g}</span>` : ""}
              ${as ? `<span class="icon-pill">A ${as}</span>` : ""}
            </span>
          </button>
        `;
      }).join("");
    };

    const votesTable = votesCount ? `
      <table class="table" style="margin-top:8px;">
        <thead><tr><th>Votante</th><th>🥇</th><th>🥈</th><th>🥉</th></tr></thead>
        <tbody>
          ${(m.mvpVotes||[]).slice().reverse().map(v => `
            <tr>
              <td><b>${escapeHtml(v.voterId ? playerName(v.voterId) : (v.voter||""))}</b></td>
              <td>${v.picks?.[0] ? escapeHtml(playerName(v.picks[0])) : "—"}</td>
              <td>${v.picks?.[1] ? escapeHtml(playerName(v.picks[1])) : "—"}</td>
              <td>${v.picks?.[2] ? escapeHtml(playerName(v.picks[2])) : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : ``;

    return `
      <div class="match-card" data-card-match="${m.id}">
        <div class="match-header">
          <div class="match-left">
            <div class="match-date">${fmtDate(m.date)}</div>
            <div class="match-meta"><span class="meta-format">${format}</span> <span class="meta-sep">•</span> <span class="meta-mvp">🌟 ${mvpWinnerId ? escapeHtml(playerName(mvpWinnerId)) : "Sin MVP"}</span></div>
          </div>

          <div class="match-score">
            <div class="scoreline">
              <span class="team-tag teamA ${winner==='A' ? 'winner-pill' : ''}">A</span>
              <span class="big teamA">${a}</span>
              <span class="dash">—</span>
              <span class="big teamB">${b}</span>
              <span class="team-tag teamB ${winner==='B' ? 'winner-pill' : ''}">B</span>
            </div>
          </div>

          <div class="match-actions row" style="gap:8px; justify-content:flex-end;">
            <button class="btn btn-small" data-toggle-votes="${m.id}">${showVotes ? "Ocultar votos" : "Ver votos"}</button>
            <button class="btn btn-primary btn-small" data-vote="${m.id}">Votar</button>
            <button class="btn btn-small" data-edit-match="${m.id}">Editar</button>
          </div>
        </div>


        <div class="detail-box">
          <div class="h2">Video (YouTube)</div>
          <div class="row" style="gap:10px; align-items:end; flex-wrap:wrap;">
            <input class="input" style="flex:1; min-width:260px;" data-video-input="${m.id}" placeholder="Pegá link de YouTube (youtu.be / watch?v=)" value="${escapeHtml(m.videoUrl||"")}" />
            <button class="btn btn-small btn-primary" data-save-video="${m.id}">Guardar</button>
            ${m.videoUrl ? `<a class="btn btn-small" href="${escapeHtml(m.videoUrl)}" target="_blank" rel="noopener">Abrir</a>` : ``}
          </div>
          ${embedUrl ? `<div class="video-embed"><iframe src="${embedUrl}" title="YouTube video" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>` : ``}
        </div>

        <div class="teams-split">
          <div class="team-box teamA ${winner==='A' ? 'winner' : ''}">
            <div class="team-title"><span>Equipo A</span><b>${a}</b></div>
            ${renderTeam(m.teamA || [])}
          </div>
          <div class="team-box teamB ${winner==='B' ? 'winner' : ''}">
            <div class="team-title"><span>Equipo B</span><b>${b}</b></div>
            ${renderTeam(m.teamB || [])}
          </div>
        </div>

        ${showVotes ? `
          <div class="detail-box">
            <div class="h2">Votos</div>
            ${votesTable || "Sin votos"}
          </div>
        ` : ``}
      </div>
    `;
  }

  function openPlayerStatModal(match, pid){
    const current = match.playerStats?.[pid] || { goals:0, assists:0 };

    const modal = document.createElement("div");
    modal.className = "overlay";
    modal.innerHTML = `
      <div class="card" style="width:min(720px,92vw); padding:16px; border-radius:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div><div class="h1" style="margin:0;">${escapeHtml(playerName(pid))}</div></div>
          <button class="btn" id="close">Cerrar</button>
        </div>

        <div class="hr"></div>

        <div class="row" style="align-items:end;">
          <div class="col">
            <div class="h2">Goles</div>
            <input class="input" type="number" min="0" id="goals" value="${clampInt(current.goals)}" />
          </div>
          <div class="col">
            <div class="h2">Asistencias</div>
            <input class="input" type="number" min="0" id="assists" value="${clampInt(current.assists)}" />
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:flex-end;">
          <button class="btn btn-primary" id="save">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    $("#close", modal).onclick = () => modal.remove();
    $("#save", modal).onclick = async () => {
      const g = clampInt($("#goals", modal).value);
      const a = clampInt($("#assists", modal).value);
      match.playerStats = match.playerStats || {};
      match.playerStats[pid] = { goals: g, assists: a };
      modal.remove();
      await persist("Actualizado");
    };
  }

  function openVoteModal(match){
    const participants = [...new Set([...(match.teamA||[]), ...(match.teamB||[])])];
    const voterOpts = participants.map(pid => `<option value="${pid}">${escapeHtml(playerName(pid))}</option>`).join("");
    if (participants.length < 2) return toast("Sin jugadores");

    const opts = participants.map(pid => `<option value="${pid}">${escapeHtml(playerName(pid))}</option>`).join("");

    const modal = document.createElement("div");
    modal.className = "overlay";
    modal.innerHTML = `
      <div class="card" style="width:min(820px,92vw); padding:16px; border-radius:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div><div class="h1" style="margin:0;">Votar figuras</div></div>
          <button class="btn" id="close">Cerrar</button>
        </div>

        <div class="hr"></div>

        <div class="h2">Quien está votando</div>
        <select class="select" id="voterId"><option value="">Quien está votando…</option>${voterOpts}</select>

        <div class="hr"></div>

        <div class="row">
          <div class="col"><div class="h2">🥇</div><select class="select" id="p1"><option value="">—</option>${opts}</select></div>
          <div class="col"><div class="h2">🥈</div><select class="select" id="p2"><option value="">—</option>${opts}</select></div>
          <div class="col"><div class="h2">🥉</div><select class="select" id="p3"><option value="">—</option>${opts}</select></div>
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:flex-end;">
          <button class="btn btn-primary" id="save">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    $("#close", modal).onclick = () => modal.remove();
    $("#save", modal).onclick = async () => {
      const voterId = ($("#voterId", modal).value || "").trim();
      if (!voterId) return toast("Decí quién está votando");
      if (!participants.includes(voterId)) return toast("Votante inválido");

      const p1 = $("#p1", modal).value || null;
      const p2 = $("#p2", modal).value || null;
      const p3 = $("#p3", modal).value || null;

      const picks = [p1,p2,p3].filter(Boolean);
      const uniq = new Set(picks);
      if (picks.length && uniq.size !== picks.length) return toast("Figuras repetidas");

      match.mvpVotes = match.mvpVotes || [];

      const existingIdx = match.mvpVotes.findIndex(v => v && v.voterId === voterId);
      const payload = { voterId, picks:[p1,p2,p3], createdAt:new Date().toISOString() };
      if (existingIdx >= 0) match.mvpVotes[existingIdx] = payload;
      else match.mvpVotes.push(payload);

      modal.remove();
      await persist("Voto guardado");
    };
  }
}

/* ============================
   LEADERBOARD
   ============================ */
function renderLeaderboard(){
  const el = $("#viewLeaderboard");
  const s = state.stats;

  function topTable({ title, icon="", arr, mainLabel, mainValue, extraLabel=null, extraValue=null }){
  const hasExtra = typeof extraValue === "function";
  const rows = arr.slice(0,10).map((p, i) => `
    <tr>
      <td>${i+1}</td>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${mainValue(p)}</td>
      ${hasExtra ? `<td>${extraValue(p)}</td>` : ``}
    </tr>
  `).join("");

  return `
    <div class="match-card rank-card" style="margin-bottom:12px;">
      <div class="rank-card-header">
        <div class="rank-title">
          ${icon ? `<span class="rank-icon" aria-hidden="true">${icon}</span>` : ``}
          <div class="h2 rank-title-text" style="margin:0;">${title}</div>
        </div>
      </div>

      <table class="table rank-table" style="margin-top:8px;">
        ${hasExtra ? `
          <colgroup>
            <col style="width:52px" />
            <col />
            <col style="width:110px" />
            <col style="width:240px" />
          </colgroup>
        ` : `
          <colgroup>
            <col style="width:52px" />
            <col />
            <col style="width:110px" />
          </colgroup>
        `}
        <thead><tr><th>#</th><th>Jugador</th><th>${mainLabel}</th>${hasExtra ? `<th>${extraLabel || ""}</th>` : ``}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${hasExtra ? 4 : 3}">—</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

  el.innerHTML = `
    <div class="h1">RANKINGS</div>
    ${topTable({ title:"GOLEADORES", icon:"⚽️", arr:s.byGoals, mainLabel:"Goles", mainValue:p=> `${p.goals}` })}
    ${topTable({ title:"ASISTIDORES", icon:"🤝", arr:s.byAssists, mainLabel:"Asistencias", mainValue:p=> `${p.assists}` })}
    ${topTable({ title:"MVP", icon:"⭐", arr:s.byMvp, mainLabel:"MVP", mainValue:p=> `${p.mvpStars}`, extraLabel:"Votos", extraValue:p=> `${p.mvpPoints} · 🥇${p.mvp1} 🥈${p.mvp2} 🥉${p.mvp3}` })}
  `;
}

/* ============================
   RENDER
   ============================ */
function renderAll(){
  state.stats = computeStats(state.data);
  const active = $(".tab.is-active")?.dataset?.view || "players";
  if (active === "players") renderPlayers();
  if (active === "newMatch") renderNewMatch();
  if (active === "matches") renderMatches();
  if (active === "leaderboard") renderLeaderboard();
}

/* ============================
   UI
   ============================ */
function wireUI(){
  $$(".tab[data-view]").forEach(btn => btn.onclick = () => {
    if (btn.dataset.view !== "newMatch" && state.editingMatchId){
      state.editingMatchId = null;
      state.draft = null;
    }
    setView(btn.dataset.view);
  });

  $("#btnSync").onclick = async () => {
    try{
      overlay(true, "Sincronizando…");
      saveLocal(state.data);
      await saveRemote(state.data);
      toast("Sync OK");
    }catch(err){
      console.error(err);
      toast("Sync falló");
    }finally{
      overlay(false);
    }
  };
}

/* ============================
   BOOT
   ============================ */
async function initialLoad(){
  overlay(true, "Cargando…");
  try{
    const remote = await loadRemote();
    state.data = sanitizeData(remote);
    saveLocal(state.data);
  }catch(err){
    const local = loadLocal();
    state.data = local ? sanitizeData(local) : defaultData();
  }finally{
    overlay(false);
    state.stats = computeStats(state.data);
    if ((state.data.matches || []).length === 0) setView("newMatch");
    else setView("matches");
  }
}

wireUI();
initialLoad();
