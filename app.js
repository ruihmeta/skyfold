import * as THREE from "./vendor/three.module.min.js";
import {
  WORLD,
  BALL_RADIUS,
  PHYSICS,
  clamp,
  createMaze,
  gravityFromAngles,
  holeCaptureRadius,
  stepBall,
  stepVerticalPhysics
} from "./physics.js";

const canvas = document.querySelector("#gameCanvas");
const frame = document.querySelector("#gameFrame");
const ui = {
  timer: document.querySelector("#timer"),
  sensorStatus: document.querySelector("#sensorStatus"),
  sensorDot: document.querySelector("#sensorDot"),
  levelLabel: document.querySelector("#levelLabel"),
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
  installButton: document.querySelector("#installButton"),
  motionButton: document.querySelector("#motionButton"),
  jumpButton: document.querySelector("#jumpButton")
};

const TOUCH_TILT = Math.sin(10 * Math.PI / 180);
const app = {
  level: 1,
  maze: createMaze(0x71a6),
  ball: { x: 0, y: 0, vx: 0, vy: 0, airHeight: 0, verticalVelocity: 0 },
  mode: "ready",
  elapsed: 0,
  fallUntil: 0,
  fallStartHeight: 0,
  sensor: {
    latestBeta: null,
    latestGamma: null,
    biasBeta: 0,
    biasGamma: 0,
    gravityX: 0,
    gravityY: 0,
    gravityZ: 1,
    pitch: 0,
    roll: 0,
    normalAcceleration: 0,
    motionBaseline: null,
    motionAt: 0,
    motionSeen: false,
    orientationListening: false,
    motionListening: false,
    seen: false
  },
  touch: { active: false, pointerId: null, originX: 0, originY: 0, x: 0, y: 0 },
  keys: new Set(),
  lastFrame: performance.now(),
  impactCooldown: 0,
  soundEnabled: true,
  audio: null,
  deferredInstall: null,
  wakeLock: null,
  renderer: null,
  scene: null,
  camera: null,
  board: null,
  ballMesh: null,
  keyLight: null,
  materials: null,
  lastGravity: { x: 0, y: 0, z: 1, viewPitch: 0, viewRoll: 0 }
};

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

function readBest() {
  try {
    return Number(localStorage.getItem("skyfold-best-v1") || 0);
  } catch {
    return 0;
  }
}

function updateHud() {
  ui.timer.textContent = formatTime(app.elapsed);
  ui.levelLabel.textContent = app.level.toString().padStart(2, "0");
  const degrees = Math.acos(clamp(app.lastGravity.z, -1, 1)) * 180 / Math.PI;
  if (app.ball.airHeight > 1) {
    ui.sensorStatus.textContent = `AIR ${Math.round(app.ball.airHeight)}`;
  } else if (app.sensor.seen && app.mode !== "ready") {
    ui.sensorStatus.textContent = `${degrees.toFixed(1)}° TILT`;
  }
  ui.tiltMarker.style.transform = `translate(${clamp(app.lastGravity.x / TOUCH_TILT, -1, 1) * 29}px, ${clamp(app.lastGravity.y / TOUCH_TILT, -1, 1) * 12}px)`;
}

function setInputStatus(label, mode) {
  ui.sensorStatus.textContent = label;
  ui.sensorDot.className = `status-dot ${mode || ""}`;
}

function showToast(message, duration = 1700) {
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
  const gravity = gravityFromAngles(
    event.beta - sensor.biasBeta,
    event.gamma - sensor.biasGamma,
    getOrientationAngle()
  );
  sensor.gravityX += (gravity.x - sensor.gravityX) * 0.22;
  sensor.gravityY += (gravity.y - sensor.gravityY) * 0.22;
  sensor.gravityZ += (gravity.z - sensor.gravityZ) * 0.22;
  let pitch = (event.beta - sensor.biasBeta) * Math.PI / 180;
  let roll = (event.gamma - sensor.biasGamma) * Math.PI / 180;
  const angle = ((getOrientationAngle() % 360) + 360) % 360;
  if (angle === 90) [pitch, roll] = [-roll, pitch];
  if (angle === 270) [pitch, roll] = [roll, -pitch];
  if (angle === 180) [pitch, roll] = [-pitch, -roll];
  sensor.pitch = pitch;
  sensor.roll = roll;
  if (!sensor.seen) {
    sensor.seen = true;
    setInputStatus("0.0° TILT", "live");
    showToast("True horizontal is zero");
  }
}

