/* ============================
   CONFIG — TU JSONBIN
   ============================ */
const BIN_ID = "695ec4fed0ea881f405b8cdf";
const X_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

/* JSONBin v3:
   - GET latest:  /v3/b/{id}/latest
   - PUT update:  /v3/b/{id}
*/
const API_BASE = "https://api.jsonbin.io/v3/b";
const LS_KEY = "futbol_stats_data_v1";

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
  // iso: YYYY-MM-DD
  if (!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  const pad = n => String(n).padStart(2,"0");
  return `${pad(d)}/${pad(m)}/${y}`;
}

function clampInt(v){
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/* ============================
   DATA MODEL
   ============================ */
function defaultData(){
  return {
    version: 1,
    players: [],
    matches: [],
    updatedAt: new Date().toISOString()
  };
}

let state = {
  data: defaultData(),
  stats: null,
  draft: null
};

/* ============================
   JSONBIN IO + LOCAL CACHE
   ============================ */
async function loadRemote(){
  const url = `${API_BASE}/${BIN_ID}/latest`;
  const res = await fetch(url, {
    headers: { "X-Access-Key": X_ACCESS_KEY }
  });
  if (!res.ok) throw new Error(`GET failed ${res.status}`);
  const json = await res.json();
  // json.record holds your actual record in JSONBin v3
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
   STATS
   ============================ */
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

    // played
    for (const pid of participants){
      if (stats[pid]) stats[pid].played += 1;
    }

    // goals by team
    let gA = 0, gB = 0;

    for (const g of (m.goals || [])){
      const scorer = g.scorerId;
      const assist = g.assistId || null;
      if (teamA.has(scorer)) gA += 1;
      else if (teamB.has(scorer)) gB += 1;

      if (stats[scorer]) stats[scorer].goals += 1;
      if (assist && stats[assist]) stats[assist].assists += 1;
    }

    // gf/ga + result
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

    // MVP points 3-2-1
    const mvp = (m.mvp || []).filter(Boolean);
    const pts = [3,2,1];
    for (let i=0;i<3;i++){
      const pid = mvp[i];
      if (!pid || !stats[pid]) continue;
      stats[pid].mvpPoints += pts[i];
      if (i===0) stats[pid].mvp1 += 1;
      if (i===1) stats[pid].mvp2 += 1;
      if (i===2) stats[pid].mvp3 += 1;
    }

    // store computed score in match (for render convenience)
    m._scoreA = gA; m._scoreB = gB;
  }

  const list = Object.values(stats);
  const byGoals = [...list].sort((a,b)=> b.goals - a.goals || b.assists - a.assists || b.mvpPoints - a.mvpPoints);
  const byAssists = [...list].sort((a,b)=> b.assists - a.assists || b.goals - a.goals || b.mvpPoints - a.mvpPoints);
  const byMvp = [...list].sort((a,b)=> b.mvpPoints - a.mvpPoints || b.goals - a.goals || b.assists - a.assists);

  return {
    playersById,
    statsById: stats,
    byGoals,
    byAssists,
    byMvp
  };
}

/* ============================
   RENDER HELPERS
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
  renderAll(); // cheap + safe
}

function playerName(pid){
  const p = state.stats?.playersById?.get(pid);
  return p?.name ?? "¿Quién?";
}

function sortMatchesDesc(a,b){
  return (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "");
}

/* ============================
   VIEWS
   ============================ */
