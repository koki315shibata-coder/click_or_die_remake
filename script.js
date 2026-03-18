import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { getDatabase, ref, set, get, update, remove, onValue } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBHXbceS4jq3XvnBHZL7VakG5C_-8lzpAo",
  authDomain: "click-or-die.firebaseapp.com",
  projectId: "click-or-die",
  storageBucket: "click-or-die.firebasestorage.app",
  messagingSenderId: "1083953408426",
  appId: "1:1083953408426:web:5c8ea29b0d51eda3ec63d3",
  measurementId: "G-CDBBH6W1T0",
  databaseURL: "https://click-or-die-default-rtdb.firebaseio.com"
};

// Global Modes & States
let isOnline = false;
let db = null;
let auth = null;
let authUser = null;
let roomCode = null;
let isHost = false;
let myPlayerRef = null;
let oppPlayerRef = null;
let roomRef = null;

let state = 'START'; // START, WAIT, FIRE, RESULT
let currentCommand = 'fire'; // fire, hold, double, ignore
let currentLevelIdx = 0;
let streak = 0;
let bestScore = localStorage.getItem('cod_best_score') || null;

let waitTimeout = null;
let fireTimeout = null;
let holdTimeout = null;
let doubleTimeout = null;
let autoNextTimeout = null;
let startTime = 0;

let queuedAttack = null;
let speedModifier = 1.0;
let speedModRounds = 0;

let doublePending = false;
let holdActive = false;

let globalSeed = Math.floor(Math.random() * 1000000);