function handleMotion(event) {
  const direct = event.acceleration?.z == null ? Number.NaN : Number(event.acceleration.z);
  const includingGravity = event.accelerationIncludingGravity?.z == null ? Number.NaN : Number(event.accelerationIncludingGravity.z);
  let z = direct;
  if (!Number.isFinite(z) && Number.isFinite(includingGravity)) {
    if (app.sensor.motionBaseline == null) app.sensor.motionBaseline = includingGravity;
    app.sensor.motionBaseline += (includingGravity - app.sensor.motionBaseline) * .035;
    z = includingGravity - app.sensor.motionBaseline;
  }
  if (!Number.isFinite(z)) return;
  app.sensor.normalAcceleration += (clamp(z, -30, 30) - app.sensor.normalAcceleration) * .62;
  app.sensor.motionAt = performance.now();
  app.sensor.motionSeen = true;
}

function applyJumpImpulse() {
  if (app.mode !== "playing" || app.ball.airHeight > .5) return;
  app.ball.airHeight = .1;
  app.ball.verticalVelocity = Math.max(app.ball.verticalVelocity, 520);
  playTone(290, .055, "triangle", .026);
  haptic(12);
  showToast("JUMP");
}

async function requestMotionAccess(startGame) {
  primeAudio();
  let orientationGranted = "DeviceOrientationEvent" in window;
  let motionGranted = "DeviceMotionEvent" in window;
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      orientationGranted = (await DeviceOrientationEvent.requestPermission()) === "granted";
    }
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      motionGranted = (await DeviceMotionEvent.requestPermission()) === "granted";
    }
  } catch {
    orientationGranted = false;
    motionGranted = false;
  }

  if (orientationGranted) {
    if (!app.sensor.orientationListening) {
      window.addEventListener("deviceorientation", handleOrientation, true);
      app.sensor.orientationListening = true;
    }
    if (motionGranted && !app.sensor.motionListening) {
      window.addEventListener("devicemotion", handleMotion, true);
      app.sensor.motionListening = true;
    }
    setInputStatus("SET FLAT", "live");
    setTimeout(() => {
      if (!app.sensor.seen) {
        setInputStatus("TOUCH READY", "touch");
        showToast("No motion data — drag to tilt", 2600);
      }
    }, 1800);
  } else {
    setInputStatus("TOUCH READY", "touch");
    showToast("Motion blocked — allow it in browser settings, then retry", 4200);
  }
  ui.motionButton.hidden = false;
  const fullyConnected = orientationGranted && motionGranted;
  ui.motionButton.textContent = fullyConnected ? "MOTION ✓" : "RETRY MOTION";
  ui.motionButton.classList.toggle("connected", fullyConnected);
  if (!fullyConnected && orientationGranted) showToast("Tilt enabled · motion lift blocked · tap RETRY after changing settings", 4200);
  if (startGame) beginGame();
}

function enableTilt() { requestMotionAccess(true); }
function retryMotionAccess() { requestMotionAccess(false); }

function beginTouchMode() {
  primeAudio();
  setInputStatus("TOUCH READY", "touch");
  ui.motionButton.hidden = false;
  beginGame();
}

function beginGame() {
  ui.startPanel.classList.remove("active");
  resetRun();
  requestWakeLock();
}

function setCurrentSurfaceAsLevel() {
  if (app.sensor.latestBeta == null) {
    showToast("Motion not active — horizontal remains zero");
    return;
  }
  app.sensor.biasBeta = app.sensor.latestBeta;
  app.sensor.biasGamma = app.sensor.latestGamma;
  app.sensor.gravityX = 0;
  app.sensor.gravityY = 0;
  app.sensor.gravityZ = 1;
  app.sensor.pitch = 0;
  app.sensor.roll = 0;
  app.sensor.normalAcceleration = 0;
  app.ball.vx *= 0.2;
  app.ball.vy *= 0.2;
  haptic(10);
  showToast("Current surface set to level");
}