function renderPlayers(){
  const el = $("#viewPlayers");
  const data = state.data;
  const stats = state.stats;

  const totalPlayers = data.players.length;
  const totalMatches = data.matches.length;

  const topGoal = stats.byGoals[0];
  const topAst = stats.byAssists[0];
  const topMvp = stats.byMvp[0];

  el.innerHTML = `
    <div class="row">
      <div class="col">
        <div class="h1">Jugadores</div>
        <div class="p">Cargás jugadores acá y la app se encarga del resto (sí, incluso de tu ego).</div>

        <div class="row">
          <div class="cardlet" style="flex:1">
            <div class="kpi"><div class="lab">Jugadores</div><div class="num">${totalPlayers}</div></div>
          </div>
          <div class="cardlet" style="flex:1">
            <div class="kpi"><div class="lab">Partidos</div><div class="num">${totalMatches}</div></div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="h2">Agregar jugador</div>
        <div class="row">
          <input class="input" id="playerName" placeholder="Nombre (ej: Tomi)" />
          <button class="btn btn-primary" id="btnAddPlayer">+ Agregar</button>
        </div>

        <div class="hr"></div>

        <div class="h2">Lista</div>
        <input class="input" id="playerSearch" placeholder="Buscar jugador…" />

        <div id="playersGrid" class="grid" style="margin-top:10px;"></div>
      </div>

      <div class="col">
        <div class="h1">Resumen rápido</div>

        <div class="cardlet">
          <div class="h2">Líderes</div>
          <div class="row" style="gap:10px; align-items:center;">
            <span class="badge good">Goles: ${topGoal ? `${topGoal.name} (${topGoal.goals})` : "—"}</span>
            <span class="badge good">Asist.: ${topAst ? `${topAst.name} (${topAst.assists})` : "—"}</span>
            <span class="badge good">MVP: ${topMvp ? `${topMvp.name} (${topMvp.mvpPoints} pts)` : "—"}</span>
          </div>
          <div class="mini" style="margin-top:10px;">MVP suma 3-2-1 puntos (primera/segunda/tercera figura).</div>
        </div>

        <div class="cardlet">
          <div class="h2">Tips</div>
          <ul class="mini" style="margin:8px 0 0 18px;">
            <li>En <b>Nuevo partido</b> podés asignar por click o arrastrando.</li>
            <li>Goles con asistencia opcional (porque a veces “la asistencia” fue un rebote… y está bien).</li>
            <li>Si Sync falla, queda cacheado en tu navegador y reintenta después.</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  const grid = $("#playersGrid");
  const q = ($("#playerSearch")?.value || "").trim().toLowerCase();
  const list = data.players
    .map(p => ({
      p,
      s: state.stats.statsById[p.id] || null
    }))
    .filter(x => !q || x.p.name.toLowerCase().includes(q))
    .sort((a,b)=> (b.s?.mvpPoints||0) - (a.s?.mvpPoints||0) || (b.s?.goals||0) - (a.s?.goals||0));

  grid.innerHTML = list.length ? list.map(({p,s}) => `
    <div class="cardlet">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div>
          <div style="font-weight:950; font-size:16px;">${escapeHtml(p.name)}</div>
          <div class="mini">PJ ${s?.played||0} · G ${s?.goals||0} · A ${s?.assists||0} · MVP ${s?.mvpPoints||0}</div>
          <div class="mini">W-D-L ${s?.wins||0}-${s?.draws||0}-${s?.losses||0} · GF/GA ${s?.gf||0}/${s?.ga||0}</div>
        </div>
        <button class="btn btn-small btn-danger" data-del-player="${p.id}" title="Eliminar jugador">Eliminar</button>
      </div>
    </div>
  `).join("") : `<div class="mini">No hay jugadores todavía. Dale, arrancá con el primer crack.</div>`;

  $("#btnAddPlayer").onclick = async () => {
    const name = ($("#playerName").value || "").trim();
    if (!name) return toast("Poné un nombre.");
    if (state.data.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast("Ese jugador ya existe.");
    state.data.players.push({ id: uuid(), name });
    state.data.updatedAt = new Date().toISOString();
    await persist("Jugador agregado");
    $("#playerName").value = "";
  };

  $("#playerSearch").oninput = () => renderPlayers();

  grid.onclick = async (e) => {
    const btn = e.target.closest("[data-del-player]");
    if (!btn) return;
    const pid = btn.dataset.delPlayer;

    const used = state.data.matches.some(m => (m.teamA||[]).includes(pid) || (m.teamB||[]).includes(pid));
    if (used && !confirm("Ese jugador aparece en partidos. Si lo eliminás, se borra el nombre de esos registros. ¿Seguro?")) return;

    state.data.players = state.data.players.filter(p => p.id !== pid);
    // limpiar referencias en partidos
    for (const m of state.data.matches){
      m.teamA = (m.teamA||[]).filter(x => x !== pid);
      m.teamB = (m.teamB||[]).filter(x => x !== pid);
      m.goals = (m.goals||[]).filter(g => g.scorerId !== pid && g.assistId !== pid);
      m.mvp = (m.mvp||[]).filter(x => x !== pid);
    }
    state.data.updatedAt = new Date().toISOString();
    await persist("Jugador eliminado");
  };
}

function renderNewMatch(){
  const el = $("#viewNewMatch");
  const data = state.data;

  if (!state.draft){
    state.draft = {
      id: uuid(),
      date: toISODateInput(new Date()),
      teamA: [],
      teamB: [],
      goals: [],
      mvp: [null,null,null],
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
          data-player-id="${p.id}" data-team="${team}" title="Click para mover / Drag para asignar">
          ${escapeHtml(p.name)}
          <small>${team==="A" ? "A" : team==="B" ? "B" : ""}</small>
        </span>
      `;
    }).join(" ");

  const participants = [...new Set([...(d.teamA||[]), ...(d.teamB||[])])];
  const optionsParticipants = participants
    .map(pid => `<option value="${pid}">${escapeHtml(playerName(pid))}</option>`)
    .join("");

  // score live
  const tmpMatch = { teamA: d.teamA, teamB: d.teamB, goals: d.goals, mvp: d.mvp };
  const tmpData = { ...state.data, matches: [tmpMatch] };
  const tmpStats = computeStats(tmpData);
  const gA = tmpMatch._scoreA || 0;
  const gB = tmpMatch._scoreB || 0;

  const goalsList = (d.goals||[]).map((g, idx) => {
    const a = g.assistId ? ` (A: ${escapeHtml(playerName(g.assistId))})` : "";
    return `
      <tr>
        <td>${idx+1}</td>
        <td>${escapeHtml(playerName(g.scorerId))}${a}</td>
        <td><button class="btn btn-small btn-danger" data-del-goal="${idx}">Borrar</button></td>
      </tr>
    `;
  }).join("");

  const mvpBadges = d.mvp.map((pid, i) => {
    const label = i===0 ? "🥇" : i===1 ? "🥈" : "🥉";
    return `<span class="badge good">${label} ${pid ? escapeHtml(playerName(pid)) : "—"}</span>`;
  }).join(" ");

  el.innerHTML = `
    <div class="row">
      <div class="col">
        <div class="h1">Nuevo partido</div>
        <div class="p">Armá equipos, cargá goles/asistencias y elegí 3 figuras.</div>

        <div class="row" style="align-items:end;">
          <div style="flex:1; min-width:260px;">
            <div class="h2">Fecha</div>
            <input class="input" type="date" id="matchDate" value="${d.date}" />
          </div>
          <div style="min-width:260px;">
            <div class="h2">Marcador</div>
            <div class="row" style="gap:10px; align-items:center;">
              <span class="badge good">Equipo A: ${gA}</span>
              <span class="badge good">Equipo B: ${gB}</span>
            </div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="h2">Jugadores (click o drag)</div>
        <div class="details">
          <div class="mini">Tip: click = rota (sin equipo → A → B → sin equipo). Drag = tiralo en A o B.</div>
          <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;" id="chipPool">
            ${chips || `<span class="mini">No hay jugadores. Andá a “Jugadores” y cargalos.</span>`}
          </div>
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

        <div class="hr"></div>

        <div class="h2">Goles</div>
        <div class="row" style="align-items:end;">
          <div style="flex:1; min-width:250px;">
            <div class="mini">Goleador</div>
            <select class="select" id="selScorer">
              <option value="">Elegí…</option>
              ${optionsParticipants}
            </select>
          </div>
          <div style="flex:1; min-width:250px;">
            <div class="mini">Asistencia (opcional)</div>
            <select class="select" id="selAssist">
              <option value="">Sin asistencia</option>
              ${optionsParticipants}
            </select>
          </div>
          <div style="min-width:160px;">
            <button class="btn btn-primary" id="btnAddGoal">+ Gol</button>
          </div>
        </div>

        <div style="margin-top:10px;">
          <table class="table">
            <thead><tr><th>#</th><th>Detalle</th><th></th></tr></thead>
            <tbody>
              ${goalsList || `<tr><td colspan="3" class="mini">Todavía no cargaste goles.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="hr"></div>

        <div class="h2">Figuras del partido (MVP 3-2-1)</div>
        <div class="row" style="align-items:center;">
          <div style="flex:1">${mvpBadges}</div>
          <button class="btn" id="btnPickMvp">Elegir figuras</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <button class="btn" id="btnResetDraft">Reiniciar</button>
          <button class="btn btn-primary" id="btnSaveMatch">Guardar partido</button>
        </div>
      </div>

      <div class="col">
        <div class="h1">Vista rápida</div>
        <div class="cardlet">
          <div class="h2">Participantes</div>
          <div class="mini">${participants.length} jugadores seleccionados</div>
          <div class="mini" style="margin-top:6px;">
            A: ${(d.teamA||[]).length} · B: ${(d.teamB||[]).length}
          </div>
        </div>

        <div class="cardlet">
          <div class="h2">Checklist</div>
          <ul class="mini" style="margin:8px 0 0 18px;">
            <li>Asigná equipos A/B</li>
            <li>Cargá goles y asistencias</li>
            <li>Elegí 3 figuras (🥇🥈🥉)</li>
            <li>Guardá y listo</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  $("#matchDate").onchange = (e) => { d.date = e.target.value; };

  // Drop zones render content
  renderTeamZone("A");
  renderTeamZone("B");

  // Chip click toggle + drag
  setupChipInteractions();

  $("#btnAddGoal").onclick = () => {
    const scorerId = $("#selScorer").value;
    const assistId = $("#selAssist").value || null;
    if (!scorerId) return toast("Elegí goleador.");
    if (assistId && assistId === scorerId) return toast("No te podés asistir a vos mismo (salvo que seas Maradona en FIFA).");
    d.goals.push({ scorerId, assistId, at: new Date().toISOString() });
    toast("Gol cargado");
    renderNewMatch();
  };

  $("#viewNewMatch").onclick = (e) => {
    const del = e.target.closest("[data-del-goal]");
    if (!del) return;
    const idx = Number(del.dataset.delGoal);
    d.goals.splice(idx, 1);
    toast("Gol borrado");
    renderNewMatch();
  };

  $("#btnPickMvp").onclick = () => openMvpPicker();

  $("#btnResetDraft").onclick = () => {
    if (!confirm("¿Reiniciar el partido en edición?")) return;
    state.draft = null;
    toast("Reiniciado");
    renderNewMatch();
  };

  $("#btnSaveMatch").onclick = async () => {
    const participantsNow = [...new Set([...(d.teamA||[]), ...(d.teamB||[])])];
    if (!d.date) return toast("Elegí fecha.");
    if (participantsNow.length < 2) return toast("Sumá jugadores, no alcanza con vos y tu sombra.");
    if ((d.teamA||[]).length < 1 || (d.teamB||[]).length < 1) return toast("Necesitás al menos 1 por equipo.");

    // Validate MVP uniqueness
    const mvp = d.mvp.filter(Boolean);
    const uniq = new Set(mvp);
    if (mvp.length && uniq.size !== mvp.length) return toast("Las figuras deben ser distintas.");

    state.data.matches.push({
      id: d.id,
      date: d.date,
      teamA: [...d.teamA],
      teamB: [...d.teamB],
      goals: [...d.goals],
      mvp: [...d.mvp],
      createdAt: d.createdAt
    });
    state.data.updatedAt = new Date().toISOString();

    state.draft = null;
    await persist("Partido guardado");
    setView("matches");
  };

  function renderTeamZone(team){
    const zone = team === "A" ? $("#zoneA") : $("#zoneB");
    const ids = team === "A" ? d.teamA : d.teamB;
    const items = ids
      .map(pid => `<span class="player-chip" draggable="true" data-player-id="${pid}" data-team="${team}">${escapeHtml(playerName(pid))}<small>${team}</small></span>`)
      .join(" ");
    zone.innerHTML = items || `<span class="mini">Arrastrá jugadores acá o clickealos arriba.</span>`;
  }

  function setupChipInteractions(){
    const root = $("#viewNewMatch");

    // click cycle
    root.addEventListener("click", (e) => {
      const chip = e.target.closest(".player-chip");
      if (!chip) return;
      const pid = chip.dataset.playerId;
      toggleAssignment(pid);
      renderNewMatch();
    }, { once: true }); // we re-render, so "once" is safe

    // drag
    $$(".player-chip", root).forEach(chip => {
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", chip.dataset.playerId);
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".dropzone", root).forEach(zone => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("is-over");
      });
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

    // if goal scorer/assist now invalid? we'll keep it, user can fix; but MVP picker will show participants only
  }

  function unassign(pid){
    d.teamA = d.teamA.filter(x => x !== pid);
    d.teamB = d.teamB.filter(x => x !== pid);

    // remove goals involving player if they are no longer in match
    const participantsNow = new Set([...(d.teamA||[]), ...(d.teamB||[])]);
    d.goals = (d.goals||[]).filter(g => participantsNow.has(g.scorerId) && (!g.assistId || participantsNow.has(g.assistId)));

    // remove from MVP if not participant
    d.mvp = d.mvp.map(x => participantsNow.has(x) ? x : null);
  }

  function openMvpPicker(){
    const participantsNow = [...new Set([...(d.teamA||[]), ...(d.teamB||[])])];
    if (participantsNow.length < 1) return toast("Primero seleccioná participantes.");

    const modal = document.createElement("div");
    modal.className = "overlay";
    modal.innerHTML = `
      <div class="card" style="width:min(920px,92vw); padding:16px; border-radius:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div>
            <div class="h1" style="margin:0;">Elegir figuras</div>
            <div class="mini">Click en un puesto (🥇🥈🥉) y después elegí jugador.</div>
          </div>
          <button class="btn" id="mvpClose">Cerrar</button>
        </div>

        <div class="hr"></div>

        <div class="row" style="align-items:center;">
          <button class="btn btn-primary" id="slot0">🥇 ${d.mvp[0] ? escapeHtml(playerName(d.mvp[0])) : "Vacante"}</button>
          <button class="btn btn-primary" id="slot1">🥈 ${d.mvp[1] ? escapeHtml(playerName(d.mvp[1])) : "Vacante"}</button>
          <button class="btn btn-primary" id="slot2">🥉 ${d.mvp[2] ? escapeHtml(playerName(d.mvp[2])) : "Vacante"}</button>
          <button class="btn btn-danger" id="mvpClear">Limpiar</button>
        </div>

        <div class="hr"></div>

        <div class="h2">Jugadores</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;" id="mvpPlayers">
          ${participantsNow.map(pid => `<button class="btn" data-pick="${pid}">${escapeHtml(playerName(pid))}</button>`).join("")}
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:flex-end;">
          <button class="btn btn-primary" id="mvpDone">Listo</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let activeSlot = 0;
    const slotBtns = [$("#slot0", modal), $("#slot1", modal), $("#slot2", modal)];
    highlight();

    slotBtns.forEach((b, i) => b.onclick = () => { activeSlot = i; highlight(); });

    $("#mvpPlayers", modal).onclick = (e) => {
      const btn = e.target.closest("[data-pick]");
      if (!btn) return;
      const pid = btn.dataset.pick;

      // uniqueness
      const alreadyAt = d.mvp.findIndex(x => x === pid);
      if (alreadyAt !== -1 && alreadyAt !== activeSlot) return toast("Ese jugador ya está en otra figura.");

      d.mvp[activeSlot] = pid;
      // auto-advance
      activeSlot = Math.min(2, activeSlot + 1);
      refreshSlots();
      highlight();
    };

    $("#mvpClear", modal).onclick = () => {
      d.mvp = [null,null,null];
      activeSlot = 0;
      refreshSlots(); highlight();
    };

    $("#mvpClose", modal).onclick = () => { modal.remove(); renderNewMatch(); };
    $("#mvpDone", modal).onclick = () => { modal.remove(); renderNewMatch(); };

    function refreshSlots(){
      slotBtns[0].textContent = `🥇 ${d.mvp[0] ? playerName(d.mvp[0]) : "Vacante"}`;
      slotBtns[1].textContent = `🥈 ${d.mvp[1] ? playerName(d.mvp[1]) : "Vacante"}`;
      slotBtns[2].textContent = `🥉 ${d.mvp[2] ? playerName(d.mvp[2]) : "Vacante"}`;
    }
    function highlight(){
      slotBtns.forEach((b,i)=>{
        b.style.outline = (i===activeSlot) ? "3px solid rgba(57,211,83,.55)" : "none";
      });
    }
  }
}

function renderMatches(){
  const el = $("#viewMatches");
  const list = state.data.matches.slice().sort(sortMatchesDesc);

  el.innerHTML = `
    <div class="row">
      <div class="col">
        <div class="h1">Partidos</div>
        <div class="p">Historial con detalle. El VAR acá es tu dedo borrando cosas.</div>

        ${list.length ? list.map(m => {
          const scoreA = m._scoreA ?? 0;
          const scoreB = m._scoreB ?? 0;
          const mvp = (m.mvp||[]).filter(Boolean);
          const mvpStr = mvp.length ? mvp.map((pid,i)=> (i===0?"🥇":i===1?"🥈":"🥉") + " " + escapeHtml(playerName(pid))).join(" · ") : "—";

          const goalsStr = (m.goals||[]).length
            ? (m.goals||[]).map(g => {
                const a = g.assistId ? ` (A: ${escapeHtml(playerName(g.assistId))})` : "";
                return `• ${escapeHtml(playerName(g.scorerId))}${a}`;
              }).join("<br/>")
            : `<span class="mini">Sin goles cargados.</span>`;

          return `
            <details class="details" style="margin-bottom:10px;">
              <summary>
                <span style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                  <span><b>${fmtDate(m.date)}</b> · A <b>${scoreA}</b> — <b>${scoreB}</b> B</span>
                  <span class="mini">click para ver</span>
                </span>
              </summary>

              <div class="hr"></div>

              <div class="row">
                <div class="col">
                  <div class="h2">Equipo A</div>
                  <div class="mini">${(m.teamA||[]).map(pid=>escapeHtml(playerName(pid))).join(" · ") || "—"}</div>
                </div>
                <div class="col">
                  <div class="h2">Equipo B</div>
                  <div class="mini">${(m.teamB||[]).map(pid=>escapeHtml(playerName(pid))).join(" · ") || "—"}</div>
                </div>
              </div>

              <div class="hr"></div>

              <div class="row">
                <div class="col">
                  <div class="h2">Goles</div>
                  <div class="mini">${goalsStr}</div>
                </div>
                <div class="col">
                  <div class="h2">Figuras</div>
                  <div class="mini">${mvpStr}</div>
                </div>
              </div>

              <div class="hr"></div>

              <div class="row" style="justify-content:flex-end;">
                <button class="btn btn-danger" data-del-match="${m.id}">Eliminar partido</button>
              </div>
            </details>
          `;
        }).join("") : `<div class="mini">Todavía no hay partidos. En “Nuevo partido” empieza la magia.</div>`}
      </div>
    </div>
  `;

  el.onclick = async (e) => {
    const btn = e.target.closest("[data-del-match]");
    if (!btn) return;
    const id = btn.dataset.delMatch;
    if (!confirm("¿Eliminar este partido?")) return;
    state.data.matches = state.data.matches.filter(m => m.id !== id);
    state.data.updatedAt = new Date().toISOString();
    await persist("Partido eliminado");
  };
}

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
      <div class="cardlet">
        <div class="h2">${title}</div>
        <table class="table" style="margin-top:8px;">
          <thead><tr><th>#</th><th>Jugador</th><th>Principal</th><th>Extra</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="mini">—</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="row">
      <div class="col">
        <div class="h1">Rankings</div>
        <div class="p">Para cuando alguien diga “yo la rompí todo el año”. Acá queda registrado.</div>

        <div class="grid">
          ${topTable("Goleadores", s.byGoals, p=> `${p.goals} G`, p=> `${p.assists} A`)}
          ${topTable("Asistidores", s.byAssists, p=> `${p.assists} A`, p=> `${p.goals} G`)}
          ${topTable("MVP", s.byMvp, p=> `${p.mvpPoints} pts`, p=> `🥇${p.mvp1} 🥈${p.mvp2} 🥉${p.mvp3}`)}
        </div>
      </div>
    </div>
  `;
}