// --- SEEDED RANDOM ---
function seededRandom() {
  let t = globalSeed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --- DOM ELEMENTS ---
const screens = {
  menu: document.getElementById('screen-menu'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game')
};

const UI = {
  gameArea: document.getElementById('game-area'),
  targetStatus: document.getElementById('target-status-text'),
  mainBtn: document.getElementById('main-btn'),
  statusPanel: document.getElementById('status-panel'),
  levelDisplay: document.getElementById('level-display'),
  threatDisplay: document.getElementById('threat-display'),
  bestScore: document.getElementById('best-score'),
  lastScore: document.getElementById('last-score'),
  streakCounter: document.getElementById('streak-counter'),
  resultDisplay: document.getElementById('result-display'),
  resultTime: document.getElementById('result-time'),
  resultRank: document.getElementById('result-rank'),
  flashOverlay: document.getElementById('flash-overlay'),
  diffContainer: document.getElementById('difficulty-selector-container'),
  diffBtns: document.querySelectorAll('.diff-btn'),
  clickLayer: document.getElementById('click-layer'),
  holdProgress: document.getElementById('hold-progress'),
  modeBadge: document.getElementById('mode-badge'),
  btnQuit: document.getElementById('btn-quit'),
  centerAlerts: document.getElementById('center-alert-container'),
  bestContainer: document.getElementById('best-stat-container')
};

// Online UI
const Lobby = {
  btnOffline: document.getElementById('btn-offline'),
  btnOnline: document.getElementById('btn-online'),
  btnCreate: document.getElementById('btn-create-room'),
  btnJoin: document.getElementById('btn-join-room'),
  roomInput: document.getElementById('room-code-input'),
  error: document.getElementById('lobby-error'),
  selection: document.getElementById('lobby-selection'),
  info: document.getElementById('room-info'),
  codeDisplay: document.getElementById('display-room-code'),
  p1Slot: document.getElementById('p1-slot'),
  p2Slot: document.getElementById('p2-slot'),
  btnReady: document.getElementById('btn-ready'),
  btnLeave: document.getElementById('btn-leave-lobby'),
  countdown: document.getElementById('countdown-text')
};

const OppUI = {
  container: document.getElementById('opp-stats'),
  streak: document.getElementById('opp-streak-counter'),
  state: document.getElementById('opp-state-text')
};

// --- AUDIO ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone(freq, type, duration, vol = 0.1) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

function playLockOn() { playTone(800, 'sine', 0.1, 0.05); }
function playFire() { playTone(200, 'square', 0.2, 0.2); playTone(150, 'sawtooth', 0.3, 0.2); }
function playSuccess() { playTone(600, 'sine', 0.1, 0.1); setTimeout(() => playTone(800, 'sine', 0.3, 0.1), 100); }
function playFail() { playTone(100, 'sawtooth', 0.5, 0.2); }
let beepInterval = null;

// --- NAVIGATION ---
function showScreen(id) {
  Object.values(screens).forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('active');
}

// --- FIREBASE INIT (Modular) ---
async function initFirebase() {
  if (!db) {
    try {
      const app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getDatabase(app);
      const cred = await signInAnonymously(auth);
      authUser = cred.user;
      return true;
    } catch (e) {
      console.error("Auth failed", e);
      alert("Database authentication failed. " + e.message);
      return false;
    }
  }
  return true;
}

// --- LOBBY LOGIC ---
function makeId(length) {
  let result = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

async function createRoom() {
  if (!(await initFirebase())) return;
  roomCode = makeId(4);
  isHost = true;

  roomRef = ref(db, 'rooms/' + roomCode);
  await set(roomRef, {
    host: authUser.uid,
    seed: Math.floor(Math.random() * 1000000),
    state: 'lobby'
  });

  myPlayerRef = ref(db, 'rooms/' + roomCode + '/players/' + authUser.uid);
  await set(myPlayerRef, { ready: false, streak: 0, alive: true });

  setupRoomListeners();
  showLobbyInfo();
}

async function joinRoom(code) {
  if (!(await initFirebase())) return;
  roomCode = code.toUpperCase();
  isHost = false;

  roomRef = ref(db, 'rooms/' + roomCode);
  const snap = await get(roomRef);
  if (!snap.exists()) {
    Lobby.error.innerText = "Room not found.";
    Lobby.error.classList.remove('hidden');
    return;
  }

  myPlayerRef = ref(db, 'rooms/' + roomCode + '/players/' + authUser.uid);
  await set(myPlayerRef, { ready: false, streak: 0, alive: true });

  setupRoomListeners();
  showLobbyInfo();
}

function showLobbyInfo() {
  Lobby.selection.classList.add('hidden');
  Lobby.info.classList.remove('hidden');
  Lobby.codeDisplay.innerText = roomCode;
}

function setupRoomListeners() {
  onValue(roomRef, snap => {
    const data = snap.val();
    if (!data) return; // Room closed

    globalSeed = data.seed;

    if (data.players) {
      const players = Object.keys(data.players);
      const myData = data.players[authUser.uid];
      const oppId = players.find(id => id !== authUser.uid);
      const oppData = oppId ? data.players[oppId] : null;

      Lobby.p1Slot.innerHTML = `you: <span class="status ${myData?.ready ? 'ready' : ''}">${myData?.ready ? 'READY' : 'WAITING...'}</span>`;

      if (oppData) {
        Lobby.p2Slot.innerHTML = `opponent: <span class="status ${oppData.ready ? 'ready' : ''}">${oppData.ready ? 'READY' : 'WAITING...'}</span>`;
        OppUI.streak.innerText = oppData.streak || 0;
        OppUI.state.innerText = oppData.alive ? 'alive' : 'dead';
        OppUI.state.style.color = oppData.alive ? 'var(--text-muted)' : 'var(--red)';

        // Handle multiplayer progression events
        if (data.state === 'playing') {
          if (!oppData.alive && myData.alive && state !== 'RESULT') {
            // opponent died, you're still alive
            triggerCenterAlert("opponent died!");
          }
        }
      } else {
        Lobby.p2Slot.innerHTML = `opponent: <span class="status">waiting for join...</span>`;
      }

      if (players.length === 2 && !Lobby.btnReady.classList.contains('hidden') === false && data.state === 'lobby') {
        Lobby.btnReady.classList.remove('hidden');
      }

      if (data.state === 'starting' && state !== 'WAIT' && state !== 'FIRE') {
        startCountdown(data.countdownEnd);
      }
    }

    // Attack Queueing logic
    if (data.attackTarget === authUser.uid && data.attackId) {
      handleReceivedAttack(data.attackType, data.attackId);
    }
  });
}

let lastAttackId = null;
function handleReceivedAttack(type, attackId) {
  if (attackId === lastAttackId) return;
  lastAttackId = attackId;

  triggerCenterAlert(`attacked: ${type}!`);
  if (type === 'fake') queuedAttack = 'ignore';
  if (type === 'shake') {
    document.body.classList.add('screen-shake-small');
    setTimeout(() => document.body.classList.remove('screen-shake-small'), 200);
  }
  if (type === 'speed') {
    speedModifier = 0.75;
    speedModRounds = 2;
  }
}

async function sendAttack(type) {
  if (!roomRef) return;
  const oppId = Object.keys((await get(ref(db, 'rooms/' + roomCode + '/players'))).val()).find(id => id !== authUser.uid);
  update(roomRef, {
    attackTarget: oppId || 'all',
    attackType: type,
    attackId: Date.now()
  });
}

function startCountdown(endTime) {
  Lobby.btnReady.classList.add('hidden');
  Lobby.countdown.classList.remove('hidden');

  const iv = setInterval(() => {
    const left = Math.ceil((endTime - Date.now()) / 1000);
    if (left > 0) {
      Lobby.countdown.innerText = left;
    } else {
      clearInterval(iv);
      enterGameMode(true);
    }
  }, 100);
}

// --- MAIN GAME LOGIC ---
function getLevelParams(idx) {
  const baseLevels = [
    { name: 'recruit', window: 1200, threat: 'too easy' },
    { name: 'soldier', window: 1000, threat: 'mild' },
    { name: 'veteran', window: 800, threat: 'getting warm' },
    { name: 'elite', window: 650, threat: 'intense' },
    { name: 'omega', window: 500, threat: 'lethal' }
  ];

  let actualLevel = idx + 1;
  let params = { level: actualLevel };

  if (idx < 5) {
    params.name = baseLevels[idx].name;
    params.window = baseLevels[idx].window;
    params.threat = baseLevels[idx].threat;
    params.pulseDur = 0.8 - (idx * 0.1);
  } else {
    let diff = idx - 4;
    let pluses = '+'.repeat(Math.min(diff, 3));
    params.name = 'omega' + pluses;
    params.window = Math.max(180, 500 - (diff * 25));

    if (actualLevel < 10) params.threat = 'lethal';
    else if (actualLevel < 15) params.threat = 'terminal';
    else params.threat = 'god-tier';

    params.pulseDur = Math.max(0.1, 0.4 - (diff * 0.03));
  }

  // Apply speed pressure if active
  if (speedModRounds > 0) {
    params.window *= speedModifier;
    params.threat += ' (sped up!)';
  }

  return params;
}

function getCommand(actualLevel) {
  let rand = isOnline ? seededRandom() : Math.random();

  // Online attacks force command
  if (queuedAttack) {
    let cmd = queuedAttack;
    queuedAttack = null;
    return cmd;
  }

  if (actualLevel < 3) return 'fire';
  if (actualLevel < 6) {
    if (rand < 0.15) return 'ignore';
    if (rand < 0.3) return 'hold';
    return 'fire';
  }
  // Deep endless mode
  if (rand < 0.20) return 'ignore';
  if (rand < 0.35) return 'double';
  if (rand < 0.50) return 'hold';
  return 'fire';
}

function resetUI() {
  UI.resultDisplay.classList.add('hidden');
  document.body.classList.remove('screen-shake');
  UI.flashOverlay.className = '';
  void UI.flashOverlay.offsetWidth;
  UI.holdProgress.style.width = '0';
  UI.holdProgress.style.height = '0';
}

function updateFirebaseState(alive) {
  if (isOnline && myPlayerRef) {
    update(myPlayerRef, { alive, streak: streak });
  }
}

function triggerCenterAlert(text) {
  const el = document.createElement('div');
  el.className = 'attack-alert';
  el.innerText = text;
  UI.centerAlerts.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function startGame() {
  if (autoNextTimeout) clearTimeout(autoNextTimeout);
  if (beepInterval) clearInterval(beepInterval);
  resetUI();

  holdActive = false;
  doublePending = false;
  currentCommand = getCommand(currentLevelIdx + 1);
  updateFirebaseState(true);

  state = 'WAIT';
  UI.gameArea.className = 'state-wait';
  UI.targetStatus.innerText = 'waiting...';

  UI.statusPanel.innerText = 'wait for it';
  UI.statusPanel.style.color = 'var(--text-muted)';

  UI.mainBtn.style.opacity = '0';
  UI.mainBtn.style.pointerEvents = 'none';

  const lvlParams = getLevelParams(currentLevelIdx);
  UI.diffContainer.style.opacity = '0.2';
  UI.diffContainer.style.pointerEvents = 'none';

  document.documentElement.style.setProperty('--pulse-dur', `${lvlParams.pulseDur}s`);

  let rng = isOnline ? seededRandom() : Math.random();
  const minDelay = Math.max(600, 1500 - (currentLevelIdx * 50));
  const maxDelay = Math.min(5000, 3500 + (currentLevelIdx * 100));
  const delay = rng * (maxDelay - minDelay) + minDelay;

  beepInterval = setInterval(playLockOn, 500);

  waitTimeout = setTimeout(() => {
    clearInterval(beepInterval);
    firePhase();
  }, delay);
}

function firePhase() {
  state = 'FIRE';
  UI.gameArea.className = `state-${currentCommand === 'ignore' ? 'ignore' : currentCommand === 'hold' ? 'hold' : currentCommand === 'double' ? 'double' : 'fire'}`;

  UI.statusPanel.style.color = currentCommand === 'ignore' ? 'var(--text-muted)' : 'var(--green)';

  if (currentCommand === 'fire') {
    UI.targetStatus.innerText = 'click!';
    UI.statusPanel.innerText = 'now!';
    flashScreen('white'); playFire();
  } else if (currentCommand === 'hold') {
    UI.targetStatus.innerText = 'hold...';
    UI.statusPanel.innerText = 'hold down';
    flashScreen('white'); playFire();
  } else if (currentCommand === 'double') {
    UI.targetStatus.innerText = 'double!';
    UI.statusPanel.innerText = 'click twice';
    flashScreen('white'); playFire();
  } else if (currentCommand === 'ignore') {
    UI.targetStatus.innerText = 'ignore.';
    UI.statusPanel.innerText = 'don\'t touch';
    // Subtle cue
  }

  startTime = performance.now();
  const currentLevel = getLevelParams(currentLevelIdx);

  if (currentCommand === 'ignore') {
    fireTimeout = setTimeout(() => {
      successGame(); // successfully ignored
    }, 1000); // 1 second window to not mess up
  } else {
    let win = currentLevel.window;
    if (currentCommand === 'double') win += 200; // a bit more time for 2 clicks
    if (currentCommand === 'hold') win += 500; // must hold for 400ms at least, give buffer

    fireTimeout = setTimeout(() => {
      failGame('too slow.');
    }, win);
  }
}

function successGame() {
  const rt = Math.floor(performance.now() - startTime);
  clearTimeout(fireTimeout);
  if (holdTimeout) clearTimeout(holdTimeout);
  holdActive = false; doublePending = false;

  state = 'RESULT';
  UI.gameArea.className = 'state-success';
  UI.targetStatus.innerText = 'nice.';

  UI.statusPanel.innerText = 'survived.';
  UI.statusPanel.style.color = 'var(--text-muted)';

  playSuccess();
  streak++;
  if (speedModRounds > 0) speedModRounds--;

  // Online Attacks
  if (isOnline) {
    if (streak === 3) sendAttack('fake');
    else if (streak === 5) sendAttack('shake');
    else if (streak === 8) sendAttack('speed');
  }

  if (streak % 1 === 0) currentLevelIdx++;
  updateFirebaseState(true);

  updateSelectorUI();
  updateBestScore(rt);
  UI.lastScore.innerText = currentCommand === 'ignore' ? 'pass' : rt + 'ms';

  showResult(rt, currentCommand === 'ignore' ? 'passed' : null);
  updateSidebar();

  autoNextTimeout = setTimeout(() => {
    if (state === 'RESULT') startGame();
  }, 1200);
}

function failGame(reason) {
  clearTimeout(waitTimeout);
  clearTimeout(fireTimeout);
  clearTimeout(holdTimeout);
  clearTimeout(doubleTimeout);
  if (beepInterval) clearInterval(beepInterval);
  holdActive = false; doublePending = false;
  UI.holdProgress.style.width = '0'; UI.holdProgress.style.height = '0';

  UI.diffContainer.style.opacity = '1';
  UI.diffContainer.style.pointerEvents = 'auto';

  state = 'RESULT';
  UI.gameArea.className = 'state-start';
  document.body.classList.add('screen-shake');

  flashScreen('red');
  playFail();

  UI.targetStatus.innerText = 'you died.';
  UI.statusPanel.innerText = reason;
  UI.statusPanel.style.color = 'var(--red)';

  UI.resultTime.innerText = 'X';
  UI.resultTime.style.color = 'var(--red)';
  UI.resultRank.innerText = reason;
  UI.resultRank.className = 'rank-slow';

  UI.resultDisplay.classList.remove('hidden');

  streak = 0;
  speedModRounds = 0;
  speedModifier = 1.0;
  const activeBtn = Array.from(UI.diffBtns).find(b => b.classList.contains('active'));
  currentLevelIdx = activeBtn ? parseInt(activeBtn.dataset.level) - 1 : 0;

  updateFirebaseState(false);
  updateSelectorUI();
  updateSidebar();

  UI.mainBtn.style.opacity = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = isOnline ? 'wait for next' : 'try again';

  // In online mode, we just stay dead and watch opponent's streak update, or leave room
}

function showResult(rt, overrideRank) {
  if (overrideRank) {
    UI.resultTime.innerText = overrideRank;
    UI.resultRank.innerText = '';
  } else {
    UI.resultTime.innerText = rt + 'ms';
    UI.resultTime.style.color = 'var(--text-main)';

    let rank = ''; let rankClass = '';
    if (rt < 150) { rank = 'godlike'; rankClass = 'rank-godlike'; }
    else if (rt < 200) { rank = 'elite'; rankClass = 'rank-elite'; }
    else if (rt < 250) { rank = 'sharp'; rankClass = 'rank-sharp'; }
    else { rank = 'slow'; rankClass = 'rank-slow'; }

    UI.resultRank.innerText = rank;
    UI.resultRank.className = rankClass;
  }
  UI.resultDisplay.classList.remove('hidden');
}

function flashScreen(color) {
  UI.flashOverlay.className = '';
  void UI.flashOverlay.offsetWidth;
  UI.flashOverlay.className = color === 'white' ? 'flash-white' : 'flash-red';
}

function updateBestScore(rt) {
  // don't track ignore rounds for best time
  if (currentCommand === 'ignore') return;
  if (!bestScore || rt < bestScore) {
    bestScore = rt;
    localStorage.setItem('cod_best_score', bestScore);
  }
}

function updateSidebar() {
  const lvlParams = getLevelParams(currentLevelIdx);
  UI.levelDisplay.innerText = `level ${lvlParams.level} // ${lvlParams.name}`;
  UI.threatDisplay.innerText = lvlParams.threat;

  if (bestScore) UI.bestScore.innerText = bestScore + 'ms';
  UI.streakCounter.innerText = streak;
}

function updateSelectorUI() {
  UI.diffBtns.forEach(btn => btn.classList.remove('active'));
  if (currentLevelIdx < 5) {
    const activeBtn = Array.from(UI.diffBtns).find(b => parseInt(b.dataset.level) === (currentLevelIdx + 1));
    if (activeBtn) activeBtn.classList.add('active');
  }
}

function enterGameMode(online) {
  isOnline = online;
  showScreen('screen-game');
  UI.modeBadge.innerText = isOnline ? 'online versus' : 'offline mode';

  if (isOnline) {
    document.getElementById('opp-stats').classList.remove('hidden');
    UI.bestContainer.classList.add('hidden'); // Hide best score in online
    UI.diffContainer.classList.add('hidden'); // No difficulty selector in online, synced by seed
    currentLevelIdx = 0; // Online always starts at level 1 for fairness
    UI.btnQuit.classList.remove('hidden');
    UI.mainBtn.classList.add('hidden'); // Started automatically
    startGame();
  } else {
    document.getElementById('opp-stats').classList.add('hidden');
    UI.bestContainer.classList.remove('hidden');
    UI.diffContainer.classList.remove('hidden');
    UI.btnQuit.classList.remove('hidden');
    UI.mainBtn.classList.remove('hidden');
    state = 'START';
    resetUI();
    updateSidebar();
  }
}

// --- INPUT EVENT LOGIC ---

function handleInputDown() {
  initAudio();
  if (state === 'START' || state === 'RESULT') {
    if (!isOnline) startGame();
  } else if (state === 'WAIT') {
    failGame('too early.');
  } else if (state === 'FIRE') {
    if (currentCommand === 'ignore') {
      failGame('bamboozled.');
    } else if (currentCommand === 'fire') {
      successGame();
    } else if (currentCommand === 'double') {
      if (!doublePending) {
        doublePending = true;
        clearTimeout(fireTimeout); // clear original timeout
        doubleTimeout = setTimeout(() => failGame('too slow.'), 350); // tight double click window
      } else {
        clearTimeout(doubleTimeout);
        successGame();
      }
    } else if (currentCommand === 'hold') {
      holdActive = true;
      UI.holdProgress.style.width = '150px';
      UI.holdProgress.style.height = '150px';
      // Ensure they hold for 400ms
      holdTimeout = setTimeout(() => {
        if (holdActive) successGame();
      }, 400);
    }
  }
}

function handleInputUp() {
  if (state === 'FIRE' && currentCommand === 'hold' && holdActive) {
    holdActive = false;
    UI.holdProgress.style.width = '0';
    UI.holdProgress.style.height = '0';
    clearTimeout(holdTimeout);
    // if they lift mouse before 400ms is up via successGame triggering
    if (state !== 'RESULT') {
      failGame('held too short.');
    }
  }
}

// --- LISTENERS END SETUP ---

UI.clickLayer.addEventListener('mousedown', handleInputDown);
UI.clickLayer.addEventListener('touchstart', (e) => { e.preventDefault(); handleInputDown(); }, { passive: false });

document.addEventListener('mouseup', handleInputUp);
document.addEventListener('touchend', handleInputUp);

UI.mainBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); handleInputDown(); });
UI.mainBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); e.preventDefault(); handleInputDown(); });