function getGravityInput() {
  let x = app.sensor.gravityX;
  let y = app.sensor.gravityY;
  let z = app.sensor.gravityZ;
  let viewPitch = app.sensor.pitch;
  let viewRoll = app.sensor.roll;
  if (performance.now() - app.sensor.motionAt > 90) app.sensor.normalAcceleration *= .78;
  let normalAcceleration = app.sensor.normalAcceleration;
  if (app.touch.active) {
    x = app.touch.x * TOUCH_TILT;
    y = app.touch.y * TOUCH_TILT;
    z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    viewPitch = Math.asin(y);
    viewRoll = Math.asin(x);
    normalAcceleration = 0;
  }
  let keyboardX = 0;
  let keyboardY = 0;
  if (app.keys.has("ArrowLeft") || app.keys.has("KeyA")) keyboardX -= 1;
  if (app.keys.has("ArrowRight") || app.keys.has("KeyD")) keyboardX += 1;
  if (app.keys.has("ArrowUp") || app.keys.has("KeyW")) keyboardY -= 1;
  if (app.keys.has("ArrowDown") || app.keys.has("KeyS")) keyboardY += 1;
  if (keyboardX || keyboardY) {
    x = clamp(keyboardX, -1, 1) * TOUCH_TILT;
    y = clamp(keyboardY, -1, 1) * TOUCH_TILT;
    z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    viewPitch = Math.asin(y);
    viewRoll = Math.asin(x);
    normalAcceleration = 0;
  }
  app.lastGravity.x += (x - app.lastGravity.x) * 0.18;
  app.lastGravity.y += (y - app.lastGravity.y) * 0.18;
  app.lastGravity.z += (z - app.lastGravity.z) * 0.18;
  app.lastGravity.viewPitch = viewPitch;
  app.lastGravity.viewRoll = viewRoll;
  return { x, y, z, viewPitch, viewRoll, normalAcceleration };
}

function resetRun({ newMaze = false } = {}) {
  if (newMaze) {
    app.level += 1;
    app.maze = createMaze(0x71a6 + app.level * 104729);
    rebuildBoard();
  }
  Object.assign(app.ball, {
    x: app.maze.start.x,
    y: app.maze.start.y,
    vx: 0,
    vy: 0,
    airHeight: 0,
    verticalVelocity: 0
  });
  app.elapsed = 0;
  app.mode = "playing";
  app.fallStartHeight = 0;
  if (app.ballMesh) {
    app.ballMesh.visible = true;
    app.ballMesh.scale.setScalar(1);
    app.ballMesh.quaternion.identity();
  }
  ui.winPanel.classList.remove("active");
  updateHud();
}

function beginFall(now, message, preserveHeight = false) {
  if (app.mode !== "playing") return;
  app.mode = "falling";
  app.fallUntil = now + 760;
  app.ball.vx = 0;
  app.ball.vy = 0;
  app.fallStartHeight = preserveHeight ? app.ball.airHeight : 0;
  app.ball.airHeight = app.fallStartHeight;
  app.ball.verticalVelocity = 0;
  playFallSound();
  haptic([28, 34, 65]);
  showToast(message);
}

