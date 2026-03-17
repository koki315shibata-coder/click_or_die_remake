// script.js
// Game variables
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
  
  return params;
}

let state = 'START'; // START, WAIT, FIRE, RESULT
let currentLevelIdx = 0;
let streak = 0;
let bestScore = localStorage.getItem('cod_best_score') || null;

let waitTimeout = null;
let fireTimeout = null;
let autoNextTimeout = null;
let startTime = 0;

// UI Elements
const gameArea = document.getElementById('game-area');
const targetStatusText = document.getElementById('target-status-text');
const mainBtn = document.getElementById('main-btn');
const statusPanel = document.getElementById('status-panel');
const levelDisplay = document.getElementById('level-display');
const threatDisplay = document.getElementById('threat-display');
const bestScoreEl = document.getElementById('best-score');
const lastScoreEl = document.getElementById('last-score');
const streakCounterEl = document.getElementById('streak-counter');
const resultDisplay = document.getElementById('result-display');
const resultTimeEl = document.getElementById('result-time');
const resultRankEl = document.getElementById('result-rank');
const flashOverlay = document.getElementById('flash-overlay');
const difficultyContainer = document.getElementById('difficulty-selector-container');
const diffBtns = document.querySelectorAll('.diff-btn');
const clickLayer = document.getElementById('click-layer');

// Wait Phase Sound Interval
let beepInterval = null;

