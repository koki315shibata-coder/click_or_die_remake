import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { getDatabase, ref, set, get, update, remove, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-database.js";

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

// =============================================
// GLOBAL STATE
// =============================================
let isOnline = false;
let db = null;
let auth = null;
let authUser = null;
let roomCode = null;
let isHost = false;
let myPlayerRef = null;
let roomRef = null;

let state = 'START'; // START, COUNTDOWN, WAIT, FIRE, RESULT
let currentLevelIdx = 0;
let streak = 0;
let score = 0;
let bestScoreAmt = parseInt(localStorage.getItem('cod_best_score_amt')) || 0;
let hasShield = false;
let targetFireTime = 0;
let activeTarget = { id: null, spawnedAt: 0, allowedTime: 0, resolved: true };
let resultStartTime = 0;
let feedbackTimeout = null;

let waitTimeout = null;
let fireTimeout = null;
let holdTimeout = null;
let doubleTimeout = null;
let autoNextTimeout = null;
let beepInterval = null;
let startTime = 0;

// Speed modifier (used by TIMESHIFT hack)
let speedModifier = 1.0;
let speedModRounds = 0;

// Seeded random for fair sync
let globalSeed = Math.floor(Math.random() * 1000000);

// --- Hack / ZEN system ---
let equippedHack = 'overload';
let perfectStreak = 0;
let zenNoteIndex  = 0;  // counts up each ZEN hit for rising scale
let isZenMode = false;
let hackFiredThisZen = false; // prevent double-fire

// --- BO5 Match Format ---
let myRoundsWon = 0;
let oppRoundsWon = 0;
const ROUNDS_TO_WIN = 3;
let interRoundTimer = null;
let matchOver = false;
let currentOnlineRound = 1;    // incremented each round
let roundResultHandled = false; // prevents double-processing

// --- Incoming hack state (applied next round) ---
let pendingOverload = 0;      // extra decoy count
let pendingTimeshift = false; // window shrunken
let pendingMimic = false;     // colors flipped
let parryWindowActive = false;// firewall opportunity

// --- Ping ---
let pingInterval = null;
let lastPingSent = 0;

// =============================================
// SEEDED RANDOM
// =============================================
function seededRandom() {
  let t = globalSeed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// =============================================
// DOM ELEMENTS
// =============================================
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
  scoreCounter: document.getElementById('score-counter'),
  streakCounter: document.getElementById('streak-counter'),
  modeBadge: document.getElementById('mode-badge'),
  resultDisplay: document.getElementById('result-display'),
  resultTime: document.getElementById('result-time'),
  resultRank: document.getElementById('result-rank'),
  // diffBtns and diffContainer removed (buttons deleted from HTML)
  bestContainer: document.getElementById('best-stat-container'),
  flashOverlay: document.getElementById('flash-overlay'),
  clickLayer: document.getElementById('click-layer'),
  btnQuit: document.getElementById('btn-quit'),
  centerAlerts: document.getElementById('center-alert-container'),
  gameOverScreen: document.getElementById('game-over-screen'),
  gameOverScore: document.getElementById('go-score'),
  pingDisplay: document.getElementById('ping-display'),
  zenChargeDisplay: document.getElementById('zen-charge-display'),
  zenPips: document.getElementById('zen-pips'),
  roundScoreboard: document.getElementById('round-scoreboard'),
  myRoundPips: document.getElementById('my-round-pips'),
  oppRoundPips: document.getElementById('opp-round-pips'),
  interRoundOverlay: document.getElementById('inter-round-overlay'),
  interRoundResult: document.getElementById('inter-round-result'),
  interRoundScore: document.getElementById('inter-round-score'),
  interRoundTimer: document.getElementById('inter-round-timer')
};

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
  btnStart: document.getElementById('btn-start-game'),
  hostMessage: document.getElementById('host-message'),
  btnLeave: document.getElementById('btn-leave-lobby'),
  countdown: document.getElementById('countdown-text'),
  hackOptions: document.querySelectorAll('.hack-option'),
  interHackOptions: document.querySelectorAll('.inter-hack-option')
};

const OppUI = {
  container: document.getElementById('opp-stats'),
  streak: document.getElementById('opp-streak-counter'),
  state: document.getElementById('opp-state-text')
};


// =============================================
// AUDIO
// =============================================
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// Core tone builder with pitch glide support
function playTone(freq, type, duration, vol = 0.1, endFreq = null) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (endFreq) osc.frequency.linearRampToValueAtTime(endFreq, audioCtx.currentTime + duration);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration + 0.01);
}

// Low-pass filtered noise for impact sounds
function playNoise(duration, vol = 0.05, cutoff = 400) {
  if (!audioCtx) return;
  const bufLen = audioCtx.sampleRate * duration;
  const buf    = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const src    = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const gain   = audioCtx.createGain();
  src.buffer   = buf;
  filter.type  = 'lowpass';
  filter.frequency.value = cutoff;
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  src.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
  src.start(); src.stop(audioCtx.currentTime + duration + 0.01);
}

// --- TARGETING SOUNDS ---
function playLockOn() {
  playTone(440, 'sine', 0.08, 0.04);
  setTimeout(() => playTone(660, 'sine', 0.06, 0.04), 70);
}

// Fire prompt (the "NOW!" flash)
function playFire() {
  playNoise(0.04, 0.08, 800);
  playTone(180, 'square', 0.08, 0.12, 120);
}

// --- PERFECT HIT SOUNDS (the most important) ---
function playPerfectHit(streakCount, inZen) {
  if (!audioCtx) return;
  // Rising base pitch with streak multiplier
  const base = 660 + Math.min(streakCount * 25, 600);

  if (inZen) {
    // ZEN: rising pentatonic scale — each hit plays the next note up
    // C  D  E  G  A  C  D  E  G  A  C  ...   (looping)
    const ZEN_SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568, 1760, 2093];
    const noteIdx = zenNoteIndex % ZEN_SCALE.length;
    const note    = ZEN_SCALE[noteIdx];
    const noteUp  = ZEN_SCALE[Math.min(noteIdx + 1, ZEN_SCALE.length - 1)];

    // Root note (strong)
    playTone(note,       'sine', 0.30, 0.22);
    // Perfect 5th harmony (lighter, sustains longer)
    playTone(note * 1.5, 'sine', 0.20, 0.16);
    // Brief shimmer at next scale note
    setTimeout(() => playTone(noteUp, 'sine', 0.18, 0.14), 55);
    // Sparkle noise
    setTimeout(() => playNoise(0.06, 0.04, 2200), 15);
  } else {
    // PERFECT: crisp ping with shimmer
    playTone(base,        'sine', 0.18, 0.18);
    playTone(base * 1.5,  'sine', 0.12, 0.10);
    setTimeout(() => playTone(base * 2.0, 'sine', 0.10, 0.07), 60);
    playNoise(0.03, 0.035, 3000);
  }
}

// Regular (non-perfect) hit — quieter, no shimmer
function playSuccess() {
  if (!audioCtx) return;
  playTone(520, 'sine', 0.12, 0.10);
  setTimeout(() => playTone(660, 'sine', 0.10, 0.08), 80);
}

// --- FAIL ---
function playFail() {
  playTone(120, 'sawtooth', 0.35, 0.18, 80);
  playNoise(0.15, 0.06, 250);
}