function update(dt, now) {
  const gravity = getGravityInput();
  if (app.mode === "falling") {
    if (now >= app.fallUntil) {
      Object.assign(app.ball, {
        x: app.maze.start.x,
        y: app.maze.start.y,
        vx: 0,
        vy: 0,
        airHeight: 0,
        verticalVelocity: 0
      });
      app.elapsed += 2;
      app.mode = "playing";
      app.fallStartHeight = 0;
      app.ballMesh.visible = true;
      app.ballMesh.scale.setScalar(1);
      showToast("Back to start · +2.0s");
    }
    updateScene(dt, now, gravity);
    return;
  }
  if (app.mode !== "playing") {
    updateScene(dt, now, gravity);
    return;
  }

  app.elapsed += dt;
  const steps = Math.max(1, Math.ceil(dt / (1 / 180)));
  let impact = 0;
  let landed = false;
  let liftOff = false;
  let landingImpact = 0;
  for (let index = 0; index < steps; index += 1) {
    const stepTime = dt / steps;
    const airborne = app.ball.airHeight > 0;
    const clearsWalls = app.ball.airHeight > PHYSICS.wallHeight + 1;
    impact = Math.max(impact, stepBall(
      app.ball,
      gravity,
      clearsWalls ? [] : app.maze.walls,
      stepTime,
      BALL_RADIUS,
      !airborne
    ));
    const vertical = stepVerticalPhysics(app.ball, gravity.z, gravity.normalAcceleration, stepTime);
    landed = vertical.landed || landed;
    liftOff = vertical.liftOff || liftOff;
    landingImpact = Math.max(landingImpact, vertical.impact);
  }

  if (liftOff) {
    playTone(310, .04, "sine", .014);
    haptic(5);
  }
  if (landed) {
    playTone(170 + Math.min(landingImpact, 500) * .22, .045, "triangle", .024);
    haptic(landingImpact > 220 ? 10 : 5);
  }

  if (impact > 72 && now > app.impactCooldown) {
    app.impactCooldown = now + 95;
    playTone(850 + Math.min(impact, 250) * 1.8, 0.024, "sine", 0.018);
    haptic(6);
  }

  if (app.ball.airHeight > 86 && gravity.z < -.05) {
    beginFall(now, "LOST TO THE SKY", true);
  }

  const outsideBoard = app.ball.x < -BALL_RADIUS * 2 ||
    app.ball.x > WORLD.width + BALL_RADIUS * 2 ||
    app.ball.y < -BALL_RADIUS * 2 ||
    app.ball.y > WORLD.height + BALL_RADIUS * 2;
  if (outsideBoard) {
    beginFall(now, "BALL LEFT THE BOARD");
  } else if (app.ball.airHeight < 1.5) {
    for (const hazard of app.maze.hazards) {
      const captureRadius = holeCaptureRadius(hazard.radius);
      if (Math.hypot(app.ball.x - hazard.x, app.ball.y - hazard.y) < captureRadius) {
        beginFall(now, "IN THE HOLE");
        break;
      }
    }
    if (app.mode === "playing") {
      for (const gap of app.maze.gaps) {
        const crossesGap = app.ball.x > gap.x && app.ball.x < gap.x + gap.width &&
          app.ball.y > gap.y && app.ball.y < gap.y + gap.height;
        if (crossesGap) {
          beginFall(now, "MISSED THE GAP");
          break;
        }
      }
    }
  }

  if (app.mode === "playing" && app.ball.airHeight < 2 && Math.hypot(app.ball.x - app.maze.goal.x, app.ball.y - app.maze.goal.y) < 13) finishRun();
  updateScene(dt, now, gravity);
  updateHud();
}

function finishRun() {
  if (app.mode !== "playing") return;
  app.mode = "won";
  const previous = readBest();
  const isBest = !previous || app.elapsed < previous;
  if (isBest) {
    try { localStorage.setItem("skyfold-best-v1", app.elapsed.toString()); } catch { /* optional persistence */ }
  }
  ui.resultTime.textContent = formatTime(app.elapsed);
  ui.resultCopy.textContent = `${app.maze.hazards.length} wells + ${app.maze.gaps.length} sky gaps · ${app.maze.turns} turns · ${isBest ? "new best" : `best ${formatTime(previous)}`}`;
  ui.winPanel.classList.add("active");
  playWinSound();
  haptic([22, 35, 22, 35, 75]);
}