// Audio Context
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone(freq, type, duration, vol=0.1) {
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

function playLockOn() {
  playTone(800, 'sine', 0.1, 0.05);
}

function playFire() {
  playTone(200, 'square', 0.2, 0.2);
  playTone(150, 'sawtooth', 0.3, 0.2);
}

function playSuccess() {
  playTone(600, 'sine', 0.1, 0.1);
  setTimeout(() => playTone(800, 'sine', 0.3, 0.1), 100);
}

function playFail() {
  playTone(100, 'sawtooth', 0.5, 0.2);
}

// Game Logic
function resetUI() {
  resultDisplay.classList.add('hidden');
  document.body.classList.remove('screen-shake');
  
  // ensure flash overlay is cleared
  flashOverlay.className = '';
  void flashOverlay.offsetWidth;
}

function startGame() {
  if (autoNextTimeout) clearTimeout(autoNextTimeout);
  if (beepInterval) clearInterval(beepInterval);
  resetUI();
  
  state = 'WAIT';
  gameArea.className = 'state-wait';
  targetStatusText.innerText = 'waiting...';
  
  statusPanel.innerText = 'wait for it';
  statusPanel.style.color = 'var(--text-muted)';
  
  mainBtn.style.opacity = '0';
  mainBtn.style.pointerEvents = 'none';
  
  const lvlParams = getLevelParams(currentLevelIdx);
  difficultyContainer.style.opacity = '0.2';
  difficultyContainer.style.pointerEvents = 'none';
  
  // Set pulse duration CSS variable
  document.documentElement.style.setProperty('--pulse-dur', `${lvlParams.pulseDur}s`);

  // Delay logic scales with difficulty
  const minDelay = Math.max(800, 1500 - (currentLevelIdx * 50)); 
  const maxDelay = Math.min(6000, 3500 + (currentLevelIdx * 200));
  const delay = Math.random() * (maxDelay - minDelay) + minDelay;
  
  beepInterval = setInterval(playLockOn, 500);

  waitTimeout = setTimeout(() => {
    clearInterval(beepInterval);
    firePhase();
  }, delay);
}

function firePhase() {
  state = 'FIRE';
  gameArea.className = 'state-fire';
  targetStatusText.innerText = 'click!';
  
  statusPanel.innerText = 'now!';
  statusPanel.style.color = 'var(--green)';
  
  flashScreen('white');
  playFire();
  
  startTime = performance.now();
  
  const currentLevel = getLevelParams(currentLevelIdx);
  fireTimeout = setTimeout(() => {
    failGame('too slow.');
  }, currentLevel.window);
}

function successGame() {
  const rt = Math.floor(performance.now() - startTime);
  clearTimeout(fireTimeout);
  
  state = 'RESULT';
  gameArea.className = 'state-success';
  targetStatusText.innerText = 'nice.';
  
  statusPanel.innerText = 'survived.';
  statusPanel.style.color = 'var(--text-muted)';
  
  playSuccess();
  streak++;
  
  // Level progression
  if (streak % 1 === 0) {
    currentLevelIdx++;
  }

  updateSelectorUI();

  updateBestScore(rt);
  lastScoreEl.innerText = rt + 'ms';
  
  showResult(rt);
  updateSidebar();
  
  autoNextTimeout = setTimeout(() => {
    if (state === 'RESULT') startGame();
  }, 1200);
}

function failGame(reason) {
  clearTimeout(waitTimeout);
  clearTimeout(fireTimeout);
  if (beepInterval) clearInterval(beepInterval);
  
  // Show selector again
  difficultyContainer.style.opacity = '1';
  difficultyContainer.style.pointerEvents = 'auto';
  
  state = 'RESULT';
  gameArea.className = 'state-start'; // Reset visuals roughly
  document.body.classList.add('screen-shake');
  
  flashScreen('red');
  playFail();
  
  targetStatusText.innerText = 'you died.';
  
  statusPanel.innerText = reason;
  statusPanel.style.color = 'var(--red)';
  
  resultTimeEl.innerText = 'X';
  resultTimeEl.style.color = 'var(--red)';
  
  resultRankEl.innerText = reason;
  resultRankEl.className = 'rank-slow';
  
  resultDisplay.classList.remove('hidden');
  
  streak = 0;
  // If we fail on a high level, drop back to the level we manually started at (or 1)
  const activeBtn = Array.from(diffBtns).find(b => b.classList.contains('active'));
  currentLevelIdx = activeBtn ? parseInt(activeBtn.dataset.level) - 1 : 0;
  
  updateSelectorUI();
  updateSidebar();
  
  mainBtn.style.opacity = '1';
  mainBtn.style.pointerEvents = 'auto';
  mainBtn.innerText = 'try again';
}

function showResult(rt) {
  resultTimeEl.innerText = rt + 'ms';
  resultTimeEl.style.color = 'var(--text-main)';
  
  let rank = '';
  let rankClass = '';
  if (rt < 150) { rank = 'godlike'; rankClass = 'rank-godlike'; }
  else if (rt < 200) { rank = 'elite'; rankClass = 'rank-elite'; }
  else if (rt < 250) { rank = 'sharp'; rankClass = 'rank-sharp'; }
  else { rank = 'slow'; rankClass = 'rank-slow'; }
  
  resultRankEl.innerText = rank;
  resultRankEl.className = rankClass;
  resultDisplay.classList.remove('hidden');
}

function flashScreen(color) {
  flashOverlay.className = '';
  void flashOverlay.offsetWidth; // trigger reflow
  flashOverlay.className = color === 'white' ? 'flash-white' : 'flash-red';
}

function updateBestScore(rt) {
  if (!bestScore || rt < bestScore) {
    bestScore = rt;
    localStorage.setItem('cod_best_score', bestScore);
  }
}

function updateSidebar() {
  const lvlParams = getLevelParams(currentLevelIdx);
  levelDisplay.innerText = `level ${lvlParams.level} // ${lvlParams.name}`;
  threatDisplay.innerText = lvlParams.threat;
  
  if (bestScore) bestScoreEl.innerText = bestScore + 'ms';
  streakCounterEl.innerText = streak;
}

function updateSelectorUI() {
  diffBtns.forEach(btn => btn.classList.remove('active'));
  if (currentLevelIdx < 5) {
    const activeBtn = Array.from(diffBtns).find(b => parseInt(b.dataset.level) === (currentLevelIdx + 1));
    if (activeBtn) activeBtn.classList.add('active');
  }
}

// Event Listeners
diffBtns.forEach(btn => {
  const handler = (e) => {
    e.stopPropagation();
    if (state !== 'START' && state !== 'RESULT') return;
    
    currentLevelIdx = parseInt(e.target.dataset.level) - 1;
    streak = 0; 
    updateSelectorUI();
    updateSidebar();
    
    // reset button text 
    if (state === 'RESULT') {
        gameArea.className = 'state-start';
        targetStatusText.innerText = 'one miss and it ends.';
        resultDisplay.classList.add('hidden');
        mainBtn.innerText = 'play';
        statusPanel.innerText = 'ready.';
        statusPanel.style.color = 'var(--text-muted)';
        state = 'START';
    }
  };
  btn.addEventListener('mousedown', handler);
  btn.addEventListener('touchstart', handler);
});

function handleGameInteraction() {
  initAudio();
  if (state === 'START' || state === 'RESULT') {
    startGame();
  } else if (state === 'WAIT') {
    failGame('too early.');
  } else if (state === 'FIRE') {
    successGame();
  }
}

// Global click layer for the game interaction
clickLayer.addEventListener('mousedown', handleGameInteraction);
clickLayer.addEventListener('touchstart', (e) => {
    e.preventDefault(); 
    handleGameInteraction();
}, {passive: false});

// hook main btn too
mainBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    handleGameInteraction();
});
mainBtn.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleGameInteraction();
});

// Setup Initial UI
updateSidebar();