// --- ONLINE ROUND SOUNDS ---
function playRoundWin() {
  // Ascending arpeggio — victory feel
  const notes = [523, 659, 784, 1047]; // C E G C
  notes.forEach((n, i) => setTimeout(() => playTone(n, 'sine', 0.25, 0.18), i * 100));
  setTimeout(() => playNoise(0.08, 0.03, 1500), 380);
}
function playRoundLose() {
  // Descending minor fall
  playTone(300, 'sawtooth', 0.28, 0.18, 180);
  setTimeout(() => playTone(200, 'sine', 0.5, 0.15, 120), 180);
  playNoise(0.12, 0.05, 200);
}

// --- HACK SOUNDS ---
function playHackLaunch() {
  // Rising data-burst whoosh
  playTone(400, 'square', 0.05, 0.12, 1600);
  setTimeout(() => playTone(800, 'sawtooth', 0.12, 0.18, 200), 60);
  setTimeout(() => playNoise(0.08, 0.06, 2000), 80);
}
function playIntrusion() {
  // Glitchy alarm — attention-grabbing but not ear-splitting
  playTone(280, 'square', 0.12, 0.20);
  setTimeout(() => playTone(350, 'square', 0.10, 0.18), 100);
  setTimeout(() => playTone(280, 'square', 0.10, 0.16), 200);
  playNoise(0.08, 0.04, 400);
}
function playFirewall() {
  // Shield ping — satisfying block sound
  playTone(1200, 'sine', 0.08, 0.18);
  setTimeout(() => playTone(900,  'sine', 0.10, 0.14), 80);
  setTimeout(() => playTone(1500, 'sine', 0.06, 0.12), 160);
  playNoise(0.05, 0.04, 1800);
}

// =============================================
// NAVIGATION
// =============================================
function showScreen(id) {
  Object.values(screens).forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('active');
}

// =============================================
// FIREBASE INIT
// =============================================
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

// =============================================
// LOBBY LOGIC
// =============================================
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
  await set(myPlayerRef, { ready: false, streak: 0, alive: true, roundsWon: 0 });

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

  const roomData = snap.val();
  // Reject rooms that are in-progress or have stale state
  if (roomData.state === 'playing') {
    Lobby.error.innerText = "Game already in progress.";
    Lobby.error.classList.remove('hidden');
    roomCode = null; roomRef = null;
    return;
  }
  // Reset any stale starting-state from a crashed previous session
  if (roomData.state === 'starting' || roomData.gameStarted) {
    await update(roomRef, { state: 'lobby', gameStarted: false });
  }

  myPlayerRef = ref(db, 'rooms/' + roomCode + '/players/' + authUser.uid);
  await set(myPlayerRef, { ready: false, streak: 0, alive: true, roundsWon: 0 });

  setupRoomListeners();
  showLobbyInfo();
}

function showLobbyInfo() {
  Lobby.selection.classList.add('hidden');
  Lobby.info.classList.remove('hidden');
  Lobby.codeDisplay.innerText = roomCode;
  Lobby.btnStart.classList.add('hidden');
  Lobby.btnStart.disabled = false;
  Lobby.hostMessage.classList.add('hidden');
  Lobby.countdown.classList.add('hidden');
}

function setupRoomListeners() {
  onValue(roomRef, snap => {
    const data = snap.val();
    if (!data) return;

    if (data.players) {
      const players = Object.keys(data.players);
      const myData = data.players[authUser.uid] || {};
      const oppId = players.find(id => id !== authUser.uid);
      const oppData = oppId ? data.players[oppId] : null;

      Lobby.p1Slot.innerHTML = `you: <span class="status ${myData.ready ? 'ready' : ''}">${myData.ready ? 'READY' : 'WAITING...'}</span>`;

      if (oppData) {
        Lobby.p2Slot.innerHTML = `opponent: <span class="status ${oppData.ready ? 'ready' : ''}">${oppData.ready ? 'READY' : 'WAITING...'}</span>`;
        OppUI.streak.innerText = oppData.streak || 0;
        OppUI.state.innerText = oppData.alive ? 'alive' : 'dead';
        OppUI.state.style.color = oppData.alive ? 'var(--text-muted)' : 'var(--red)';

        // Sync opponent round wins
        const oppWins = oppData.roundsWon || 0;
        if (oppWins !== oppRoundsWon) {
          oppRoundsWon = oppWins;
          updateRoundPips();
        }

        // Round result is now handled via data.roundResult (see below)
      } else {
        Lobby.p2Slot.innerHTML = `opponent: <span class="status">waiting for join...</span>`;
      }

      if (data.state === 'lobby') {
        const allReady = players.length === 2 && Object.values(data.players).every(p => p.ready);

        if (players.length === 2 && !myData.ready) {
          Lobby.btnReady.classList.remove('hidden');
        } else {
          Lobby.btnReady.classList.add('hidden');
        }

        // Host privilege
        if (data.host === authUser.uid) {
          isHost = true;
        } else if (players.length > 0 && !players.includes(data.host)) {
          if (players[0] === authUser.uid) {
            isHost = true;
            update(roomRef, { host: authUser.uid });
          } else {
            isHost = false;
          }
        } else {
          isHost = false;
        }

        if (players.length < 2) {
          Lobby.hostMessage.innerText = 'waiting for second player...';
          Lobby.hostMessage.classList.remove('hidden');
          Lobby.btnStart.classList.add('hidden');
        } else if (!allReady) {
          Lobby.hostMessage.innerText = 'waiting for players to ready up...';
          Lobby.hostMessage.classList.remove('hidden');
          Lobby.btnStart.classList.add('hidden');
        } else if (allReady) {
          if (isHost) {
            Lobby.hostMessage.innerText = 'both players ready. press start game.';
            Lobby.hostMessage.classList.remove('hidden');
            Lobby.btnStart.classList.remove('hidden');
            Lobby.btnStart.disabled = false;
          } else {
            Lobby.hostMessage.innerText = 'waiting for host to start the game.';
            Lobby.hostMessage.classList.remove('hidden');
            Lobby.btnStart.classList.add('hidden');
          }
        }
      }
    }

    // --- Round result detection (single source of truth for round outcomes) ---
    if (data.roundResult && data.roundResult.round === currentOnlineRound && !roundResultHandled) {
      handleRoundResult(data.roundResult);
    }

    // --- Game start detection ---
    const playerCount = data.players ? Object.keys(data.players).length : 0;
    const isStarting = data.state === 'starting' && playerCount >= 2 && !!data.countdownEnd;
    const safeToStart = state === 'START';
    if (isStarting && safeToStart) {
      Lobby.hostMessage.classList.add('hidden');
      Lobby.btnStart.classList.add('hidden');
      if (Lobby.countdown.classList.contains('hidden')) {
        startCountdown(data.countdownEnd);
      }
    }

    // Incoming hack
    if (data.hackTarget === authUser.uid && data.hackId) {
      handleReceivedHack(data.hackType, data.hackId);
    }

    // Ping response
    if (data.pingResponse && data.pingResponse.target === authUser.uid) {
      const ping = Date.now() - data.pingResponse.sentAt;
      UI.pingDisplay.innerText = `[ Ping: ${ping}ms ]`;
      // Color based on quality
      if (ping < 80) UI.pingDisplay.style.color = 'var(--green)';
      else if (ping < 150) UI.pingDisplay.style.color = '#fecd1a';
      else UI.pingDisplay.style.color = 'var(--red)';
    }
  });
}