function makeWoodTexture() {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 512;
  textureCanvas.height = 1024;
  const context = textureCanvas.getContext("2d");
  const base = context.createLinearGradient(0, 0, 512, 0);
  base.addColorStop(0, "#7a431f");
  base.addColorStop(.24, "#a86732");
  base.addColorStop(.53, "#8b4d25");
  base.addColorStop(.78, "#b17038");
  base.addColorStop(1, "#74401f");
  context.fillStyle = base;
  context.fillRect(0, 0, 512, 1024);
  let state = 0x5f3759df;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    return ((state ^ (state >>> 13)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < 170; index += 1) {
    const x = random() * 512;
    const bend = (random() - .5) * 62;
    context.beginPath();
    context.moveTo(x, -20);
    context.bezierCurveTo(x + bend, 300, x - bend * .7, 700, x + bend * .25, 1044);
    context.strokeStyle = index % 4 === 0 ? `rgba(52,24,10,${.07 + random() * .08})` : `rgba(255,210,143,${.025 + random() * .045})`;
    context.lineWidth = .5 + random() * 2;
    context.stroke();
  }
  for (let index = 0; index < 12; index += 1) {
    context.beginPath();
    context.ellipse(random() * 512, random() * 1024, 12 + random() * 28, 4 + random() * 7, random() * .3, 0, Math.PI * 2);
    context.strokeStyle = "rgba(55,25,10,.17)";
    context.lineWidth = 1.4;
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, app.renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function initialize3D() {
  app.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  app.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
  app.renderer.shadowMap.enabled = true;
  app.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  app.renderer.toneMappingExposure = 1.02;
  app.renderer.setClearColor(0x171009, 1);

  app.scene = new THREE.Scene();
  app.scene.background = new THREE.Color(0x171009);
  app.scene.fog = new THREE.Fog(0x171009, 1180, 2100);
  app.camera = new THREE.PerspectiveCamera(38, 1, 1, 2400);
  app.camera.position.set(0, 1080, 24);
  app.camera.up.set(0, 0, -1);
  app.camera.lookAt(0, 0, 0);

  app.scene.add(new THREE.AmbientLight(0xfff7e8, 1.65));
  app.scene.add(new THREE.HemisphereLight(0xfff4dc, 0x8294a3, 2.15));
  app.keyLight = new THREE.DirectionalLight(0xffe1b5, 3.4);
  app.keyLight.position.set(-330, 560, 280);
  app.keyLight.castShadow = true;
  app.keyLight.shadow.mapSize.set(1536, 1536);
  app.keyLight.shadow.bias = -.00018;
  app.keyLight.shadow.normalBias = .055;
  app.keyLight.shadow.camera.left = -410;
  app.keyLight.shadow.camera.right = 410;
  app.keyLight.shadow.camera.top = 470;
  app.keyLight.shadow.camera.bottom = -470;
  app.scene.add(app.keyLight);
  const fill = new THREE.DirectionalLight(0xb8d7e5, 1.65);
  fill.position.set(420, 260, -460);
  app.scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffd4a3, 1.15);
  rim.position.set(-260, 180, -500);
  app.scene.add(rim);

  const woodTexture = makeWoodTexture();
  const woodMaterial = (color, roughness) => new THREE.MeshStandardMaterial({
    map: woodTexture,
    color,
    roughness,
    metalness: 0,
    emissive: new THREE.Color(color).multiplyScalar(.045),
    emissiveIntensity: 1,
    side: THREE.DoubleSide
  });
  app.materials = {
    board: woodMaterial(0xb8753d, .68),
    wall: woodMaterial(0x8e532d, .6),
    frame: woodMaterial(0x6e381c, .55),
    under: woodMaterial(0x74401f, .64),
    dark: new THREE.MeshStandardMaterial({ color: 0x090706, emissive: 0x090604, emissiveIntensity: .22, roughness: .92, side: THREE.DoubleSide }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb8863d, emissive: 0x2a1805, emissiveIntensity: .12, roughness: .3, metalness: .78, side: THREE.DoubleSide }),
    mint: new THREE.MeshStandardMaterial({ color: 0x6d8f6b, emissive: 0x102010, emissiveIntensity: .12, roughness: .6, side: THREE.DoubleSide }),
    foliage: woodMaterial(0x9b6037, .7),
    orb: new THREE.MeshPhysicalMaterial({ color: 0xdde2e2, emissive: 0x101414, emissiveIntensity: .08, metalness: 1, roughness: .12, clearcoat: 1, clearcoatRoughness: .08, side: THREE.DoubleSide }),
    ink: new THREE.MeshBasicMaterial({ color: 0x493025, transparent: true, opacity: .78, depthWrite: false, side: THREE.DoubleSide })
  };
  rebuildBoard();
  resizeRenderer();
}

function worldPosition(x, y) {
  return { x: x - WORLD.width / 2, z: y - WORLD.height / 2 };
}

function box(width, height, depth, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeNumberMarker(number, x, z) {
  const markerCanvas = document.createElement("canvas");
  markerCanvas.width = 96;
  markerCanvas.height = 96;
  const marker = markerCanvas.getContext("2d");
  marker.fillStyle = "rgba(247,225,184,.9)";
  marker.beginPath();
  marker.arc(48, 48, 26, 0, Math.PI * 2);
  marker.fill();
  marker.strokeStyle = "rgba(83,48,27,.8)";
  marker.lineWidth = 4;
  marker.stroke();
  marker.fillStyle = "#432819";
  marker.font = "bold 36px Georgia";
  marker.textAlign = "center";
  marker.textBaseline = "middle";
  marker.fillText(String(number), 48, 50);
  const texture = new THREE.CanvasTexture(markerCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(17, 17), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, .75, z);
  mesh.userData.disposableMaterial = true;
  return mesh;
}

function disposeBoard() {
  if (!app.board) return;
  app.scene.remove(app.board);
  app.board.traverse((object) => {
    object.geometry?.dispose();
    if (object.userData.disposableMaterial) {
      object.material.map?.dispose();
      object.material.dispose();
    }
  });
}

function rebuildBoard() {
  disposeBoard();
  const board = new THREE.Group();
  board.rotation.order = "YXZ";
  app.scene.add(board);
  app.board = board;

  board.add(box(WORLD.width + 48, 18, WORLD.height + 48, app.materials.under, 0, -18, 0));
  board.add(box(WORLD.width + 36, 15, WORLD.height + 36, app.materials.frame, 0, -11, 0));
  board.add(box(WORLD.width + 10, 8, WORLD.height + 10, app.materials.board, 0, -4, 0));
  const railHeight = 30;
  const railWidth = 18;
  board.add(box(WORLD.width + 46, railHeight, railWidth, app.materials.frame, 0, 4, -WORLD.height / 2 - 14));
  board.add(box(WORLD.width + 46, railHeight, railWidth, app.materials.frame, 0, 4, WORLD.height / 2 + 14));
  board.add(box(railWidth, railHeight, WORLD.height + 28, app.materials.frame, -WORLD.width / 2 - 14, 4, 0));
  board.add(box(railWidth, railHeight, WORLD.height + 28, app.materials.frame, WORLD.width / 2 + 14, 4, 0));

  const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
  const wallInstances = new THREE.InstancedMesh(wallGeometry, app.materials.wall, app.maze.walls.length);
  wallInstances.castShadow = true;
  wallInstances.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  app.maze.walls.forEach((wall, index) => {
    const position = worldPosition(wall.x + wall.width / 2, wall.y + wall.height / 2);
    matrix.compose(
      new THREE.Vector3(position.x, 8.5, position.z),
      new THREE.Quaternion(),
      new THREE.Vector3(wall.width, 17, wall.height)
    );
    wallInstances.setMatrixAt(index, matrix);
  });
  wallInstances.instanceMatrix.needsUpdate = true;
  board.add(wallInstances);

  const screwGeometry = new THREE.CylinderGeometry(3.2, 3.2, 1.5, 20);
  for (const [x, z] of [[-190,-320],[190,-320],[-190,320],[190,320]]) {
    const screw = new THREE.Mesh(screwGeometry, app.materials.brass);
    screw.position.set(x, 5.5, z);
    screw.castShadow = true;
    board.add(screw);
  }

  for (const hazard of app.maze.hazards) {
    const position = worldPosition(hazard.x, hazard.y);
    const well = new THREE.Mesh(
      new THREE.CylinderGeometry(hazard.radius, hazard.radius * .82, 9, 30),
      app.materials.dark
    );
    well.position.set(position.x, -3.8, position.z);
    well.receiveShadow = true;
    board.add(well);
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(hazard.radius + .8, 1.35, 8, 30),
      app.materials.frame
    );
    lip.rotation.x = Math.PI / 2;
    lip.position.set(position.x, .25, position.z);
    lip.castShadow = true;
    board.add(lip);
    const markerOffsetX = hazard.x < WORLD.width / 2 ? -17 : 17;
    board.add(makeNumberMarker(hazard.id, position.x + markerOffsetX, position.z));
  }

  for (const gap of app.maze.gaps) {
    const position = worldPosition(gap.x + gap.width / 2, gap.y + gap.height / 2);
    const opening = box(gap.width, 5.5, gap.height, app.materials.dark, position.x, -1.7, position.z);
    opening.receiveShadow = true;
    board.add(opening);
    const longHorizontal = gap.width > gap.height;
    const edgeLength = longHorizontal ? gap.width : gap.height;
    const edgeOffset = (longHorizontal ? gap.height : gap.width) / 2 + 1.2;
    for (const side of [-1, 1]) {
      board.add(box(
        longHorizontal ? edgeLength : 2.2,
        1.4,
        longHorizontal ? 2.2 : edgeLength,
        app.materials.brass,
        position.x + (longHorizontal ? 0 : edgeOffset * side),
        .8,
        position.z + (longHorizontal ? edgeOffset * side : 0)
      ));
    }
  }

  const start = worldPosition(app.maze.start.x, app.maze.start.y);
  const startRing = new THREE.Mesh(
    new THREE.RingGeometry(13, 16, 40),
    app.materials.mint
  );
  startRing.rotation.x = -Math.PI / 2;
  startRing.position.set(start.x, .55, start.z);
  board.add(startRing);

  const goal = worldPosition(app.maze.goal.x, app.maze.goal.y);
  const goalWell = new THREE.Mesh(new THREE.CylinderGeometry(13, 11, 8, 30), app.materials.dark);
  goalWell.position.set(goal.x, -3.8, goal.z);
  board.add(goalWell);
  const goalRing = new THREE.Mesh(new THREE.TorusGeometry(14.2, 2.1, 8, 32), app.materials.brass);
  goalRing.rotation.x = Math.PI / 2;
  goalRing.position.set(goal.x, .35, goal.z);
  goalRing.castShadow = true;
  board.add(goalRing);

  app.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 22), app.materials.orb);
  app.ballMesh.castShadow = true;
  app.ballMesh.receiveShadow = true;
  board.add(app.ballMesh);
  Object.assign(app.ball, {
    x: app.maze.start.x,
    y: app.maze.start.y,
    vx: 0,
    vy: 0,
    airHeight: 0,
    verticalVelocity: 0
  });
  updateBallMesh(0, performance.now());
}

