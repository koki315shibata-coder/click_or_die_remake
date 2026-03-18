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

let state = 'START'; // START, COUNTDOWN, WAIT, FIRE, RESULT
let currentCommand = 'fire'; 
let currentModifier = 'normal'; 
let currentLevelIdx = 0;
let streak = 0;
let score = 0;
let bestScoreAmt = parseInt(localStorage.getItem('cod_best_score_amt')) || 0;
let hasShield = false;
let targetFireTime = 0;
let activeTarget = { id: null, spawnedAt: 0, allowedTime: 0, resolved: true };
let resultStartTime = 0;

function getModifier(level) {
  let rand = isOnline ? seededRandom() : Math.random();
  if (level < 2) return 'normal';
  if (rand < 0.15) return 'shield';
  if (rand < 0.30) return 'steal';
  if (rand < 0.45) return 'chaos';
  return 'normal';
}
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
  btnStart: document.getElementById('btn-start-game'),
  hostMessage: document.getElementById('host-message'),
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
  
  Lobby.btnStart.classList.add('hidden');
  Lobby.btnStart.disabled = false;
  Lobby.hostMessage.classList.add('hidden');
  Lobby.countdown.classList.add('hidden');
}

function setupRoomListeners() {
  onValue(roomRef, snap => {
    const data = snap.val();
    if (!data) return; // Room closed

    console.log('[Firebase] Room snapshot received. State:', data.state, '| gameStarted:', data.gameStarted);

    globalSeed = data.seed;

    if (data.players) {
      const players = Object.keys(data.players);
      const myData = data.players[authUser.uid] || {};
      const oppId = players.find(id => id !== authUser.uid);
      const oppData = oppId ? data.players[oppId] : null;

      Lobby.p1Slot.innerHTML = `you: <span class="status ${myData.ready ? 'ready' : ''}">${myData.ready ? 'READY' : 'WAITING...'}</span>`;

      if (oppData) {
        Lobby.p2Slot.innerHTML = `opponent: <span class="status ${oppData.ready ? 'ready' : ''}">${oppData.ready ? 'READY' : 'WAITING...'}</span>`;
        OppUI.streak.innerText = oppData.score || 0;
        OppUI.state.innerText = oppData.alive ? 'alive' : 'dead';
        OppUI.state.style.color = oppData.alive ? 'var(--text-muted)' : 'var(--red)';

        // Handle multiplayer progression events
        if (data.state === 'playing') {
          if (!oppData.alive && myData.alive && state !== 'RESULT') {
            winGame("opponent eliminated.");
          }
        }
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

        // Handle Host Privilege Recovery & Auto-Promotion
        if (data.host === authUser.uid) {
          isHost = true;
        } else if (players.length > 0 && !players.includes(data.host)) {
          // If the original host left the room completely, promote the first active player
          if (players[0] === authUser.uid) {
            console.log('[Lobby] Original host missing. Auto-promoting to host.');
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

      const isStarting = data.state === 'starting' || data.gameStarted === true;
      if (isStarting && state !== 'WAIT' && state !== 'FIRE') {
        console.log('[Lobby] Transitioning to start countdown. Target:', data.countdownEnd);
        Lobby.hostMessage.classList.add('hidden');
        Lobby.btnStart.classList.add('hidden');
        if (Lobby.countdown.classList.contains('hidden')) {
          console.log('[Lobby] Initiating startCountdown function natively.');
          startCountdown(data.countdownEnd);
        }
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

  if (type === 'steal') {
    if (hasShield) {
      hasShield = false;
      triggerCenterAlert("shield blocked steal!");
      UI.modeBadge.innerText = isOnline ? 'online versus' : 'offline mode';
    } else {
      streak = Math.max(0, streak - 1);
      triggerCenterAlert("streak stolen!");
      updateSidebar();
      updateFirebaseState(true);
    }
    return;
  }

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
    update(myPlayerRef, { alive, streak: streak, score: score });
  }
}

function triggerCenterAlert(text) {
  const el = document.createElement('div');
  el.className = 'attack-alert';
  el.innerText = text;
  UI.centerAlerts.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function clearAllTimers() {
  if (waitTimeout) clearTimeout(waitTimeout);
  if (fireTimeout) clearTimeout(fireTimeout);
  if (holdTimeout) clearTimeout(holdTimeout);
  if (doubleTimeout) clearTimeout(doubleTimeout);
  if (autoNextTimeout) clearTimeout(autoNextTimeout);
  if (beepInterval) clearInterval(beepInterval);
  waitTimeout = fireTimeout = holdTimeout = doubleTimeout = autoNextTimeout = beepInterval = null;
}

function startGame() {
  clearAllTimers();
  resetUI();
  wipeTargets();

  holdActive = false;
  doublePending = false;
  currentCommand = getCommand(currentLevelIdx + 1);
  currentModifier = getModifier(currentLevelIdx + 1);
  updateFirebaseState(true);

  if (isOnline && isHost && roomRef) {
    update(roomRef, { state: 'playing' });
  }

  if (streak === 0 && !isOnline) {
    state = 'COUNTDOWN';
    UI.gameArea.className = 'state-wait';
    UI.mainBtn.style.opacity = '0';
    UI.mainBtn.style.pointerEvents = 'none';
    UI.diffContainer.style.opacity = '0.2';
    UI.diffContainer.style.pointerEvents = 'none';

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
  UI.targetStatus.innerText = 'waiting...';

  let modifierText = 'wait for it';
  UI.statusPanel.style.color = 'var(--text-muted)';
  if (currentModifier === 'shield') {
    modifierText = 'SHIELD ROUND';
    UI.statusPanel.style.color = '#ffd700';
  } else if (currentModifier === 'steal') {
    modifierText = 'STEAL ROUND';
    UI.statusPanel.style.color = 'var(--red)';
  } else if (currentModifier === 'chaos') {
    modifierText = 'CHAOS ROUND';
    UI.statusPanel.style.color = '#aa00ff';
  }
  UI.statusPanel.innerText = modifierText;

  UI.mainBtn.style.opacity = '0';
  UI.mainBtn.style.pointerEvents = 'none';

  const lvlParams = getLevelParams(currentLevelIdx);
  UI.diffContainer.style.opacity = '0.2';
  UI.diffContainer.style.pointerEvents = 'none';

  document.documentElement.style.setProperty('--pulse-dur', `${lvlParams.pulseDur}s`);

  // --- Target Positioning Phase ---
  const tw = document.getElementById('target-wrapper');
  if (currentLevelIdx >= 1) {
    const p1 = getRandomPos(currentLevelIdx);
    tw.style.transition = 'transform 0.4s ease-out';
    tw.style.transform = `translate(calc(-50% + ${p1.x}px), calc(-50% + ${p1.y}px))`;
  } else {
    tw.style.transition = 'transform 0.4s ease-out';
    tw.style.transform = `translate(-50%, -50%)`;
  }

  if (currentLevelIdx >= 2 || currentModifier === 'chaos') {
    let decoyCount = Math.min(5, Math.floor(currentLevelIdx / 2));
    if (currentModifier === 'chaos') decoyCount += 3;
    spawnDecoys(decoyCount, currentLevelIdx);
  }
  // --------------------------------

  let rng = isOnline ? seededRandom() : Math.random();
  const minDelay = Math.max(600, 1500 - (currentLevelIdx * 50));
  const maxDelay = Math.min(5000, 3500 + (currentLevelIdx * 100));
  const delay = rng * (maxDelay - minDelay) + minDelay;

  targetFireTime = performance.now() + delay;

  beepInterval = setInterval(playLockOn, 500);

  waitTimeout = setTimeout(() => {
    clearInterval(beepInterval);
    firePhase();
  }, delay);
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
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function getRandomPos(level) {
  const tSize = 100;
  const maxW = window.innerWidth - tSize;
  const maxH = window.innerHeight - tSize - 100;
  
  const spreadX = Math.min(maxW / 2, level * 40);
  const spreadY = Math.min(maxH / 2, level * 40);
  
  const x = (seededRandom() * spreadX * 2) - spreadX;
  const y = (seededRandom() * spreadY * 2) - spreadY;
  
  return {x, y};
}

function spawnDecoys(count, level) {
  for(let i=0; i<count; i++) {
    const decoy = document.createElement('div');
    decoy.className = 'decoy-target';
    if (seededRandom() > 0.5) decoy.classList.add('danger-target');
    else decoy.classList.add('fake-target');
    
    // Spawn in center and slide out during wait phase
    const p = getRandomPos(level);
    
    decoy.style.transition = 'none';
    decoy.style.transform = `translate(-50%, -50%)`;
    UI.gameArea.appendChild(decoy);
    
    void decoy.offsetWidth; // flush styles

    decoy.style.transition = 'transform 0.4s ease-out';
    decoy.style.transform = `translate(calc(-50% + ${p.x}px), calc(-50% + ${p.y}px))`;
    
    const failHandler = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      if (state === 'FIRE' && !activeTarget.resolved) {
        activeTarget.resolved = true;
        failGame(decoy.classList.contains('danger-target') ? 'hit danger target.' : 'hit wrong target.');
      }
    };
    decoy.addEventListener('mousedown', failHandler);
    decoy.addEventListener('touchstart', failHandler, { passive: false });
  }
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

  activeTarget = {
    id: Date.now() + Math.random(),
    spawnedAt: performance.now(),
    allowedTime: 1000, 
    resolved: false
  };
  const tid = activeTarget.id;

  if (currentCommand === 'ignore') {
    activeTarget.allowedTime = 1000;
    fireTimeout = setTimeout(() => {
      if (activeTarget.id === tid && !activeTarget.resolved) {
        activeTarget.resolved = true;
        grantScore(null, 500, 2, 'PASS');
        successGame(); 
      }
    }, activeTarget.allowedTime); 
  } else {
    let win = currentLevel.window;
    if (currentCommand === 'double') win += 200; 
    if (currentCommand === 'hold') win += 500; 

    activeTarget.allowedTime = win + 80;

    fireTimeout = setTimeout(() => {
      if (activeTarget.id === tid && !activeTarget.resolved) {
        activeTarget.resolved = true;
        failGame('too slow.');
      }
    }, activeTarget.allowedTime);
  }
}

function successGame() {
  const rt = Math.floor(performance.now() - startTime);
  clearAllTimers(); 
  activeTarget.resolved = true;
  holdActive = false; doublePending = false;

  state = 'RESULT';
  resultStartTime = performance.now();
  UI.gameArea.className = 'state-success';
  UI.targetStatus.innerText = 'nice.';

  UI.statusPanel.innerText = 'survived.';
  UI.statusPanel.style.color = 'var(--text-muted)';

  const streakEl = document.getElementById('streak-counter');
  streakEl.classList.remove('score-pulse');
  void streakEl.offsetWidth; 
  streakEl.classList.add('score-pulse');

  playSuccess();
  streak++;
  if (speedModRounds > 0) speedModRounds--;

  if (currentModifier === 'shield') {
    hasShield = true;
    spawnFloatingText(null, 'SHIELDED', '#ffd700');
    UI.modeBadge.innerText = isOnline ? 'online versus [SHIELD]' : 'offline [SHIELD]';
  } else if (currentModifier === 'steal' && isOnline) {
    sendAttack('steal');
  }

  // Online Attacks
  if (isOnline) {
    if (streak === 3) sendAttack('fake');
    else if (streak === 5) sendAttack('shake');
    else if (streak === 8) sendAttack('speed');
  }

  if (streak % 1 === 0) currentLevelIdx++;
  updateFirebaseState(true);

  updateSelectorUI();
  updateBestScore();
  UI.lastScore.innerText = currentCommand === 'ignore' ? 'pass' : rt + 'ms';

  showResult(rt, currentCommand === 'ignore' ? 'passed' : null);
  updateSidebar();

  autoNextTimeout = setTimeout(() => {
    if (state === 'RESULT') startGame();
  }, 500);
}

function clearFeedbackUI() {
  document.querySelectorAll('.floating-text').forEach(e => e.remove());
  UI.gameArea.className = '';
  document.body.classList.remove('screen-shake', 'screen-shake-small');
  UI.targetStatus.innerText = '';
}

function wipeTargets() {
  document.querySelectorAll('.decoy-target').forEach(el => el.remove());
  const tw = document.getElementById('target-wrapper');
  if (tw) {
    tw.style.transition = 'none';
    tw.style.transform = 'translate(-50%, -50%)';
  }
  clearFeedbackUI();
}

function grantScore(e, elapsed, basePoints, typeText) {
  let isPerfect = elapsed < 200;
  if (isPerfect && basePoints > 0) basePoints += 1; 
  let pMult = (streak >= 10) ? 2.0 : (streak >= 5) ? 1.5 : 1.0;
  let pts = Math.floor(basePoints * pMult);
  score += pts;
  
  let tColor = isPerfect ? '#ff00ff' : 'var(--green)';
  let pre = isPerfect ? `PERFECT x${pMult}! ` : (pMult > 1.0 ? `x${pMult} ` : '');
  let tText = `${pre}${typeText} +${pts}`;
  
  spawnFloatingText(e, tText, tColor);
}

function resetGameState() {
  clearAllTimers();
  activeTarget.resolved = true;
  holdActive = false; doublePending = false;
  hasShield = false;
  UI.holdProgress.style.width = '0'; UI.holdProgress.style.height = '0';
  streak = 0;
  score = 0;
  speedModRounds = 0;
  speedModifier = 1.0;
  const activeBtn = Array.from(UI.diffBtns).find(b => b.classList.contains('active'));
  currentLevelIdx = activeBtn ? parseInt(activeBtn.dataset.level) - 1 : 0;
  wipeTargets();
}

function winGame(reason) {
  resetGameState();
  UI.diffContainer.style.opacity = '1';
  UI.diffContainer.style.pointerEvents = 'auto';

  state = 'RESULT';
  UI.gameArea.className = 'state-success';

  flashScreen('white');
  playSuccess();

  UI.targetStatus.innerText = 'victory.';
  UI.statusPanel.innerText = reason;
  UI.statusPanel.style.color = 'var(--text-main)';

  UI.resultTime.innerText = 'WIN';
  UI.resultTime.style.color = 'var(--green)';
  UI.resultRank.innerText = 'survivor';
  UI.resultRank.className = 'rank-godlike';

  UI.resultDisplay.classList.remove('hidden');

  updateFirebaseState(true);
  updateSelectorUI();
  updateSidebar();

  UI.mainBtn.style.opacity = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = 'return to lobby';
}

function failGame(reason) {
  if (hasShield) {
    hasShield = false;
    clearAllTimers();
    document.body.classList.remove('screen-shake-small');
    UI.modeBadge.innerText = isOnline ? 'online versus' : 'offline mode';
    
    triggerCenterAlert('shield broken!');
    spawnFloatingText(null, 'SAVED!', '#ffd700');
    
    autoNextTimeout = setTimeout(() => {
      startGame();
    }, 1000);
    return;
  }

  resetGameState();

  UI.diffContainer.style.opacity = '1';
  UI.diffContainer.style.pointerEvents = 'auto';

  state = 'RESULT';
  resultStartTime = performance.now();
  UI.gameArea.className = 'state-start';
  document.body.classList.add('screen-shake');

  flashScreen('red');
  playFail();

  UI.targetStatus.innerText = 'you died.';
  UI.statusPanel.innerText = reason;
  UI.statusPanel.style.color = 'var(--red)';

  UI.resultTime.innerText = `SCORE: ${score}`;
  UI.resultTime.style.color = 'var(--red)';
  UI.resultRank.innerText = reason;
  UI.resultRank.className = 'rank-slow';

  UI.resultDisplay.classList.remove('hidden');

  updateFirebaseState(false);
  updateSelectorUI();
  updateSidebar();

  UI.mainBtn.style.opacity = '1';
  UI.mainBtn.style.pointerEvents = 'auto';
  UI.mainBtn.innerText = isOnline ? 'return to lobby' : 'REMATCH';
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
  UI.streakCounter.innerText = score;
  
  const scLabel = document.getElementById('streak-counter').previousElementSibling;
  if (scLabel) scLabel.innerText = 'SCORE';
  
  const bLabel = document.getElementById('best-score').previousElementSibling;
  if (bLabel) bLabel.innerText = 'BEST SCORE';
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

function handleBackgroundClick(e) {
  if (e) {
    if (e.cancelable) e.preventDefault();
  }
  initAudio();
  if (state === 'START' || state === 'RESULT') {
    if (state === 'RESULT' && performance.now() - resultStartTime < 300) return;
    if (!isOnline) {
      startGame();
    } else {
      if (myPlayerRef) update(myPlayerRef, { ready: false, alive: true, streak: 0 });
      if (isHost && roomRef) update(roomRef, { state: 'lobby', gameStarted: false });
      showLobbyInfo();
      showScreen('screen-lobby');
      state = 'START';
      resetGameState(); 
    }
  } else if (state === 'WAIT') {
    if (performance.now() >= targetFireTime - 80) {
      clearTimeout(waitTimeout);
      clearInterval(beepInterval);
      firePhase();
      activeTarget.resolved = true;
      failGame('missed target.');
    } else {
      failGame('too early.');
    }
  } else if (state === 'FIRE') {
    if (!activeTarget.resolved) {
      activeTarget.resolved = true;
      failGame('missed target.');
    }
  }
}

function handleInputDown(e) {
  if (e) {
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }
  initAudio();
  if (state === 'START' || state === 'RESULT') {
    if (state === 'RESULT' && performance.now() - resultStartTime < 300) return;
    if (!isOnline) {
      startGame();
    } else {
      if (myPlayerRef) update(myPlayerRef, { ready: false, alive: true, streak: 0 });
      if (isHost && roomRef) update(roomRef, { state: 'lobby', gameStarted: false });
      showLobbyInfo();
      showScreen('screen-lobby');
      state = 'START';
      resetGameState();
    }
  } else if (state === 'WAIT') {
    if (performance.now() >= targetFireTime - 80) {
      clearTimeout(waitTimeout);
      clearInterval(beepInterval);
      firePhase();
    } else {
      failGame('too early.');
      return;
    }
  }

  if (state === 'FIRE') {
    if (activeTarget.resolved) return;

    const targetOuter = document.getElementById('target-outer');
    if (targetOuter) {
      targetOuter.style.transform = 'scale(0.8)';
      setTimeout(() => targetOuter.style.transform = '', 150);
    }

    const elapsed = performance.now() - activeTarget.spawnedAt;

    if (currentCommand === 'ignore') {
      activeTarget.resolved = true;
      failGame('bamboozled.');
    } else if (currentCommand === 'fire') {
      if (elapsed <= activeTarget.allowedTime) {
        activeTarget.resolved = true;
        grantScore(e, elapsed, 1, 'HIT');
        successGame();
      } else {
        activeTarget.resolved = true;
        failGame('too slow.');
      }
    } else if (currentCommand === 'double') {
      if (!doublePending) {
        doublePending = true;
        clearTimeout(fireTimeout); 
        doubleTimeout = setTimeout(() => {
           if (!activeTarget.resolved) {
              activeTarget.resolved = true;
              failGame('too slow.');
           }
        }, 350); 
      } else {
        clearTimeout(doubleTimeout);
        if (elapsed <= activeTarget.allowedTime + 350) {
          activeTarget.resolved = true;
          grantScore(e, elapsed, 2, 'DOUBLE');
          successGame();
        } else {
          activeTarget.resolved = true;
          failGame('too slow.');
        }
      }
    } else if (currentCommand === 'hold') {
      holdActive = true;
      UI.holdProgress.style.width = '150px';
      UI.holdProgress.style.height = '150px';
      holdTimeout = setTimeout(() => {
        if (holdActive && !activeTarget.resolved) {
          activeTarget.resolved = true;
          grantScore(e, elapsed, 3, 'HELD');
          successGame();
        }
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
    
    if (!activeTarget.resolved) {
      activeTarget.resolved = true;
      failGame('held too short.');
    }
  }
}

// --- LISTENERS END SETUP ---

const tw = document.getElementById('target-wrapper');
tw.addEventListener('mousedown', handleInputDown);
tw.addEventListener('touchstart', handleInputDown, { passive: false });

UI.clickLayer.addEventListener('mousedown', handleBackgroundClick);
UI.clickLayer.addEventListener('touchstart', handleBackgroundClick, { passive: false });

document.addEventListener('mouseup', handleInputUp);
document.addEventListener('touchend', handleInputUp);

UI.mainBtn.addEventListener('mousedown', handleInputDown);
UI.mainBtn.addEventListener('touchstart', handleInputDown, { passive: false });

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
Lobby.btnOffline.addEventListener('click', (e) => { initAudio(); enterGameMode(false); });
Lobby.btnOnline.addEventListener('click', (e) => { initAudio(); showScreen('screen-lobby'); });

Lobby.btnCreate.addEventListener('click', createRoom);
Lobby.btnJoin.addEventListener('click', () => {
  const code = Lobby.roomInput.value.trim();
  if (code.length === 4) joinRoom(code);
});

Lobby.btnReady.addEventListener('click', async () => {
  if (myPlayerRef) await update(myPlayerRef, { ready: true });
});

Lobby.btnStart.addEventListener('click', async () => {
  console.log('[Lobby] Host clicked Start Game');
  Lobby.btnStart.disabled = true;
  Lobby.btnStart.classList.add('hidden');
  
  if (isHost && roomRef) {
    try {
      console.log('[Lobby] Pushing start data to Firebase...');
      await update(roomRef, {
        state: 'starting',
        gameStarted: true,
        startedAt: Date.now(),
        countdownEnd: Date.now() + 3000
      });
      console.log('[Lobby] Successfully wrote start state to Firebase.');
    } catch (e) {
      console.error('[Lobby] Firebase Error on Start Game:', e);
      Lobby.btnStart.disabled = false;
      Lobby.btnStart.classList.remove('hidden');
    }
  } else {
    console.error('[Lobby] Start failed: not host, or roomRef is missing.', { isHost, hasRef: !!roomRef });
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