// =============================================
// HACK SEND / RECEIVE
// =============================================
let lastHackId = null;

async function sendHack(type) {
  if (!roomRef || !db) return;
  const playersSnap = await get(ref(db, 'rooms/' + roomCode + '/players'));
  if (!playersSnap.exists()) return;
  const oppId = Object.keys(playersSnap.val()).find(id => id !== authUser.uid);
  if (!oppId) return;
  update(roomRef, {
    hackTarget: oppId,
    hackType: type,
    hackId: Date.now() + '_' + Math.random()
  });
}

function handleReceivedHack(type, hackId) {
  if (!hackId || hackId === lastHackId) return;
  lastHackId = hackId;

  // Firewall (parry) opportunity
  parryWindowActive = true;
  pendingParryHackType = type;

  playIntrusion();
  
  // Severe visual impact for receiving a hack
  flashScreen('hack'); // magenta
  document.body.classList.add('screen-shake-intense');
  setTimeout(() => document.body.classList.remove('screen-shake-intense'), 400);

  // Show named intrusion alert
  const hackNames = { overload: 'OVERLOAD: +FAKES NEXT ROUND',
                      timeshift: 'TIMESHIFT: TIME REDUCED',
                      mimic: 'MIMIC: COLORS FLIPPED' };
  const msg = hackNames[type] || type.toUpperCase();
  triggerAlert('⚠ INTRUSION: ' + msg, 'firewall-alert hack-glitch-text');

  // Queue the hack for next round
  if (type === 'overload') {
    pendingOverload = Math.floor(Math.random() * 11) + 10; // 10-20 fakes
  } else if (type === 'timeshift') {
    pendingTimeshift = true;
  } else if (type === 'mimic') {
    pendingMimic = true;
  }
}

let pendingParryHackType = null;

function attemptParry() {
  if (!parryWindowActive) return false;
  parryWindowActive = false;
  pendingParryHackType = null;

  // Clear the pending hack
  pendingOverload = 0;
  pendingTimeshift = false;
  pendingMimic = false;

  playFirewall();
  flashScreen('white');
  triggerAlert('⚡ FIREWALL ACTIVATED', 'firewall-success-alert');
  return true;
}