const rollAxis = new THREE.Vector3();
const rollQuaternion = new THREE.Quaternion();
function updateBallMesh(dt, now) {
  if (!app.ballMesh) return;
  const position = worldPosition(app.ball.x, app.ball.y);
  let height = BALL_RADIUS + .8 + app.ball.airHeight;
  if (app.mode === "falling") {
    const progress = clamp(1 - (app.fallUntil - now) / 760, 0, 1);
    height = BALL_RADIUS + .8 + app.fallStartHeight - progress * (app.fallStartHeight + 72);
    app.ballMesh.scale.setScalar(1 - progress * .32);
  }
  app.ballMesh.position.set(position.x, height, position.z);
  const speed = Math.hypot(app.ball.vx, app.ball.vy);
  if (speed > .01 && dt > 0 && app.mode === "playing") {
    rollAxis.set(app.ball.vy, 0, -app.ball.vx).normalize();
    rollQuaternion.setFromAxisAngle(rollAxis, speed * dt / BALL_RADIUS);
    app.ballMesh.quaternion.premultiply(rollQuaternion);
  }
}

function lerpAngle(current, target, amount) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * amount;
}

function updateScene(dt, now, gravity) {
  if (!app.board) return;
  const follow = 1 - Math.exp(-dt * 8.5);
  app.board.rotation.x = lerpAngle(app.board.rotation.x, gravity.viewPitch, follow);
  app.board.rotation.z = lerpAngle(app.board.rotation.z, -gravity.viewRoll, follow);
  app.board.rotation.y = lerpAngle(app.board.rotation.y, 0, follow);
  updateBallMesh(dt, now);
}

