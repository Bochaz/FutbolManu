/* ============================
   CONFIG — TU JSONBIN
   ============================ */
const BIN_ID = "695ec4fed0ea881f405b8cdf";
const X_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

const API_BASE = "https://api.jsonbin.io/v3/b";
const LS_KEY = "futbol_stats_data_v2";

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
  toast._tm = setTimeout(()=>t.classList.remove("show"), 2200);
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

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* ============================
   DATA MODEL
   v2:
   match.playerStats: { [playerId]: {goals:int, assists:int} }
   match.mvpVotes: [{ voter:string, picks:[p1,p2,p3], createdAt }]
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
  ui: {
    expandedMatches: new Set()
  }
};

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
   MIGRATION + SANITIZE
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

  // migrate old matches (if any)
  for (const m of out.matches){
    m.teamA = Array.isArray(m.teamA) ? m.teamA : [];
    m.teamB = Array.isArray(m.teamB) ? m.teamB : [];
    m.createdAt = m.createdAt || new Date().toISOString();

    // playerStats
    if (!m.playerStats || typeof m.playerStats !== "object"){
      m.playerStats = {};
    }

    // If legacy goals array exists: convert to counts
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

    // MVP votes
    if (!Array.isArray(m.mvpVotes)) m.mvpVotes = [];
    if (Array.isArray(m.mvp) && m.mvp.some(Boolean) && m.mvpVotes.length === 0){
      m.mvpVotes.push({
        voter: "Legacy",
        picks: [m.mvp[0] || null, m.mvp[1] || null, m.mvp[2] || null],
        createdAt: new Date().toISOString()
      });
    }
    delete m.mvp;

    // normalize playerStats values
    for (const [pid, ps] of Object.entries(m.playerStats)){
      if (!ps || typeof ps !== "object") { delete m.playerStats[pid]; continue; }
      m.playerStats[pid] = {
        goals: clampInt(ps.goals),
        assists: clampInt(ps.assists)
      };
    }

    // normalize votes
    m.mvpVotes = m.mvpVotes
      .filter(v => v && typeof v.voter === "string" && v.voter.trim())
      .map(v => ({
        voter: v.voter.trim().slice(0, 40),
        picks: Array.isArray(v.picks) ? [v.picks[0]||null, v.picks[1]||null, v.picks[2]||null] : [null,null,null],
        createdAt: v.createdAt || new Date().toISOString()
      }));
  }

  return out;
}

/* ============================
   STATS + MATCH COMPUTED
   ============================ */
function computeMatchScore(m){
  const sumGoals = (ids) => (ids || []).reduce((acc, pid) => {
    const ps = m.playerStats?.[pid];
    return acc + (ps ? clampInt(ps.goals) : 0);
  }, 0);
  const a = sumGoals(m.teamA);
  const b = sumGoals(m.teamB);
  return { a, b };
}

function computeMatchVoteTally(m){
  const points = {};
  const pickedCount = {};
  const pts = [3,2,1];
  for (const v of (m.mvpVotes || [])){
    const picks = Array.isArray(v.picks) ? v.picks : [];
    for (let i=0;i<3;i++){
      const pid = picks[i];
      if (!pid) continue;
      points[pid] = (points[pid] || 0) + pts[i];
      pickedCount[pid] = (pickedCount[pid] || 0) + 1;
    }
  }
  return { points, pickedCount };
}