function triggerAlert(text, cssClass) {
  const el = document.createElement('div');
  el.className = 'attack-alert ' + (cssClass || '');
  el.innerText = text;
  UI.centerAlerts.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Legacy alias
function triggerCenterAlert(text) { triggerAlert(text, ''); }

function showHackExecutedBanner(hackName) {
  const el = document.createElement('div');
  el.className = 'hack-executed-banner';
  el.innerText = `EXECUTED: ${hackName.toUpperCase()}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// =============================================
// PING
// =============================================
async function measurePing() {
  if (!roomRef || !authUser) return;
  lastPingSent = Date.now();
  update(roomRef, { pingRequest: { from: authUser.uid, sentAt: lastPingSent } });
}

function startPingLoop() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(measurePing, 5000);
  measurePing();
}

function stopPingLoop() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = null;
}

// Listen for ping requests from opponent and respond
function setupPingResponder() {
  if (!roomRef) return;
  onValue(ref(db, 'rooms/' + roomCode + '/pingRequest'), snap => {
    const data = snap.val();
    if (!data) return;
    if (data.from !== authUser.uid) {
      // Respond
      update(roomRef, { pingResponse: { target: data.from, sentAt: data.sentAt } });
    }
  });
}

// =============================================
// BO5 ROUND MANAGEMENT
// =============================================
function updateRoundPips() {
  // My pips
  UI.myRoundPips.innerHTML = '';
  for (let i = 0; i < ROUNDS_TO_WIN; i++) {
    const pip = document.createElement('div');
    pip.className = 'round-pip' + (i < myRoundsWon ? ' won' : '');
    UI.myRoundPips.appendChild(pip);
  }
  // Opp pips
  UI.oppRoundPips.innerHTML = '';
  for (let i = 0; i < ROUNDS_TO_WIN; i++) {
    const pip = document.createElement('div');
    pip.className = 'round-pip' + (i < oppRoundsWon ? ' won' : '');
    UI.oppRoundPips.appendChild(pip);
  }
}

function handleRoundResult(result) {
  if (roundResultHandled) return;
  roundResultHandled = true;
  const iLost = result.loser === authUser.uid;
  if (iLost) {
    handleRoundLoss(result.reason || 'you died.');
  } else {
    handleRoundWin('opponent eliminated.');
  }
}

function handleRoundWin(reason) {
  if (matchOver) return;
  myRoundsWon++;
  updateFirebaseState(true);
  updateRoundPips();
  playRoundWin();

  if (myRoundsWon >= ROUNDS_TO_WIN) {
    matchOver = true;
    showMatchResult(true);
  } else {
    showInterRound(true, reason);
  }
}

function handleRoundLoss(reason) {
  if (matchOver) return;
  oppRoundsWon++;
  updateRoundPips();
  playRoundLose();

  if (oppRoundsWon >= ROUNDS_TO_WIN) {
    matchOver = true;
    showMatchResult(false);
  } else {
    showInterRound(false, reason);
  }
}

function showInterRound(iWon, reason, nextRoundAt) {
  clearAllTimers();
  state = 'INTER_ROUND'; // blocks all clicks during 5s break
  document.body.classList.remove('zen-mode', 'mimic-mode', 'sudden-death-mode');
  wipeTargets();

  const roundJustPlayed = myRoundsWon + oppRoundsWon;
  const nextRound = roundJustPlayed + 1;

  const roundLabel = document.getElementById('inter-round-label');
  if (roundLabel) roundLabel.innerText = `ROUND ${roundJustPlayed} OVER  //  NEXT: ROUND ${nextRound}`;

  UI.interRoundResult.innerText = iWon ? '▲ ROUND WON' : '▼ ROUND LOST';
  UI.interRoundResult.style.color = iWon ? 'var(--green)' : 'var(--red)';
  UI.interRoundScore.innerText = `you ${myRoundsWon}  —  opp ${oppRoundsWon}   (first to ${ROUNDS_TO_WIN} wins)`;

  syncInterHackOptions();
  UI.interRoundOverlay.classList.remove('hidden');

  // Use a strict 5-second local timer to guarantee exactly 5 seconds for both players
  // regardless of when they received the Firebase update or what their PC clock says.
  let secondsLeft = 5;
  UI.interRoundTimer.innerText = secondsLeft;

  const tick = () => {
    secondsLeft--;
    UI.interRoundTimer.innerText = Math.max(0, secondsLeft);
    if (secondsLeft <= 0) {
      clearInterval(interRoundTimer);
      interRoundTimer = null;
      if (state === 'INTER_ROUND') startNextRound(); // BOTH players run this perfectly synced
    }
  };
  
  interRoundTimer = setInterval(tick, 1000);
}

function startNextRound() {
  if (state !== 'INTER_ROUND') return; // prevent double-call
  if (interRoundTimer) { clearInterval(interRoundTimer); interRoundTimer = null; }
  UI.interRoundOverlay.classList.add('hidden');

  // Advance round counter and re-arm result handler
  currentOnlineRound++;
  roundResultHandled = false;

  // Apply pending hack from previous round, then clear everything
  const applyMimic = pendingMimic;
  resetRoundState();
  streak = 0;
  score = 0;
  perfectStreak = 0;
  currentLevelIdx = 0;

  // Host clears roundResult AND hack data to prevent stale re-triggering
  if (isHost && roomRef) {
    update(roomRef, {
      roundResult: null,
      hackTarget: null,
      hackType: null,
      hackId: null
    });
  }

  // Also reset parry window (can't parry between rounds)
  parryWindowActive = false;
  pendingParryHackType = null;

  updateSidebar();
  updateRoundBadge();
  if (isOnline) updateZenPips(0);

  if (applyMimic) document.body.classList.add('mimic-mode');

  startGame();
}

function updateRoundBadge() {
  if (!isOnline) return;
  const roundNum = myRoundsWon + oppRoundsWon + 1;
  UI.modeBadge.innerText = `online · round ${roundNum} of ${ROUNDS_TO_WIN * 2 - 1}`;
}

// Show round score clearly during active online round
function showOnlineRoundHUD() {
  if (!isOnline) return;
  const roundNum = myRoundsWon + oppRoundsWon + 1;
  UI.statusPanel.innerText = `you ${myRoundsWon} — opp ${oppRoundsWon}  ·  round ${roundNum}`;
  UI.statusPanel.style.color = 'var(--text-muted)';
}

function showMatchResult(iWon) {
  clearAllTimers();
  state = 'MATCH_OVER'; // requires explicit button press to exit
  document.body.classList.remove('zen-mode', 'mimic-mode', 'sudden-death-mode');
  wipeTargets();
  UI.interRoundOverlay.classList.add('hidden');

  UI.gameArea.className = iWon ? 'state-success' : 'state-start';
  flashScreen(iWon ? 'white' : 'red');
  if (iWon) playRoundWin(); else playRoundLose();

  UI.targetStatus.innerText = iWon ? 'VICTORY' : 'DEFEATED';
  UI.statusPanel.innerText = iWon
    ? `match won  ${myRoundsWon} – ${oppRoundsWon}`
    : `match lost  ${myRoundsWon} – ${oppRoundsWon}`;
  UI.statusPanel.style.color = iWon ? 'var(--green)' : 'var(--red)';
  UI.modeBadge.innerText = iWon ? '🏆 match complete' : '💀 match over';

  updateFirebaseState(iWon);

  // Show return button prominently
  UI.mainBtn.style.opacity = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = 'return to lobby';
  UI.mainBtn.classList.remove('hidden');
}

function syncInterHackOptions() {
  document.querySelectorAll('.inter-hack-option').forEach(opt => {
    opt.classList.remove('active');
    if (opt.getAttribute('data-hack') === equippedHack) opt.classList.add('active');
  });
}

// Update the 5-pip ZEN charge indicator in the header
function updateZenPips(count, fired) {
  if (!UI.zenPips) return;
  UI.zenPips.innerHTML = '';
  // Only 2 pips now required for ZEN
  for (let i = 0; i < 2; i++) {
    const pip = document.createElement('div');
    if (fired && i === 1) {
      pip.className = 'zen-pip fired';
    } else {
      pip.className = 'zen-pip' + (i < count ? ' charged' : '');
    }
    UI.zenPips.appendChild(pip);
  }
}


// =============================================
// CORE GAME FUNCTIONS
// =============================================
function getLevelParams(idx) {
  const baseLevels = [
    { name: 'recruit',  window: 1500, threat: 'too easy' },
    { name: 'soldier',  window: 1200, threat: 'mild' },
    { name: 'veteran',  window: 900,  threat: 'getting warm' },
    { name: 'elite',    window: 700,  threat: 'intense' },
    { name: 'omega',    window: 500,  threat: 'lethal' }
  ];

  let actualLevel = idx + 1;
  let params = { level: actualLevel };

  if (idx < 5) {
    params.name     = baseLevels[idx].name;
    params.window   = baseLevels[idx].window;
    params.threat   = baseLevels[idx].threat;
    params.pulseDur = 0.8 - (idx * 0.1);
  } else {
    let diff   = idx - 4;
    let pluses = '+'.repeat(Math.min(diff, 3));
    params.name     = 'omega' + pluses;
    params.window   = Math.max(180, 500 - (diff * 25));
    params.threat   = actualLevel < 10 ? 'lethal' : actualLevel < 15 ? 'terminal' : 'god-tier';
    params.pulseDur = Math.max(0.1, 0.4 - (diff * 0.03));
  }

  // Online: give +25% time so fighting feels comfortable (hacks can still shrink it)
  if (isOnline) {
    params.window = Math.floor(params.window * 1.25);
    // Also raise the Omega floor so it never gets too brutal online
    params.window = Math.max(params.window, 300);
  }

  // TIMESHIFT hack: shrink window 30%
  if (isOnline && pendingTimeshift) {
    params.window   = Math.floor(params.window * 0.7);
    params.threat  += ' (hacked!)';
  }

  // Speed modifier (legacy rapid-fire)
  if (speedModRounds > 0) {
    params.window  = Math.floor(params.window * speedModifier);
  }

  return params;
}

function resetUI() {
  UI.gameOverScreen.classList.add('hidden');
  UI.resultDisplay.classList.add('hidden');
  document.body.classList.remove('screen-shake');
  UI.flashOverlay.className = '';
  void UI.flashOverlay.offsetWidth;
}

function updateFirebaseState(alive) {
  if (isOnline && myPlayerRef) {
    update(myPlayerRef, { alive, streak, score, roundsWon: myRoundsWon });
  }
}

function clearAllTimers() {
  clearTimeout(waitTimeout);
  clearTimeout(fireTimeout);
  clearTimeout(holdTimeout);
  clearTimeout(doubleTimeout);
  clearTimeout(autoNextTimeout);
  clearInterval(beepInterval);
  waitTimeout = fireTimeout = holdTimeout = doubleTimeout = autoNextTimeout = beepInterval = null;
}

// Reset only per-round transient hack effects
function resetRoundState() {
  // Clear body classes from previous round
  document.body.classList.remove('mimic-mode', 'sudden-death-mode');

  isZenMode     = false;
  perfectStreak = 0;
  zenNoteIndex  = 0;
  hackFiredThisZen  = false;
  parryWindowActive = false;
  pendingParryHackType = null;
  lastHackId    = null; // allow fresh hack in next round

  // Consume pending hacks (they were set last round, consume now)
  if (pendingMimic)    document.body.classList.add('mimic-mode');
  if (speedModRounds > 0) speedModRounds--;
  if (speedModRounds <= 0) { speedModifier = 1.0; }

  document.body.classList.remove('zen-mode');
}

// Called once per online match start
function resetMatchState() {
  myRoundsWon        = 0;
  oppRoundsWon       = 0;
  matchOver          = false;
  currentOnlineRound = 1;
  roundResultHandled = false;
  resetRoundScores();
  updateRoundPips();
}

function resetRoundScores() {
  streak        = 0;
  score         = 0;
  perfectStreak = 0;
  isZenMode     = false;
  hackFiredThisZen = false;
  parryWindowActive = false;
  pendingParryHackType = null;
  pendingOverload   = 0;
  pendingTimeshift  = false;
  pendingMimic      = false;
  speedModRounds    = 0;
  speedModifier     = 1.0;
  document.body.classList.remove('zen-mode', 'mimic-mode', 'sudden-death-mode');
  if (isOnline) updateZenPips(0);
}

function resetScores() {
  resetRoundScores();
}

function resetGameState() {
  clearAllTimers();
  activeTarget.resolved = true;
  currentLevelIdx = 0; // always reset to level 1 on death
  wipeTargets();
}

// =============================================
// SUDDEN DEATH CHECK
// =============================================
function checkSuddenDeath() {
  if (!isOnline) return;
  if (currentLevelIdx >= 4 && !document.body.classList.contains('sudden-death-mode')) {
    document.body.classList.add('sudden-death-mode');
    UI.modeBadge.innerText = '⚡ SUDDEN DEATH';
  }
}

// =============================================
// GAME FLOW
// =============================================
function startGame() {
  clearAllTimers();
  resetUI();
  wipeTargets();

  // Apply pending hacks from previous round
  if (isOnline) {
    if (pendingMimic) document.body.classList.add('mimic-mode');
  }

  updateFirebaseState(true);

  if (isOnline && isHost && roomRef) {
    update(roomRef, { state: 'playing' });
  }

  if (streak === 0 && !isOnline) {
    state = 'COUNTDOWN';
    UI.gameArea.className = 'state-wait';
    UI.mainBtn.style.opacity = '0';
    UI.mainBtn.style.pointerEvents = 'none';
    if (UI.diffContainer) UI.diffContainer.style.opacity = '0.2';
    if (UI.diffContainer) UI.diffContainer.style.pointerEvents = 'none';

    let count = 3;
    UI.targetStatus.innerText = count;
    UI.statusPanel.innerText = 'get ready';

    beepInterval = setInterval(() => {
      count--;
      if (count > 0) {
        UI.targetStatus.innerText = count;
        playLockOn();
      } else if (count === 0) {
        UI.targetStatus.innerText = 'GO!';
        playLockOn();
      } else {
        clearInterval(beepInterval);
        startWaitPhase();
      }
    }, 600);
  } else {
    startWaitPhase();
  }
}

function startWaitPhase() {
  state = 'WAIT';
  UI.gameArea.className = 'state-wait';
  if (isOnline) showOnlineRoundHUD(); // show score during active play
  UI.targetStatus.innerText = 'waiting...';
  UI.statusPanel.style.color = 'var(--text-muted)';
  UI.statusPanel.innerText = 'wait for it';
  UI.mainBtn.style.opacity = '0';
  UI.mainBtn.style.pointerEvents = 'none';

  const lvlParams = getLevelParams(currentLevelIdx);
  if (UI.diffContainer) UI.diffContainer.style.opacity = '0.2';
  if (UI.diffContainer) UI.diffContainer.style.pointerEvents = 'none';
  document.documentElement.style.setProperty('--pulse-dur', `${lvlParams.pulseDur}s`);

  const tw = document.getElementById('target-wrapper');
  let activePositions = [];

  if (currentLevelIdx >= 1) {
    const p1 = getRandomPos(currentLevelIdx, activePositions);
    activePositions.push(p1);
    tw.style.transition = 'transform 0.4s ease-out';
    tw.style.transform = `translate(calc(-50% + ${p1.x}px), calc(-50% + ${p1.y}px))`;
  } else {
    tw.style.transition = 'transform 0.4s ease-out';
    tw.style.transform = 'translate(-50%, -50%)';
  }

  // OVERLOAD hack: add extra decoys
  if (currentLevelIdx >= 1 || (isOnline && pendingOverload > 0)) {
    let decoyCount = Math.min(6, currentLevelIdx + 1);
    if (isOnline && pendingOverload > 0) {
      decoyCount += pendingOverload;
      pendingOverload = 0; // consume
    }
    spawnDecoys(decoyCount, currentLevelIdx, activePositions);
  }

  checkSuddenDeath();

  const delay = Math.random() * 300 + 200;
  targetFireTime = performance.now() + delay;
  waitTimeout = setTimeout(() => { firePhase(); }, delay);
}

// Radial burst of particles on PERFECT hit
function spawnPerfectBurst(e, isZen) {
  if (!e) return;
  let cx = window.innerWidth / 2;
  let cy = window.innerHeight / 2;
  if (e.clientX !== undefined) { cx = e.clientX; cy = e.clientY; }
  else if (e.touches && e.touches.length > 0) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }

  const count  = isZen ? 16 : 8;
  const color  = isZen ? '#ffd700' : '#ff00ff';
  const color2 = isZen ? '#fff'    : '#c084fc';

  for (let i = 0; i < count; i++) {
    const el   = document.createElement('div');
    const angle = (i / count) * Math.PI * 2;
    const dist  = isZen ? (80 + Math.random() * 60) : (50 + Math.random() * 40);
    const dx    = Math.cos(angle) * dist;
    const dy    = Math.sin(angle) * dist;
    const sz    = isZen ? (4 + Math.random() * 4) : (3 + Math.random() * 3);
    const clr   = Math.random() > 0.5 ? color : color2;

    el.style.cssText = `
      position:fixed; pointer-events:none; z-index:999;
      width:${sz}px; height:${sz}px; border-radius:50%;
      background:${clr}; box-shadow: 0 0 ${sz * 2}px ${clr};
      left:${cx}px; top:${cy}px;
      transform:translate(-50%,-50%);
      transition: transform 0.5s cubic-bezier(.2,.8,.4,1), opacity 0.5s ease-out;
    `;
    document.body.appendChild(el);
    // Force reflow then animate outward
    void el.offsetWidth;
    el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    el.style.opacity   = '0';
    setTimeout(() => el.remove(), 520);
  }

  // Brief glow on the game area
  if (isZen) {
    document.body.classList.add('zen-burst');
    setTimeout(() => document.body.classList.remove('zen-burst'), 350);
  } else {
    document.body.classList.add('perfect-burst');
    setTimeout(() => document.body.classList.remove('perfect-burst'), 200);
  }

  // Ring ripple on the actual target
  const tgt = document.getElementById('main-target');
  if (tgt) {
    const ringClass = isZen ? 'zen-perfect' : 'perfect';
    tgt.classList.add(ringClass);
    setTimeout(() => tgt.classList.remove(ringClass), 400);
  }
}

