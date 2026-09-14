import { WORLD, clamp, createMaze, stepBall } from "./physics.js";

const canvas = document.querySelector("#gameCanvas");
const frame = document.querySelector("#gameFrame");
const ctx = canvas.getContext("2d", { alpha: false });
const ui = {
  timer: document.querySelector("#timer"),
  sensorStatus: document.querySelector("#sensorStatus"),
  sensorDot: document.querySelector("#sensorDot"),
  pickupCount: document.querySelector("#pickupCount"),
  startPanel: document.querySelector("#startPanel"),
  winPanel: document.querySelector("#winPanel"),
  resultTime: document.querySelector("#resultTime"),
  resultCopy: document.querySelector("#resultCopy"),
  toast: document.querySelector("#toast"),
  joystick: document.querySelector("#joystick"),
  tiltMarker: document.querySelector("#tiltMarker"),
  startButton: document.querySelector("#startButton"),
  touchButton: document.querySelector("#touchButton"),
  calibrateButton: document.querySelector("#calibrateButton"),
  resetButton: document.querySelector("#resetButton"),
  nextButton: document.querySelector("#nextButton"),
  retryButton: document.querySelector("#retryButton"),
  soundButton: document.querySelector("#soundButton"),
  installButton: document.querySelector("#installButton")
};

const BALL_RADIUS = 10;
const app = {
  level: 1,
  maze: createMaze(0x71a6),
  ball: { x: 0, y: 0, vx: 0, vy: 0 },
  mode: "ready",
  elapsed: 0,
  fallUntil: 0,
  sensor: { latestBeta: null, latestGamma: null, baseBeta: null, baseGamma: null, x: 0, y: 0, seen: false },
  touch: { active: false, pointerId: null, originX: 0, originY: 0, x: 0, y: 0 },
  keys: new Set(),
  particles: [],
  lastFrame: performance.now(),
  impactCooldown: 0,
  soundEnabled: true,
  audio: null,
  deferredInstall: null,
  wakeLock: null,
  view: { scale: 1, offsetX: 0, offsetY: 0, dpr: 1 }
};

function resetRun({ newMaze = false } = {}) {
  if (newMaze) {
    app.level += 1;
    app.maze = createMaze(0x71a6 + app.level * 7919);
  } else {
    app.maze.pickups.forEach((pickup) => { pickup.collected = false; });
  }
  Object.assign(app.ball, { x: app.maze.start.x, y: app.maze.start.y, vx: 0, vy: 0 });
  app.elapsed = 0;
  app.mode = "playing";
  app.particles.length = 0;
  ui.winPanel.classList.remove("active");
  updateHud();
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

function updateHud() {
  ui.timer.textContent = formatTime(app.elapsed);
  const collected = app.maze.pickups.filter((pickup) => pickup.collected).length;
  ui.pickupCount.textContent = `${collected} / ${app.maze.pickups.length}`;
  ui.tiltMarker.style.transform = `translate(${app.sensor.x * 29}px, ${app.sensor.y * 12}px)`;
}

function setInputStatus(label, mode) {
  ui.sensorStatus.textContent = label;
  ui.sensorDot.className = `status-dot ${mode || ""}`;
}

function showToast(message, duration = 1600) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => ui.toast.classList.remove("show"), duration);
}

function getOrientationAngle() {
  return screen.orientation?.angle ?? window.orientation ?? 0;
}