function renderAll(){
  // Recompute stats every time (fast enough for a friends app)
  state.stats = computeStats(state.data);

  const active = $(".tab.is-active")?.dataset?.view || "players";
  if (active === "players") renderPlayers();
  if (active === "newMatch") renderNewMatch();
  if (active === "matches") renderMatches();
  if (active === "leaderboard") renderLeaderboard();
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
    toast(msg + " ✅ (Sync OK)");
  }catch(err){
    console.error(err);
    saveLocal(state.data);
    toast(msg + " ⚠️ (Quedó en tu navegador; Sync falló)");
  }finally{
    overlay(false);
    state.stats = computeStats(state.data);
    renderAll();
  }
}

async function initialLoad(){
  overlay(true, "Cargando desde JSONBin…");
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
    renderAll();
  }
}

/* ============================
   SANITIZE + SECURITY (basic)
   ============================ */
function sanitizeData(d){
  const base = defaultData();
  if (!d || typeof d !== "object") return base;

  const out = {
    version: 1,
    players: Array.isArray(d.players) ? d.players.filter(p => p && p.id && p.name) : [],
    matches: Array.isArray(d.matches) ? d.matches.filter(m => m && m.id && m.date) : [],
    updatedAt: d.updatedAt || new Date().toISOString()
  };

  // ensure arrays
  for (const m of out.matches){
    m.teamA = Array.isArray(m.teamA) ? m.teamA : [];
    m.teamB = Array.isArray(m.teamB) ? m.teamB : [];
    m.goals = Array.isArray(m.goals) ? m.goals : [];
    m.mvp = Array.isArray(m.mvp) ? m.mvp : [null,null,null];

    // normalize goals
    m.goals = m.goals
      .map(g => ({
        scorerId: g?.scorerId || null,
        assistId: g?.assistId || null,
        at: g?.at || null
      }))
      .filter(g => !!g.scorerId);
  }

  return out;
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
   UI WIRING
   ============================ */
function wireUI(){
  $$(".tab[data-view]").forEach(btn => {
    btn.onclick = () => setView(btn.dataset.view);
  });

  $("#btnSync").onclick = async () => {
    try{
      overlay(true, "Sincronizando…");
      // push local to remote (source of truth: current state)
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
wireUI();
initialLoad();