function spawnFloatingText(e, text, color) {
  if (!e) return;
  const el = document.createElement('div');
  el.className = 'floating-text';
  el.innerText = text;
  el.style.color = color;
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  if (e.clientX !== undefined) { x = e.clientX; y = e.clientY; }
  else if (e.touches && e.touches.length > 0) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function getRandomPos(level, existingPositions = []) {
  const tSize = 80;  // target visual radius
  // Safe play area: leave room for header (~110px) and footer (~140px), side padding 30px
  const safeTop    = 110;
  const safeBottom = 140;
  const safeSide   = 30;
  const areaW = window.innerWidth  - safeSide * 2;
  const areaH = window.innerHeight - safeTop - safeBottom;
  const spreadX = Math.max(60, (areaW  - tSize) / 2);
  const spreadY = Math.max(60, (areaH  - tSize) / 2);

  // Adaptive minimum distance: smaller on narrow screens so placement is always possible
  const rawMinDist = 120;
  // Max distance that can fit given the spread (need at least 2 non-overlapping slots)
  const maxPossible = Math.min(spreadX, spreadY) * 1.2;
  const minDist = Math.min(rawMinDist, maxPossible * 0.7);

  let x, y, valid = false, attempts = 0;
  while (!valid && attempts < 80) {
    x = (seededRandom() * spreadX * 2) - spreadX;
    y = (seededRandom() * spreadY * 2) - spreadY;
    valid = true;
    for (const pos of existingPositions) {
      const dx = x - pos.x, dy = y - pos.y;
      if (Math.sqrt(dx*dx + dy*dy) < minDist) { valid = false; break; }
    }
    attempts++;
    // Relax minDist progressively if stuck
    if (!valid && attempts % 20 === 0 && minDist > 60) {
      // continue with smaller effective minDist on next pass
    }
  }
  // If still not placed after 80 attempts, use best effort (no overlap check)
  return { x, y };
}

function spawnDecoys(count, level, existingPositions) {
  // On small screens limit fake count so they can all be placed without overlap
  const isMobile = window.innerWidth <= 480;
  const maxFakes = isMobile ? Math.min(count, 3) : count;

  for (let i = 0; i < maxFakes; i++) {
    const decoy = document.createElement('div');
    decoy.className = 'fake-target';

    const p = getRandomPos(level, existingPositions);
    existingPositions.push(p);

    decoy.style.transition = 'none';
    decoy.style.transform  = 'translate(-50%, -50%)';
    UI.gameArea.appendChild(decoy);
    void decoy.offsetWidth;

    decoy.style.transition = 'transform 0.2s ease-out';
    decoy.style.transform  = `translate(calc(-50% + ${p.x}px), calc(-50% + ${p.y}px))`;

    const failHandler = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      if (state === 'WAIT') {
        if (isOnline) { onlineFail('too early.'); } else { failGame('too early.'); }
      } else if (state === 'FIRE' && !activeTarget.resolved) {
        activeTarget.resolved = true;
        if (isOnline) { onlineFail('hit fake target.'); } else { failGame('hit fake target.'); }
      }
    };
    decoy.addEventListener('mousedown', failHandler);
    decoy.addEventListener('touchstart', failHandler, { passive: false });
  }
}