function computeStats(data){
  const playersById = new Map(data.players.map(p => [p.id, p]));

  const stats = {};
  for (const p of data.players){
    stats[p.id] = {
      id: p.id,
      name: p.name,
      played: 0,
      goals: 0,
      assists: 0,
      mvpPoints: 0,
      mvp1: 0, mvp2: 0, mvp3: 0,
      wins: 0, draws: 0, losses: 0,
      gf: 0, ga: 0
    };
  }

  for (const m of data.matches){
    const teamA = new Set(m.teamA || []);
    const teamB = new Set(m.teamB || []);
    const participants = new Set([...(m.teamA||[]), ...(m.teamB||[])]);

    // played + goals/assists
    for (const pid of participants){
      const s = stats[pid];
      if (!s) continue;
      s.played += 1;
      const ps = m.playerStats?.[pid];
      if (ps){
        s.goals += clampInt(ps.goals);
        s.assists += clampInt(ps.assists);
      }
    }

    // score + results + gf/ga
    const { a:gA, b:gB } = computeMatchScore(m);
    m._scoreA = gA; m._scoreB = gB;

    for (const pid of participants){
      const s = stats[pid];
      if (!s) continue;
      const isA = teamA.has(pid);
      const my = isA ? gA : gB;
      const opp = isA ? gB : gA;
      s.gf += my;
      s.ga += opp;

      if (my > opp) s.wins += 1;
      else if (my < opp) s.losses += 1;
      else s.draws += 1;
    }

    // MVP votes tally
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
  }

  const list = Object.values(stats);
  const byGoals = [...list].sort((a,b)=> b.goals - a.goals || b.assists - a.assists || b.mvpPoints - a.mvpPoints);
  const byAssists = [...list].sort((a,b)=> b.assists - a.assists || b.goals - a.goals || b.mvpPoints - a.mvpPoints);
  const byMvp = [...list].sort((a,b)=> b.mvpPoints - a.mvpPoints || b.goals - a.goals || b.assists - a.assists);

  return { playersById, statsById: stats, byGoals, byAssists, byMvp };
}

/* ============================
   VIEW ROUTING
   ============================ */
function setView(name){
  const map = {
    players: $("#viewPlayers"),
    newMatch: $("#viewNewMatch"),
    matches: $("#viewMatches"),
    leaderboard: $("#viewLeaderboard"),
  };
  for (const [k, el] of Object.entries(map)){
    el.classList.toggle("hidden", k !== name);
  }
  $$(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === name));
  renderAll();
}

function playerName(pid){
  const p = state.stats?.playersById?.get(pid);
  return p?.name ?? "¿Quién?";
}

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
    toast(msg + " ✅");
  }catch(err){
    console.error(err);
    saveLocal(state.data);
    toast(msg + " ⚠️ (quedó en tu navegador)");
  }finally{
    overlay(false);
    state.stats = computeStats(state.data);
    renderAll();
  }
}

/* ============================
   PLAYERS VIEW (tabla)
   ============================ */