function resizeRenderer() {
  if (!app.renderer) return;
  const rect = frame.getBoundingClientRect();
  app.renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
  app.camera.aspect = Math.max(.45, rect.width / Math.max(1, rect.height));
  app.camera.updateProjectionMatrix();
}

function animationFrame(now) {
  const dt = Math.min((now - app.lastFrame) / 1000, 0.04);
  app.lastFrame = now;
  update(dt, now);
  app.renderer.render(app.scene, app.camera);
  requestAnimationFrame(animationFrame);
}

function pointerDown(event) {
  if (app.mode !== "playing") return;
  if (app.touch.active) return;
  frame.setPointerCapture(event.pointerId);
  const rect = frame.getBoundingClientRect();
  Object.assign(app.touch, {
    active: true,
    pointerId: event.pointerId,
    originX: event.clientX,
    originY: event.clientY,
    x: 0,
    y: 0
  });
  ui.joystick.style.left = `${event.clientX - rect.left}px`;
  ui.joystick.style.top = `${event.clientY - rect.top}px`;
  ui.joystick.classList.add("active");
}

function pointerMove(event) {
  if (!app.touch.active || event.pointerId !== app.touch.pointerId) return;
  const dx = event.clientX - app.touch.originX;
  const dy = event.clientY - app.touch.originY;
  app.touch.x = clamp(dx / 56, -1, 1);
  app.touch.y = clamp(dy / 56, -1, 1);
  const length = Math.hypot(dx, dy);
  const ratio = length > 25 ? 25 / length : 1;
  ui.joystick.firstElementChild.style.transform = `translate(${dx * ratio}px, ${dy * ratio}px)`;
}