function handleOrientation(event) {
  if (event.beta == null || event.gamma == null) return;
  const sensor = app.sensor;
  sensor.latestBeta = event.beta;
  sensor.latestGamma = event.gamma;
  if (sensor.baseBeta == null || sensor.baseGamma == null) {
    sensor.baseBeta = event.beta;
    sensor.baseGamma = event.gamma;
  }
  let beta = clamp(event.beta - sensor.baseBeta, -32, 32);
  let gamma = clamp(event.gamma - sensor.baseGamma, -32, 32);
  const angle = ((getOrientationAngle() % 360) + 360) % 360;
  let x = gamma;
  let y = beta;
  if (angle === 90) [x, y] = [beta, -gamma];
  if (angle === 270) [x, y] = [-beta, gamma];
  if (angle === 180) [x, y] = [-gamma, -beta];
  const deadZone = 1.4;
  const normalize = (value) => Math.abs(value) < deadZone ? 0 : clamp(value / 19, -1, 1);
  sensor.x += (normalize(x) - sensor.x) * 0.24;
  sensor.y += (normalize(y) - sensor.y) * 0.24;
  if (!sensor.seen) {
    sensor.seen = true;
    setInputStatus("TILT LIVE", "live");
    showToast("Tilt calibrated");
  }
}

async function enableTilt() {
  primeAudio();
  let granted = true;
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      granted = (await DeviceOrientationEvent.requestPermission()) === "granted";
    }
  } catch {
    granted = false;
  }

  if (granted && "DeviceOrientationEvent" in window) {
    window.addEventListener("deviceorientation", handleOrientation, true);
    setInputStatus("CALIBRATING", "live");
    setTimeout(() => {
      if (!app.sensor.seen) {
        setInputStatus("TOUCH READY", "touch");
        showToast("No motion data — drag to steer", 2600);
      }
    }, 1800);
  } else {
    setInputStatus("TOUCH READY", "touch");
    showToast("Motion unavailable — drag to steer", 2600);
  }
  beginGame();
}

function beginTouchMode() {
  primeAudio();
  setInputStatus("TOUCH READY", "touch");
  beginGame();
}

function beginGame() {
  ui.startPanel.classList.remove("active");
  resetRun();
  requestWakeLock();
}

function calibrate() {
  if (app.sensor.latestBeta == null) {
    showToast("Move your phone or drag to steer");
    return;
  }
  app.sensor.baseBeta = app.sensor.latestBeta;
  app.sensor.baseGamma = app.sensor.latestGamma;
  app.sensor.x = 0;
  app.sensor.y = 0;
  app.ball.vx *= 0.25;
  app.ball.vy *= 0.25;
  haptic(10);
  showToast("Center reset");
}

function getCombinedInput() {
  let x = app.sensor.x;
  let y = app.sensor.y;
  if (app.touch.active) {
    x = app.touch.x;
    y = app.touch.y;
  }
  if (app.keys.has("ArrowLeft") || app.keys.has("KeyA")) x -= 1;
  if (app.keys.has("ArrowRight") || app.keys.has("KeyD")) x += 1;
  if (app.keys.has("ArrowUp") || app.keys.has("KeyW")) y -= 1;
  if (app.keys.has("ArrowDown") || app.keys.has("KeyS")) y += 1;
  return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
}

function update(dt, now) {
  if (app.mode === "falling") {
    if (now >= app.fallUntil) {
      Object.assign(app.ball, { x: app.maze.start.x, y: app.maze.start.y, vx: 0, vy: 0 });
      app.elapsed += 2;
      app.mode = "playing";
      showToast("Gravity reset · +2.0s");
    }
    return;
  }
  if (app.mode !== "playing") return;

  app.elapsed += dt;
  const input = getCombinedInput();
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  let impact = 0;
  for (let index = 0; index < steps; index += 1) {
    impact = Math.max(impact, stepBall(app.ball, input, app.maze.walls, dt / steps, BALL_RADIUS));
  }

  if (impact > 95 && now > app.impactCooldown) {
    app.impactCooldown = now + 110;
    playTone(105 + Math.min(impact, 240), 0.018, "triangle", 0.022);
    haptic(7);
  }

  if (Math.hypot(app.ball.vx, app.ball.vy) > 30) {
    app.particles.push({ x: app.ball.x, y: app.ball.y, life: 0.45, size: 2.5 });
    if (app.particles.length > 38) app.particles.shift();
  }
  app.particles.forEach((particle) => { particle.life -= dt; });
  app.particles = app.particles.filter((particle) => particle.life > 0);

  for (const pickup of app.maze.pickups) {
    if (!pickup.collected && Math.hypot(app.ball.x - pickup.x, app.ball.y - pickup.y) < 20) {
      pickup.collected = true;
      playTone(660, 0.08, "sine", 0.04);
      haptic([12, 20, 12]);
      showToast("Energy cell recovered");
    }
  }

  for (const hazard of app.maze.hazards) {
    if (Math.hypot(app.ball.x - hazard.x, app.ball.y - hazard.y) < hazard.radius * 0.72) {
      app.mode = "falling";
      app.fallUntil = now + 620;
      app.ball.vx = 0;
      app.ball.vy = 0;
      playTone(90, 0.28, "sawtooth", 0.045);
      haptic([30, 30, 55]);
      break;
    }
  }

  if (Math.hypot(app.ball.x - app.maze.goal.x, app.ball.y - app.maze.goal.y) < 18) finishRun();
  updateHud();
}