function wipeTargets() {
  document.querySelectorAll('.fake-target').forEach(el => el.remove());
  const tw = document.getElementById('target-wrapper');
  if (tw) {
    tw.style.transition = 'none';
    tw.style.transform  = 'translate(-50%, -50%)';
  }
  clearTemporaryFeedback();
}

function firePhase() {
  state = 'FIRE';
  UI.gameArea.className = 'state-fire';
  UI.statusPanel.style.color = 'var(--green)';
  UI.targetStatus.innerText = 'click!';
  UI.statusPanel.innerText  = 'now!';
  flashScreen('white');
  playFire();

  document.querySelectorAll('.fake-target').forEach(el => el.classList.add('revealed'));

  startTime = performance.now();
  const lvl = getLevelParams(currentLevelIdx);

  // Consume TIMESHIFT (already applied to lvl.window above)
  pendingTimeshift = false;

  activeTarget = {
    id: Date.now() + Math.random(),
    spawnedAt: performance.now(),
    allowedTime: lvl.window,
    resolved: false
  };
  const tid = activeTarget.id;

  fireTimeout = setTimeout(() => {
    if (activeTarget.id === tid && !activeTarget.resolved) {
      activeTarget.resolved = true;
      if (isOnline) { onlineFail('too slow.'); } else { failGame('too slow.'); }
    }
  }, lvl.window);
}


// =============================================
// ZEN MODE & HACK TRIGGER
// =============================================
function activateZenMode() {
  isZenMode = true;
  zenNoteIndex = 0;   // start scale from bottom
  document.body.classList.add('zen-mode');
  flashScreen('white');
  document.body.classList.add('screen-shake');
  spawnFloatingText(null, 'ZONE ENTERED', '#ffd700');
  playTone(1000, 'square', 0.5, 0.2);
  setTimeout(() => document.body.classList.remove('screen-shake'), 300);

  // Fire hack at opponent (online only, once per ZEN)
  if (isOnline && !hackFiredThisZen) {
    hackFiredThisZen = true;
    sendHack(equippedHack);
    showHackExecutedBanner(equippedHack);
    playHackLaunch();
    // Show fired state on pips then clear
    updateZenPips(5, true);
    setTimeout(() => updateZenPips(5), 800);
  }
}

function grantScore(e, elapsed, basePoints, typeText) {
  let isPerfect = elapsed < 300;

  if (isPerfect) {
    // Firewall check: first PERFECT after receiving a hack = parry
    if (isOnline && parryWindowActive) {
      attemptParry();
    }

    perfectStreak++;
    if (isZenMode) zenNoteIndex++;   // rises with each ZEN PERFECT
    if (isOnline) updateZenPips(perfectStreak);
    if (perfectStreak >= 2 && !isZenMode) activateZenMode();
  } else {
    perfectStreak = 0;
    if (isOnline) updateZenPips(0);
    if (isZenMode) {
      isZenMode = false;
      hackFiredThisZen = false;
      zenNoteIndex = 0;
      document.body.classList.remove('zen-mode');
      spawnFloatingText(e, 'ZONE LOST', 'var(--text-muted)');
    }
  }

  let pMult = isZenMode ? 5.0 : ((streak >= 10) ? 2.0 : (streak >= 5) ? 1.5 : 1.0);
  if (isPerfect && basePoints > 0) basePoints += 1;
  let pts = Math.floor(basePoints * pMult);
  score += pts;

  // Audio: different sounds for ZEN vs PERFECT vs normal
  if (isPerfect) {
    playPerfectHit(streak, isZenMode);
  } else {
    playSuccess();
  }

  let tColor = isZenMode ? '#ffd700' : (isPerfect ? '#ff00ff' : 'var(--green)');
  let pre    = isZenMode ? 'ZEN x5.0! ' : (isPerfect ? `PERFECT x${pMult}! ` : (pMult > 1.0 ? `x${pMult} ` : ''));
  spawnFloatingText(e, `${pre}${typeText} +${pts}`, tColor);

  // Visual effect: PERFECT burst
  if (isPerfect) spawnPerfectBurst(e, isZenMode);
}

// =============================================
// SUCCESS / FAIL (Online-aware)
// =============================================
function successGame() {
  const rt = Math.floor(performance.now() - startTime);
  clearAllTimers();
  activeTarget.resolved = true;

  state = 'RESULT';
  resultStartTime = performance.now();
  UI.gameArea.className = 'state-success';
  UI.targetStatus.innerText = 'nice.';
  UI.statusPanel.innerText  = 'survived.';
  UI.statusPanel.style.color = 'var(--text-muted)';

  const streakEl = document.getElementById('streak-counter');
  streakEl.classList.remove('score-pulse');
  void streakEl.offsetWidth;
  streakEl.classList.add('score-pulse');

  streak++;
  if (streak % 5 === 0) currentLevelIdx++; // level up every 5 hits
  updateFirebaseState(true);
  updateSelectorUI();
  updateBestScore();
  showResult(rt, null);
  updateSidebar();

  // Consume MIMIC after first fire phase
  pendingMimic = false;
  document.body.classList.remove('mimic-mode');

  autoNextTimeout = setTimeout(() => {
    if (state === 'RESULT') startGame();
  }, 500);
}