function pointerUp(event) {
  if (event.pointerId !== app.touch.pointerId) return;
  Object.assign(app.touch, { active: false, pointerId: null, x: 0, y: 0 });
  ui.joystick.classList.remove("active");
  ui.joystick.firstElementChild.style.transform = "";
}

function primeAudio() {
  if (!app.audio) app.audio = new (window.AudioContext || window.webkitAudioContext)();
  if (app.audio.state === "suspended") app.audio.resume();
}

function playTone(frequency, duration, type = "sine", volume = 0.025, delay = 0) {
  if (!app.soundEnabled || !app.audio) return;
  const start = app.audio.currentTime + delay;
  const oscillator = app.audio.createOscillator();
  const gain = app.audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(app.audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playFallSound() {
  playTone(180, .12, "triangle", .035);
  playTone(95, .32, "sine", .045, .08);
}

function playWinSound() {
  [392, 523.25, 659.25, 783.99].forEach((note, index) => playTone(note, .28, "sine", .04, index * .085));
}

function haptic(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) app.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Optional enhancement.
  }
}

function toggleSound() {
  app.soundEnabled = !app.soundEnabled;
  ui.soundButton.textContent = app.soundEnabled ? "♪" : "×";
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
  if (event.code === "Space") {
    event.preventDefault();
    applyJumpImpulse();
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
    event.preventDefault();
    app.keys.add(event.code);
  }
});
window.addEventListener("keyup", (event) => app.keys.delete(event.code));
window.addEventListener("resize", resizeRenderer);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && app.mode === "playing") requestWakeLock();
});
frame.addEventListener("pointerdown", pointerDown);
frame.addEventListener("pointermove", pointerMove);
frame.addEventListener("pointerup", pointerUp);
frame.addEventListener("pointercancel", pointerUp);
ui.startButton.addEventListener("click", enableTilt);
ui.touchButton.addEventListener("click", beginTouchMode);
ui.calibrateButton.addEventListener("click", setCurrentSurfaceAsLevel);
ui.resetButton.addEventListener("click", () => { resetRun(); showToast("Board restarted"); });
ui.nextButton.addEventListener("click", () => resetRun({ newMaze: true }));
ui.retryButton.addEventListener("click", () => resetRun());
ui.soundButton.addEventListener("click", toggleSound);
ui.installButton.addEventListener("click", installApp);
ui.motionButton.addEventListener("click", retryMotionAccess);
ui.jumpButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  applyJumpImpulse();
});

if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches) {
  ui.installButton.hidden = false;
}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));

try {
  initialize3D();
  updateHud();
  requestAnimationFrame(animationFrame);
} catch (error) {
  console.error(error);
  ui.startPanel.querySelector("h1").textContent = "3D unavailable";
  ui.startPanel.querySelector("p:not(.eyebrow)").textContent = "This browser could not start WebGL. Try current Safari or Chrome.";
  ui.startButton.hidden = true;
  ui.touchButton.hidden = true;
}