UI.diffBtns.forEach(btn => {
  const handler = (e) => {
    e.stopPropagation();
    if (state !== 'START' && state !== 'RESULT') return;
    currentLevelIdx = parseInt(e.target.dataset.level) - 1;
    streak = 0; updateSelectorUI(); updateSidebar();
    if (state === 'RESULT') {
      UI.gameArea.className = 'state-start';
      UI.targetStatus.innerText = 'one miss and it ends.';
      UI.resultDisplay.classList.add('hidden');
      UI.mainBtn.innerText = 'play';
      UI.statusPanel.innerText = 'ready.';
      UI.statusPanel.style.color = 'var(--text-muted)';
      state = 'START';
    }
  };
  btn.addEventListener('mousedown', handler); btn.addEventListener('touchstart', handler);
});

// Menu Listeners
Lobby.btnOffline.addEventListener('click', () => enterGameMode(false));
Lobby.btnOnline.addEventListener('click', () => showScreen('screen-lobby'));

Lobby.btnCreate.addEventListener('click', createRoom);
Lobby.btnJoin.addEventListener('click', () => {
  const code = Lobby.roomInput.value.trim();
  if (code.length === 4) joinRoom(code);
});

Lobby.btnReady.addEventListener('click', async () => {
  if (myPlayerRef) await update(myPlayerRef, { ready: true });
  if (isHost && roomRef) {
    const snap = await get(roomRef);
    const players = snap.val().players;
    const allReady = Object.values(players).every(p => p.ready);
    if (Object.keys(players).length === 2 && allReady) {
      update(roomRef, {
        state: 'starting',
        countdownEnd: Date.now() + 3000
      });
    }
  }
});

Lobby.btnLeave.addEventListener('click', async () => {
  if (myPlayerRef) await remove(myPlayerRef);
  showScreen('screen-menu');
});

UI.btnQuit.addEventListener('click', async () => {
  if (myPlayerRef) await remove(myPlayerRef);
  clearTimeout(autoNextTimeout);
  clearTimeout(waitTimeout);
  clearTimeout(fireTimeout);
  showScreen('screen-menu');
});

// INITIALIZE
updateSidebar();