// Online fail → round loss, not match over immediately
function onlineFail(reason) {
  if (state === 'INTER_ROUND' || state === 'MATCH_OVER') return;
  if (roundResultHandled) return; // already handled this round
  roundResultHandled = true;

  isZenMode     = false;
  perfectStreak = 0;
  hackFiredThisZen = false;
  document.body.classList.remove('zen-mode');

  clearAllTimers();
  activeTarget.resolved = true;

  // Visual feedback
  UI.gameArea.className = 'state-start';
  flashScreen('red');
  // Soft round-loss sound
  playTone(220, 'sine', 0.4, 0.12);
  setTimeout(() => playTone(160, 'sine', 0.5, 0.1), 180);
  document.body.classList.add('screen-shake');
  setTimeout(() => document.body.classList.remove('screen-shake'), 250);

  UI.targetStatus.innerText = reason;
  UI.statusPanel.innerText  = 'round lost.';
  UI.statusPanel.style.color = 'var(--red)';

  updateFirebaseState(false);
  updateSidebar();

  // Write round result to Firebase (remove nextRoundAt timestamp sync)
  if (roomRef && authUser) {
    update(roomRef, {
      roundResult: {
        round: currentOnlineRound,
        loser: authUser.uid,
        reason
      }
    });
  }

  // Immediately trigger local round loss
  handleRoundLoss(reason);
}

// Offline fail (unchanged user experience)
function failGame(reason) {
  isZenMode    = false;
  perfectStreak = 0;
  document.body.classList.remove('zen-mode');

  resetGameState();

  if (UI.diffContainer) UI.diffContainer.style.opacity    = '1';
  if (UI.diffContainer) UI.diffContainer.style.pointerEvents = 'auto';

  state = 'RESULT';
  resultStartTime = performance.now();
  UI.gameArea.className = 'state-start';
  document.body.classList.add('screen-shake');

  flashScreen('red');
  playFail();

  UI.targetStatus.innerText = '';
  UI.statusPanel.innerText  = reason;
  UI.statusPanel.style.color = 'var(--red)';

  UI.gameOverScore.innerText = score;
  UI.gameOverScreen.classList.remove('hidden');

  updateFirebaseState(false);
  updateSelectorUI();
  updateSidebar();

  UI.mainBtn.style.opacity      = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = 'REMATCH';
}

// Online win (opponent died) — now routes through BO5
function winGame(reason) {
  if (isOnline) {
    handleRoundWin(reason);
    return;
  }
  resetGameState();
  if (UI.diffContainer) UI.diffContainer.style.opacity    = '1';
  if (UI.diffContainer) UI.diffContainer.style.pointerEvents = 'auto';
  state = 'RESULT';
  UI.gameArea.className = 'state-success';
  flashScreen('white');
  playSuccess();
  UI.targetStatus.innerText = 'victory.';
  UI.statusPanel.innerText  = reason;
  UI.statusPanel.style.color = 'var(--text-main)';
  showTemporaryFeedback('WIN', 'rank-godlike', 'survivor', 800);
  updateFirebaseState(true);
  updateSelectorUI();
  updateSidebar();
  UI.mainBtn.style.opacity      = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = 'return to lobby';
}

// =============================================
// UI HELPERS
// =============================================
function clearTemporaryFeedback() {
  if (feedbackTimeout) { clearTimeout(feedbackTimeout); feedbackTimeout = null; }
  document.querySelectorAll('.floating-text').forEach(e => e.remove());
  UI.gameArea.className = '';
  document.body.classList.remove('screen-shake', 'screen-shake-small');
  UI.targetStatus.innerText = '';
  UI.resultDisplay.classList.add('hidden');
}

function showTemporaryFeedback(timeText, rankClass, rankText, duration = 400) {
  if (feedbackTimeout) clearTimeout(feedbackTimeout);
  UI.resultTime.innerText  = timeText;
  UI.resultRank.innerText  = rankText || '';
  UI.resultRank.className  = rankClass || '';
  UI.resultTime.style.color = timeText === 'WIN' ? 'var(--green)' : timeText.startsWith('SCORE:') ? 'var(--red)' : 'var(--text-main)';
  UI.resultDisplay.classList.remove('hidden');
  feedbackTimeout = setTimeout(() => { clearTemporaryFeedback(); }, duration);
}

function showResult(rt, overrideRank) {
  if (overrideRank) {
    showTemporaryFeedback(overrideRank, 'rank-godlike', '', 400);
  } else {
    let rank, rankClass;
    if      (rt < 150) { rank = 'godlike'; rankClass = 'rank-godlike'; }
    else if (rt < 200) { rank = 'elite';   rankClass = 'rank-elite'; }
    else if (rt < 250) { rank = 'sharp';   rankClass = 'rank-sharp'; }
    else               { rank = 'slow';    rankClass = 'rank-slow'; }
    showTemporaryFeedback(rt + 'ms', rankClass, rank, 400);
  }
}

function flashScreen(color) {
  UI.flashOverlay.className = '';
  void UI.flashOverlay.offsetWidth;
  UI.flashOverlay.className = color === 'white' ? 'flash-white' : 'flash-red';
}

function updateBestScore() {
  if (!bestScoreAmt || score > bestScoreAmt) {
    bestScoreAmt = score;
    localStorage.setItem('cod_best_score_amt', bestScoreAmt);
  }
}

function updateSidebar() {
  const lvlParams = getLevelParams(currentLevelIdx);
  UI.levelDisplay.innerText = `level ${lvlParams.level} // ${lvlParams.name}`;
  UI.threatDisplay.innerText = lvlParams.threat;
  if (bestScoreAmt) UI.bestScore.innerText = bestScoreAmt + ' pts';
  if (UI.scoreCounter)  UI.scoreCounter.innerText  = score;
  if (UI.streakCounter) UI.streakCounter.innerText = streak;
}

function updateSelectorUI() {
  // difficulty buttons removed — no-op
}