function renderPlayers(){
  const el = $("#viewPlayers");
  const data = state.data;
  const stats = state.stats;

  el.innerHTML = `
    <div class="h1">Jugadores</div>

    <div class="row" style="align-items:end;">
      <div style="flex:1; min-width:260px;">
        <div class="h2">Agregar jugador</div>
        <input class="input" id="playerName" placeholder="Nombre (ej: Tomi)" />
      </div>
      <div style="min-width:180px;">
        <button class="btn btn-primary" id="btnAddPlayer">+ Agregar</button>
      </div>
      <div style="flex:1; min-width:260px;">
        <div class="h2">Buscar</div>
        <input class="input" id="playerSearch" placeholder="Buscar…" />
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
          <th>GF/GA</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="playersTbody"></tbody>
    </table>
    <div class="mini" style="margin-top:10px;">MVP = puntos 3-2-1 por cada votante.</div>
  `;

  const q = ($("#playerSearch")?.value || "").trim().toLowerCase();
  const rows = data.players
    .map(p => ({ p, s: stats.statsById[p.id] }))
    .filter(x => !q || x.p.name.toLowerCase().includes(q))
    .sort((a,b)=> (b.s.mvpPoints - a.s.mvpPoints) || (b.s.goals - a.s.goals) || a.p.name.localeCompare(b.p.name));

  const tb = $("#playersTbody");
  tb.innerHTML = rows.length ? rows.map(({p,s}) => `
    <tr>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${s.played}</td>
      <td>${s.goals}</td>
      <td>${s.assists}</td>
      <td>${s.mvpPoints}</td>
      <td>${s.wins}-${s.draws}-${s.losses}</td>
      <td>${s.gf}/${s.ga}</td>
      <td><button class="btn btn-small btn-danger" data-del-player="${p.id}">Eliminar</button></td>
    </tr>
  `).join("") : `<tr><td colspan="8" class="mini">No hay jugadores todavía.</td></tr>`;

  $("#btnAddPlayer").onclick = async () => {
    const name = ($("#playerName").value || "").trim();
    if (!name) return toast("Poné un nombre.");
    if (state.data.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast("Ese jugador ya existe.");
    state.data.players.push({ id: uuid(), name });
    await persist("Jugador agregado");
    $("#playerName").value = "";
  };

  $("#playerSearch").oninput = () => renderPlayers();

  el.onclick = async (e) => {
    const btn = e.target.closest("[data-del-player]");
    if (!btn) return;
    const pid = btn.dataset.delPlayer;

    const used = state.data.matches.some(m => (m.teamA||[]).includes(pid) || (m.teamB||[]).includes(pid));
    if (used && !confirm("Ese jugador aparece en partidos. Si lo eliminás, se borra también de esos partidos. ¿Seguro?")) return;

    state.data.players = state.data.players.filter(p => p.id !== pid);

    // limpiar referencias en partidos
    for (const m of state.data.matches){
      m.teamA = (m.teamA||[]).filter(x => x !== pid);
      m.teamB = (m.teamB||[]).filter(x => x !== pid);
      if (m.playerStats) delete m.playerStats[pid];

      // limpiar votos
      m.mvpVotes = (m.mvpVotes||[]).map(v => ({
        ...v,
        picks: (v.picks||[]).map(x => x === pid ? null : x)
      }));
    }

    await persist("Jugador eliminado");
  };
}

/* ============================
   NEW MATCH VIEW (solo fecha+equipos)
   ============================ */
function renderNewMatch(){
  const el = $("#viewNewMatch");
  const data = state.data;

  if (!state.draft){
    state.draft = {
      id: uuid(),
      date: toISODateInput(new Date()),
      teamA: [],
      teamB: [],
      playerStats: {},
      mvpVotes: [],
      createdAt: new Date().toISOString()
    };
  }
  const d = state.draft;

  const chips = data.players
    .slice()
    .sort((a,b)=> a.name.localeCompare(b.name))
    .map(p => {
      const team = d.teamA.includes(p.id) ? "A" : d.teamB.includes(p.id) ? "B" : "N";
      return `
        <span class="player-chip" draggable="true"
          data-player-id="${p.id}" data-team="${team}" title="Click = rota / Drag = asigna">
          ${escapeHtml(p.name)}
          <small>${team==="A" ? "A" : team==="B" ? "B" : ""}</small>
        </span>
      `;
    }).join(" ");

  el.innerHTML = `
    <div class="h1">Nuevo partido</div>
    <div class="p">Primero armás fecha + equipos. Los goles/asistencias/votos se cargan después en “Partidos”.</div>

    <div class="row" style="align-items:end;">
      <div style="flex:1; min-width:260px;">
        <div class="h2">Fecha</div>
        <input class="input" type="date" id="matchDate" value="${d.date}" />
      </div>
      <div style="min-width:220px;">
        <button class="btn btn-primary" id="btnSaveMatch">Guardar partido</button>
      </div>
      <div style="min-width:160px;">
        <button class="btn" id="btnResetDraft">Reiniciar</button>
      </div>
    </div>

    <div class="hr"></div>

    <div class="h2">Jugadores (click o drag)</div>
    <div class="mini">Click = rota (sin equipo → A → B → sin equipo). Drag = tiralo en A o B.</div>
    <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;" id="chipPool">
      ${chips || `<span class="mini">No hay jugadores. Cargalos en “Jugadores”.</span>`}
    </div>

    <div class="hr"></div>

    <div class="row">
      <div class="col">
        <div class="h2">Equipo A</div>
        <div class="dropzone" id="zoneA" data-zone="A"></div>
      </div>
      <div class="col">
        <div class="h2">Equipo B</div>
        <div class="dropzone" id="zoneB" data-zone="B"></div>
      </div>
    </div>
  `;

  $("#matchDate").onchange = (e) => { d.date = e.target.value; };

  renderTeamZone("A");
  renderTeamZone("B");
  setupChipInteractions();

  $("#btnResetDraft").onclick = () => {
    if (!confirm("¿Reiniciar el partido en edición?")) return;
    state.draft = null;
    toast("Reiniciado");
    renderNewMatch();
  };

  $("#btnSaveMatch").onclick = async () => {
    if (!d.date) return toast("Elegí fecha.");
    const participants = [...new Set([...(d.teamA||[]), ...(d.teamB||[])])];
    if (participants.length < 2) return toast("Sumá jugadores.");
    if (d.teamA.length < 1 || d.teamB.length < 1) return toast("Necesitás al menos 1 por equipo.");

    state.data.matches.push({
      id: d.id,
      date: d.date,
      teamA: [...d.teamA],
      teamB: [...d.teamB],
      playerStats: {},
      mvpVotes: [],
      createdAt: d.createdAt
    });

    state.draft = null;
    await persist("Partido creado");
    setView("matches");
  };

  function renderTeamZone(team){
    const zone = team === "A" ? $("#zoneA") : $("#zoneB");
    const ids = team === "A" ? d.teamA : d.teamB;
    zone.innerHTML = ids.length
      ? ids.map(pid => `<span class="player-chip" draggable="true" data-player-id="${pid}" data-team="${team}">${escapeHtml(playerName(pid))}<small>${team}</small></span>`).join(" ")
      : `<span class="mini">Arrastrá jugadores acá o clickealos arriba.</span>`;
  }

  function setupChipInteractions(){
    const root = $("#viewNewMatch");

    // click cycle (delegated, once because we re-render)
    root.addEventListener("click", (e) => {
      const chip = e.target.closest(".player-chip");
      if (!chip) return;
      const pid = chip.dataset.playerId;
      toggleAssignment(pid);
      renderNewMatch();
    }, { once:true });

    // drag
    $$(".player-chip", root).forEach(chip => {
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", chip.dataset.playerId);
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".dropzone", root).forEach(zone => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("is-over");
        const pid = e.dataTransfer.getData("text/plain");
        if (!pid) return;
        assignTo(pid, zone.dataset.zone);
        renderNewMatch();
      });
    });
  }

  function toggleAssignment(pid){
    const inA = d.teamA.includes(pid);
    const inB = d.teamB.includes(pid);
    if (!inA && !inB) assignTo(pid, "A");
    else if (inA) assignTo(pid, "B");
    else unassign(pid);
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
   MATCHES VIEW (visual + edición por jugador + votos)
   ============================ */
function renderMatches(){
  const el = $("#viewMatches");
  const list = state.data.matches.slice().sort(sortMatchesDesc);

  el.innerHTML = `
    <div class="h1">Partidos</div>
    <div class="p">Resultado arriba, equipos abajo. Click en un jugador para cargar ⚽ y 🥾. Votación de figuras con nombre.</div>

    <div id="matchesWrap">
      ${list.length ? list.map(m => renderMatchCard(m)).join("") : `<div class="mini">Todavía no hay partidos. Andá a “Nuevo partido”.</div>`}
    </div>
  `;

  // handlers (delegated)
  el.onclick = async (e) => {
    const btnDel = e.target.closest("[data-del-match]");
    if (btnDel){
      const id = btnDel.dataset.delMatch;
      if (!confirm("¿Eliminar este partido?")) return;
      state.data.matches = state.data.matches.filter(m => m.id !== id);
      await persist("Partido eliminado");
      return;
    }

    const btnToggle = e.target.closest("[data-toggle-detail]");
    if (btnToggle){
      const id = btnToggle.dataset.toggleDetail;
      if (state.ui.expandedMatches.has(id)) state.ui.expandedMatches.delete(id);
      else state.ui.expandedMatches.add(id);
      renderMatches();
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
  };

  function renderMatchCard(m){
    const expanded = state.ui.expandedMatches.has(m.id);
    const { a, b } = computeMatchScore(m);
    const tally = computeMatchVoteTally(m);

    const renderTeam = (ids) => {
      if (!ids.length) return `<div class="mini">—</div>`;
      return ids.map(pid => {
        const ps = m.playerStats?.[pid] || { goals:0, assists:0 };
        const g = clampInt(ps.goals);
        const a = clampInt(ps.assists);
        const balls = g <= 6 ? "⚽".repeat(g) : `⚽×${g}`;
        const boots = a <= 6 ? "🥾".repeat(a) : `🥾×${a}`;

        const pts = tally.points[pid] || 0;
        const votes = tally.pickedCount[pid] || 0;
        const hasVotes = votes > 0;

        return `
          <button class="player-row ${hasVotes ? "has-votes" : ""}"
            data-edit-player="${pid}" data-match-id="${m.id}" title="Cargar goles/asistencias">
            <span class="name">${escapeHtml(playerName(pid))}${hasVotes ? `<span class="icon-pill">⭐ ${pts}</span>` : ""}</span>
            <span class="icons">
              ${g ? `<span class="icon-pill">${balls}</span>` : ""}
              ${a ? `<span class="icon-pill">${boots}</span>` : ""}
            </span>
          </button>
        `;
      }).join("");
    };

    const votesCount = (m.mvpVotes || []).length;

    // detail votes table
    const votesTable = votesCount ? `
      <table class="table" style="margin-top:8px;">
        <thead><tr><th>Votante</th><th>🥇</th><th>🥈</th><th>🥉</th></tr></thead>
        <tbody>
          ${(m.mvpVotes||[]).slice().reverse().map(v => `
            <tr>
              <td><b>${escapeHtml(v.voter)}</b></td>
              <td>${v.picks?.[0] ? escapeHtml(playerName(v.picks[0])) : "—"}</td>
              <td>${v.picks?.[1] ? escapeHtml(playerName(v.picks[1])) : "—"}</td>
              <td>${v.picks?.[2] ? escapeHtml(playerName(v.picks[2])) : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : `<div class="mini" style="margin-top:8px;">Todavía nadie votó figuras.</div>`;

    return `
      <div class="match-card">
        <div class="match-header">
          <div>
            <div class="scoreline">
              ${fmtDate(m.date)} · A <span class="big">${a}</span> — <span class="big">${b}</span> B
            </div>
            <div class="match-meta">${(m.teamA?.length||0)} vs ${(m.teamB?.length||0)} · Votos: ${votesCount}</div>
          </div>
          <div class="row" style="gap:8px; justify-content:flex-end;">
            <button class="btn btn-primary btn-small" data-vote="${m.id}">Votar figuras</button>
            <button class="btn btn-small" data-toggle-detail="${m.id}">${expanded ? "Ocultar detalle" : "Detalle"}</button>
            <button class="btn btn-danger btn-small" data-del-match="${m.id}">Eliminar</button>
          </div>
        </div>

        <div class="teams-split">
          <div class="team-box">
            <div class="team-title"><span>Equipo A</span><b>${a}</b></div>
            ${renderTeam(m.teamA || [])}
          </div>
          <div class="team-box">
            <div class="team-title"><span>Equipo B</span><b>${b}</b></div>
            ${renderTeam(m.teamB || [])}
          </div>
        </div>

        ${expanded ? `
          <div class="detail-box">
            <div class="h2">Detalle de votos</div>
            ${votesTable}
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
          <div>
            <div class="h1" style="margin:0;">${escapeHtml(playerName(pid))}</div>
            <div class="mini">Partido ${fmtDate(match.date)} · Editá goles y asistencias</div>
          </div>
          <button class="btn" id="close">Cerrar</button>
        </div>

        <div class="hr"></div>

        <div class="row" style="align-items:end;">
          <div class="col">
            <div class="h2">Goles (⚽)</div>
            <input class="input" type="number" min="0" id="goals" value="${clampInt(current.goals)}" />
          </div>
          <div class="col">
            <div class="h2">Asistencias (🥾)</div>
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
    if (participants.length < 2) return toast("Este partido no tiene suficientes jugadores.");

    const opts = participants
      .map(pid => `<option value="${pid}">${escapeHtml(playerName(pid))}</option>`)
      .join("");

    const modal = document.createElement("div");
    modal.className = "overlay";
    modal.innerHTML = `
      <div class="card" style="width:min(820px,92vw); padding:16px; border-radius:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div>
            <div class="h1" style="margin:0;">Votar figuras</div>
            <div class="mini">${fmtDate(match.date)} · Cada votante suma puntos 3-2-1</div>
          </div>
          <button class="btn" id="close">Cerrar</button>
        </div>

        <div class="hr"></div>

        <div class="h2">Tu nombre</div>
        <input class="input" id="voter" placeholder="Ej: Nico" maxlength="40" />

        <div class="hr"></div>

        <div class="row">
          <div class="col">
            <div class="h2">🥇 Primera figura</div>
            <select class="select" id="p1"><option value="">Elegí…</option>${opts}</select>
          </div>
          <div class="col">
            <div class="h2">🥈 Segunda figura</div>
            <select class="select" id="p2"><option value="">Elegí…</option>${opts}</select>
          </div>
          <div class="col">
            <div class="h2">🥉 Tercera figura</div>
            <select class="select" id="p3"><option value="">Elegí…</option>${opts}</select>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:flex-end;">
          <button class="btn btn-primary" id="save">Guardar voto</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    $("#close", modal).onclick = () => modal.remove();

    $("#save", modal).onclick = async () => {
      const voter = ($("#voter", modal).value || "").trim();
      if (!voter) return toast("Poné tu nombre para votar.");

      const p1 = $("#p1", modal).value || null;
      const p2 = $("#p2", modal).value || null;
      const p3 = $("#p3", modal).value || null;

      const picks = [p1,p2,p3].filter(Boolean);
      const uniq = new Set(picks);
      if (picks.length && uniq.size !== picks.length) return toast("Las figuras deben ser distintas.");

      match.mvpVotes = match.mvpVotes || [];
      match.mvpVotes.push({
        voter,
        picks: [p1,p2,p3],
        createdAt: new Date().toISOString()
      });

      modal.remove();
      await persist("Voto guardado");
    };
  }
}

/* ============================
   LEADERBOARD VIEW (dejamos rankings)
   ============================ */
function renderLeaderboard(){
  const el = $("#viewLeaderboard");
  const s = state.stats;

  function topTable(title, arr, colA, colB){
    const rows = arr.slice(0,10).map((p, i) => `
      <tr>
        <td>${i+1}</td>
        <td><b>${escapeHtml(p.name)}</b></td>
        <td>${colA(p)}</td>
        <td>${colB(p)}</td>
      </tr>
    `).join("");
    return `
      <div class="match-card" style="margin-bottom:12px;">
        <div class="h2">${title}</div>
        <table class="table" style="margin-top:8px;">
          <thead><tr><th>#</th><th>Jugador</th><th>Principal</th><th>Extra</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="mini">—</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="h1">Rankings</div>
    <div class="p">Para cerrar discusiones en 2 segundos.</div>

    ${topTable("Goleadores", s.byGoals, p=> `${p.goals} G`, p=> `${p.assists} A`)}
    ${topTable("Asistidores", s.byAssists, p=> `${p.assists} A`, p=> `${p.goals} G`)}
    ${topTable("MVP", s.byMvp, p=> `${p.mvpPoints} pts`, p=> `🥇${p.mvp1} 🥈${p.mvp2} 🥉${p.mvp3}`)}
  `;
}

/* ============================
   RENDER ROUTER
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
   UI WIRING
   ============================ */
function wireUI(){
  $$(".tab[data-view]").forEach(btn => btn.onclick = () => setView(btn.dataset.view));

  $("#btnSync").onclick = async () => {
    try{
      overlay(true, "Sincronizando…");
      saveLocal(state.data);
      await saveRemote(state.data);
      toast("Sync OK ✅");
    }catch(err){
      console.error(err);
      toast("Sync falló ⚠️");
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
    toast("Datos cargados ✅");
  }catch(err){
    console.warn("Remote load failed:", err);
    const local = loadLocal();
    if (local){
      state.data = sanitizeData(local);
      toast("Cargado desde cache local ⚠️");
    }else{
      state.data = defaultData();
      toast("Arrancamos en blanco");
    }
  }finally{
    overlay(false);
    state.stats = computeStats(state.data);

    // flujo sugerido: si no hay partidos → Nuevo Partido, si hay → Partidos
    if ((state.data.matches || []).length === 0) setView("newMatch");
    else setView("matches");
  }
}

wireUI();
initialLoad();