function finishRun() {
  if (app.mode !== "playing") return;
  app.mode = "won";
  const collected = app.maze.pickups.filter((pickup) => pickup.collected).length;
  const key = "tilt-lab-best";
  const previous = Number(localStorage.getItem(key) || 0);
  const isBest = !previous || app.elapsed < previous;
  if (isBest) localStorage.setItem(key, app.elapsed.toString());
  ui.resultTime.textContent = formatTime(app.elapsed);
  ui.resultCopy.textContent = `${collected}/${app.maze.pickups.length} energy cells · ${isBest ? "new best run" : `best ${formatTime(previous)}`}`;
  ui.winPanel.classList.add("active");
  playWinSound();
  haptic([25, 35, 25, 35, 80]);
}

function resizeCanvas() {
  const rect = frame.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const scale = Math.min(rect.width / WORLD.width, rect.height / WORLD.height);
  app.view = {
    dpr,
    scale,
    offsetX: (rect.width - WORLD.width * scale) / 2,
    offsetY: (rect.height - WORLD.height * scale) / 2
  };
}

function render(now) {
  const { dpr, scale, offsetX, offsetY } = app.view;
  const cssWidth = canvas.width / dpr;
  const cssHeight = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const background = ctx.createRadialGradient(cssWidth * .5, cssHeight * .35, 20, cssWidth * .5, cssHeight * .5, cssHeight * .75);
  background.addColorStop(0, "#10243a");
  background.addColorStop(0.7, "#07101c");
  background.addColorStop(1, "#03070d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  drawBoard(now);
}

function drawBoard(now) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, WORLD.width, WORLD.height);
  ctx.clip();

  ctx.fillStyle = "#07121f";
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  const floorGlow = ctx.createRadialGradient(app.ball.x, app.ball.y, 3, app.ball.x, app.ball.y, 115);
  floorGlow.addColorStop(0, "rgba(75,226,241,.12)");
  floorGlow.addColorStop(1, "rgba(17,54,77,0)");
  ctx.fillStyle = floorGlow;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  ctx.strokeStyle = "rgba(98,145,171,.055)";
  ctx.lineWidth = 1;
  for (let x = app.maze.cellWidth; x < WORLD.width; x += app.maze.cellWidth) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD.height); ctx.stroke();
  }
  for (let y = app.maze.cellHeight; y < WORLD.height; y += app.maze.cellHeight) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD.width, y); ctx.stroke();
  }

  for (const hazard of app.maze.hazards) drawHazard(hazard, now);
  drawGoal(app.maze.goal, now);
  app.maze.pickups.forEach((pickup) => { if (!pickup.collected) drawPickup(pickup, now); });

  ctx.shadowColor = "rgba(71,167,204,.38)";
  ctx.shadowBlur = 10;
  for (const wall of app.maze.walls) {
    const gradient = ctx.createLinearGradient(wall.x, wall.y, wall.x + wall.width, wall.y + wall.height);
    gradient.addColorStop(0, "#49677d");
    gradient.addColorStop(.45, "#1f3a50");
    gradient.addColorStop(1, "#10263a");
    ctx.fillStyle = gradient;
    ctx.fillRect(wall.x, wall.y, wall.width, wall.height);
    ctx.fillStyle = "rgba(163,224,241,.18)";
    ctx.fillRect(wall.x, wall.y, Math.max(1, wall.width - 1), Math.min(1.2, wall.height));
  }
  ctx.shadowBlur = 0;

  app.particles.forEach((particle) => {
    ctx.globalAlpha = particle.life * 0.55;
    ctx.fillStyle = "#55f4ff";
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size * particle.life, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  drawBall(now);
  ctx.restore();
}

function drawHazard(hazard, now) {
  const pulse = 1 + Math.sin(now * 0.004 + hazard.x) * 0.08;
  const gradient = ctx.createRadialGradient(hazard.x - 4, hazard.y - 5, 1, hazard.x, hazard.y, hazard.radius * 1.45);
  gradient.addColorStop(0, "#020205");
  gradient.addColorStop(.55, "#030207");
  gradient.addColorStop(.72, "#48142b");
  gradient.addColorStop(1, "rgba(255,70,114,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(hazard.x, hazard.y, hazard.radius * 1.45 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,91,126,.36)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(hazard.x, hazard.y, hazard.radius * (1.1 + (now % 1100) / 2400), 0, Math.PI * 2);
  ctx.stroke();
}

function drawPickup(pickup, now) {
  const pulse = 0.82 + Math.sin(now * 0.006 + pickup.id) * 0.18;
  ctx.save();
  ctx.translate(pickup.x, pickup.y);
  ctx.rotate(now * 0.001 + pickup.id);
  ctx.shadowColor = "#55f4ff";
  ctx.shadowBlur = 13 * pulse;
  ctx.strokeStyle = `rgba(85,244,255,${0.65 + pulse * .25})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(-5, -5, 10, 10);
  ctx.fillStyle = "rgba(85,244,255,.55)";
  ctx.fillRect(-2.5, -2.5, 5, 5);
  ctx.restore();
}

function drawGoal(goal, now) {
  const pulse = 0.5 + Math.sin(now * 0.004) * 0.5;
  ctx.save();
  ctx.translate(goal.x, goal.y);
  ctx.shadowColor = "#ffd267";
  ctx.shadowBlur = 17 + pulse * 8;
  ctx.strokeStyle = "#ffd267";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 15 + pulse * 1.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,210,103,.38)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 23 + pulse * 4, now * .001, now * .001 + Math.PI * 1.45);
  ctx.stroke();
  ctx.restore();
}

function drawBall(now) {
  const fallingProgress = app.mode === "falling" ? clamp(1 - (app.fallUntil - now) / 620, 0, 1) : 0;
  const scale = app.mode === "falling" ? 1 - fallingProgress * .82 : 1;
  ctx.save();
  ctx.translate(app.ball.x, app.ball.y);
  ctx.scale(scale, scale);
  ctx.shadowColor = "#55f4ff";
  ctx.shadowBlur = 17;
  const gradient = ctx.createRadialGradient(-3.5, -4, 1, 0, 0, BALL_RADIUS);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(.2, "#c8fcff");
  gradient.addColorStop(.58, "#53e8f2");
  gradient.addColorStop(1, "#08758c");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.72)";
  ctx.beginPath();
  ctx.arc(-3.5, -4, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function animationFrame(now) {
  const dt = Math.min((now - app.lastFrame) / 1000, 0.04);
  app.lastFrame = now;
  update(dt, now);
  render(now);
  requestAnimationFrame(animationFrame);
}

function pointerDown(event) {
  if (app.mode !== "playing") return;
  frame.setPointerCapture(event.pointerId);
  const rect = frame.getBoundingClientRect();
  app.touch.active = true;
  app.touch.pointerId = event.pointerId;
  app.touch.originX = event.clientX;
  app.touch.originY = event.clientY;
  app.touch.x = 0;
  app.touch.y = 0;
  ui.joystick.style.left = `${event.clientX - rect.left}px`;
  ui.joystick.style.top = `${event.clientY - rect.top}px`;
  ui.joystick.classList.add("active");
}

function pointerMove(event) {
  if (!app.touch.active || event.pointerId !== app.touch.pointerId) return;
  const dx = event.clientX - app.touch.originX;
  const dy = event.clientY - app.touch.originY;
  app.touch.x = clamp(dx / 48, -1, 1);
  app.touch.y = clamp(dy / 48, -1, 1);
  const length = Math.hypot(dx, dy);
  const ratio = length > 25 ? 25 / length : 1;
  ui.joystick.firstElementChild.style.transform = `translate(${dx * ratio}px, ${dy * ratio}px)`;
}

function pointerUp(event) {
  if (event.pointerId !== app.touch.pointerId) return;
  app.touch.active = false;
  app.touch.pointerId = null;
  app.touch.x = 0;
  app.touch.y = 0;
  ui.joystick.classList.remove("active");
  ui.joystick.firstElementChild.style.transform = "";
}

function primeAudio() {
  if (!app.audio) app.audio = new (window.AudioContext || window.webkitAudioContext)();
  if (app.audio.state === "suspended") app.audio.resume();
}

function playTone(frequency, duration, type = "sine", volume = 0.03, delay = 0) {
  if (!app.soundEnabled || !app.audio) return;
  const start = app.audio.currentTime + delay;
  const oscillator = app.audio.createOscillator();
  const gain = app.audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(app.audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playWinSound() {
  [392, 523.25, 659.25, 783.99].forEach((note, index) => playTone(note, .28, "sine", .045, index * .09));
}

function haptic(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) app.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Wake lock is an enhancement; gameplay remains intact when unavailable.
  }
}

function toggleSound() {
  app.soundEnabled = !app.soundEnabled;
  ui.soundButton.textContent = app.soundEnabled ? "◉" : "○";
  showToast(app.soundEnabled ? "Sound on" : "Sound off");
  if (app.soundEnabled) primeAudio();
}

async function installApp() {
  if (app.deferredInstall) {
    app.deferredInstall.prompt();
    await app.deferredInstall.userChoice;
    app.deferredInstall = null;
    ui.installButton.hidden = true;
  } else {
    showToast("iPhone: Share → Add to Home Screen", 3000);
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  app.deferredInstall = event;
  ui.installButton.hidden = false;
});
window.addEventListener("appinstalled", () => { ui.installButton.hidden = true; });
window.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
    event.preventDefault();
    app.keys.add(event.code);
  }
});
window.addEventListener("keyup", (event) => app.keys.delete(event.code));
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && app.mode === "playing") requestWakeLock();
});
frame.addEventListener("pointerdown", pointerDown);
frame.addEventListener("pointermove", pointerMove);
frame.addEventListener("pointerup", pointerUp);
frame.addEventListener("pointercancel", pointerUp);
ui.startButton.addEventListener("click", enableTilt);
ui.touchButton.addEventListener("click", beginTouchMode);
ui.calibrateButton.addEventListener("click", calibrate);
ui.resetButton.addEventListener("click", () => { resetRun(); showToast("Run reset"); });
ui.nextButton.addEventListener("click", () => resetRun({ newMaze: true }));
ui.retryButton.addEventListener("click", () => resetRun());
ui.soundButton.addEventListener("click", toggleSound);
ui.installButton.addEventListener("click", installApp);

if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches) {
  ui.installButton.hidden = false;
}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));

Object.assign(app.ball, { x: app.maze.start.x, y: app.maze.start.y });
resizeCanvas();
updateHud();
requestAnimationFrame(animationFrame);