// =============================================
// COUNTDOWN & ENTER GAME
// =============================================
function startCountdown(endTime) {
  Lobby.btnReady.classList.add('hidden');
  Lobby.btnStart.classList.add('hidden');
  Lobby.hostMessage.classList.add('hidden');
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

function enterGameMode(online) {
  isOnline = online;
  showScreen('screen-game');
  UI.modeBadge.innerText = isOnline ? 'online versus' : 'offline mode';

  if (isOnline) {
    document.getElementById('opp-stats').classList.remove('hidden');
    UI.roundScoreboard.classList.remove('hidden');
    UI.pingDisplay.classList.remove('hidden');
    UI.zenChargeDisplay.classList.remove('hidden');
    updateZenPips(0);
    UI.bestContainer.classList.add('hidden');
    if (UI.diffContainer) UI.diffContainer.classList.add('hidden');
    currentLevelIdx = 0;
    UI.btnQuit.classList.remove('hidden');
    UI.mainBtn.classList.add('hidden');
    UI.mainBtn.style.opacity = '0';

    resetMatchState();
    updateRoundBadge();   // show "online · round 1 of 5" from the start
    startPingLoop();
    setupPingResponder();
    startGame();
  } else {
    document.getElementById('opp-stats').classList.add('hidden');
    UI.roundScoreboard.classList.add('hidden');
    UI.pingDisplay.classList.add('hidden');
    if (UI.zenChargeDisplay) UI.zenChargeDisplay.classList.add('hidden');
    UI.bestContainer.classList.remove('hidden');
    if (UI.diffContainer) UI.diffContainer.classList.remove('hidden');
    UI.btnQuit.classList.remove('hidden');
    UI.mainBtn.classList.remove('hidden');
    UI.mainBtn.style.opacity = '1';
    state = 'START';
    resetScores();
    resetUI();
    updateSidebar();
  }
}


// =============================================
// INPUT HANDLERS
// =============================================
function handleBackgroundClick(e) {
  if (e && e.cancelable) e.preventDefault();
  initAudio();

  // INTER_ROUND: 5-second break, block ALL clicks
  if (state === 'INTER_ROUND') return;
  // MATCH_OVER: only the explicit button should work, not background
  if (state === 'MATCH_OVER') return;

  if (state === 'START') {
    if (!isOnline) startGame();
    // Online: background click does nothing in START (use lobby button)
  } else if (state === 'RESULT') {
    if (performance.now() - resultStartTime < 300) return;
    if (!isOnline) startGame();
    // Online RESULT: do nothing on background click, user must use main btn
  } else if (state === 'WAIT') {
    if (performance.now() >= targetFireTime - 80) {
      clearTimeout(waitTimeout);
      clearInterval(beepInterval);
      firePhase();
      activeTarget.resolved = true;
      if (isOnline) { onlineFail('missed target.'); } else { failGame('missed target.'); }
    } else {
      if (isOnline) { onlineFail('too early.'); } else { failGame('too early.'); }
    }
  } else if (state === 'FIRE') {
    if (!activeTarget.resolved) {
      activeTarget.resolved = true;
      if (isOnline) { onlineFail('missed target.'); } else { failGame('missed target.'); }
    }
  }
}

function handleInputDown(e) {
  if (e && e.cancelable) e.preventDefault();
  if (e) e.stopImmediatePropagation();
  initAudio();

  // INTER_ROUND: 5-second break, block ALL inputs
  if (state === 'INTER_ROUND') return;

  // MATCH_OVER: only the main 'return to lobby' button works
  if (state === 'MATCH_OVER') {
    returnToLobby();
    return;
  }

  if (state === 'START') {
    if (!isOnline) startGame();
    return;
  }

  if (state === 'RESULT') {
    if (performance.now() - resultStartTime < 300) return;
    if (!isOnline) {
      resetScores();
      startGame();
    } else {
      returnToLobby();
    }
    return;
  }

  if (state === 'WAIT') {
    if (performance.now() >= targetFireTime - 80) {
      clearTimeout(waitTimeout);
      clearInterval(beepInterval);
      firePhase();
    } else {
      if (isOnline) { onlineFail('too early.'); } else { failGame('too early.'); }
      return;
    }
  }

  if (state === 'FIRE') {
    if (activeTarget.resolved) return;

    const tgt = document.getElementById('main-target');
    if (tgt) {
      tgt.style.transform = 'scale(0.8)';
      setTimeout(() => tgt.style.transform = '', 150);
    }

    const elapsed = performance.now() - activeTarget.spawnedAt;

    if (elapsed <= activeTarget.allowedTime) {
      activeTarget.resolved = true;
      grantScore(e, elapsed, 1, 'HIT');
      successGame();
    } else {
      activeTarget.resolved = true;
      if (isOnline) { onlineFail('too slow.'); } else { failGame('too slow.'); }
    }
  }
}

function returnToLobby() {
  clearAllTimers();
  if (interRoundTimer) { clearInterval(interRoundTimer); interRoundTimer = null; }
  stopPingLoop();
  
  // Wipe all match state globally so next match is clean
  matchOver = false;
  currentOnlineRound = 1;
  roundResultHandled = false;
  resetRoundState();
  resetRoundScores();
  
  if (UI.interRoundOverlay) UI.interRoundOverlay.classList.add('hidden');
  if (UI.flashOverlay) UI.flashOverlay.className = '';

  if (myPlayerRef) update(myPlayerRef, { ready: false, alive: true, streak: 0, roundsWon: 0 });
  
  // Both host AND guest must reset game state — host clears the entire room
  if (roomRef) {
    if (isHost) {
      update(roomRef, { 
        state: 'lobby', 
        gameStarted: false,
        countdownEnd: null,
        roundResult: null,
        currentRound: null,
        hackTarget: null, 
        hackType: null, 
        hackId: null 
      });
    } else {
      // Guest: If host already left or hasn't reset it yet, ensure we don't hold the lock
      update(roomRef, { gameStarted: false });
    }
  }
  showLobbyInfo();
  showScreen('screen-lobby');
  state = 'START';
  resetGameState();
}

// =============================================
// EVENT LISTENERS
// =============================================

// Target click
const tw = document.getElementById('target-wrapper');
tw.addEventListener('mousedown', handleInputDown);
tw.addEventListener('touchstart', handleInputDown, { passive: false });

// Background miss
UI.clickLayer.addEventListener('mousedown', handleBackgroundClick);
UI.clickLayer.addEventListener('touchstart', handleBackgroundClick, { passive: false });

// Main button (Play / Return)
UI.mainBtn.addEventListener('mousedown', handleInputDown);
UI.mainBtn.addEventListener('touchstart', handleInputDown, { passive: false });

// Lobby hack options (pre-match)
Lobby.hackOptions.forEach(opt => {
  opt.addEventListener('click', (e) => {
    Lobby.hackOptions.forEach(o => o.classList.remove('active'));
    e.target.classList.add('active');
    equippedHack = e.target.getAttribute('data-hack');
  });
});

// Inter-round hack options (mid-match)
document.querySelectorAll('.inter-hack-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    document.querySelectorAll('.inter-hack-option').forEach(o => o.classList.remove('active'));
    e.target.classList.add('active');
    equippedHack = e.target.getAttribute('data-hack');
    // Also sync the lobby options to stay consistent
    Lobby.hackOptions.forEach(o => {
      o.classList.remove('active');
      if (o.getAttribute('data-hack') === equippedHack) o.classList.add('active');
    });
  });
});

// difficulty buttons removed from HTML — no listeners needed

// Menu buttons
Lobby.btnOffline.addEventListener('click', () => { initAudio(); enterGameMode(false); });
Lobby.btnOnline.addEventListener('click',  () => { initAudio(); showScreen('screen-lobby'); });

Lobby.btnCreate.addEventListener('click', createRoom);
Lobby.btnJoin.addEventListener('click', () => {
  const code = Lobby.roomInput.value.trim();
  if (code.length === 4) joinRoom(code);
});

Lobby.btnReady.addEventListener('click', async () => {
  if (myPlayerRef) await update(myPlayerRef, { ready: true });
});

Lobby.btnStart.addEventListener('click', async () => {
  Lobby.btnStart.disabled = true;
  Lobby.btnStart.classList.add('hidden');
  if (isHost && roomRef) {
    try {
      await update(roomRef, {
        state: 'starting',
        gameStarted: true,
        startedAt: Date.now(),
        countdownEnd: Date.now() + 3000
      });
    } catch (e) {
      console.error('[Lobby] Firebase Error on Start Game:', e);
      Lobby.btnStart.disabled = false;
      Lobby.btnStart.classList.remove('hidden');
    }
  }
});

Lobby.btnLeave.addEventListener('click', async () => {
  if (myPlayerRef) await remove(myPlayerRef);
  showScreen('screen-menu');
});

UI.btnQuit.addEventListener('click', async () => {
  clearAllTimers();
  if (interRoundTimer) { clearInterval(interRoundTimer); interRoundTimer = null; }
  stopPingLoop();
  document.body.classList.remove('zen-mode', 'mimic-mode', 'sudden-death-mode');
  UI.interRoundOverlay.classList.add('hidden');
  if (myPlayerRef) await remove(myPlayerRef);
  showScreen('screen-menu');
});

// =============================================
// INITIALIZE
// =============================================
updateSidebar();
updateRoundPips();
