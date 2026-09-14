import * as THREE from "./vendor/three.module.min.js";
import {
  WORLD,
  BALL_RADIUS,
  PHYSICS,
  clamp,
  createMaze,
  gravityFromAngles,
  holeCaptureRadius,
  stepAir,
  stepBall
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
  installButton: document.querySelector("#installButton")
};

const TOUCH_TILT = Math.sin(10 * Math.PI / 180);
const app = {
  level: 1,
  maze: createMaze(0x71a6),
  ball: { x: 0, y: 0, vx: 0, vy: 0, airHeight: 0, verticalVelocity: 0 },
  mode: "ready",
  elapsed: 0,
  fallUntil: 0,
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
    lastMotionZ: 0,
    jumpCooldown: 0,
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
    return Number(localStorage.getItem("tilt-lab-best-v2") || 0);
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
  const z = Number(event.acceleration?.z);
  if (!Number.isFinite(z)) return;
  const jerk = Math.abs(z - app.sensor.lastMotionZ);
  app.sensor.lastMotionZ = z;
  const liftStrength = Math.max(Math.abs(z), jerk * 0.62);
  if (liftStrength >= 4.4 && app.sensor.gravityZ > 0.28) requestJump(liftStrength);
}

function requestJump(strength = 6) {
  const now = performance.now();
  if (app.mode !== "playing" || app.ball.airHeight > 0 || now < app.sensor.jumpCooldown) return;
  const launchSpeed = clamp(390 + (strength - 4.4) * 72, 390, 760);
  app.ball.airHeight = 0.1;
  app.ball.verticalVelocity = launchSpeed;
  app.sensor.jumpCooldown = now + 680;
  playTone(260, .055, "triangle", .026);
  haptic(12);
  showToast("LIFT JUMP");
}

async function enableTilt() {
  primeAudio();
  let orientationGranted = true;
  let motionGranted = true;
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

  if (orientationGranted && "DeviceOrientationEvent" in window) {
    window.addEventListener("deviceorientation", handleOrientation, true);
    if (motionGranted && "DeviceMotionEvent" in window) window.addEventListener("devicemotion", handleMotion, true);
    setInputStatus("SET FLAT", "live");
    setTimeout(() => {
      if (!app.sensor.seen) {
        setInputStatus("TOUCH READY", "touch");
        showToast("No motion data — drag to tilt", 2600);
      }
    }, 1800);
  } else {
    setInputStatus("TOUCH READY", "touch");
    showToast("Motion unavailable — drag to tilt", 2600);
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
  if (app.touch.active) {
    x = app.touch.x * TOUCH_TILT;
    y = app.touch.y * TOUCH_TILT;
    z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    viewPitch = Math.asin(y);
    viewRoll = Math.asin(x);
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
  }
  app.lastGravity.x += (x - app.lastGravity.x) * 0.18;
  app.lastGravity.y += (y - app.lastGravity.y) * 0.18;
  app.lastGravity.z += (z - app.lastGravity.z) * 0.18;
  app.lastGravity.viewPitch = viewPitch;
  app.lastGravity.viewRoll = viewRoll;
  return { x, y, z, viewPitch, viewRoll };
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
  if (app.ballMesh) {
    app.ballMesh.visible = true;
    app.ballMesh.scale.setScalar(1);
    app.ballMesh.quaternion.identity();
  }
  ui.winPanel.classList.remove("active");
  updateHud();
}

function beginFall(now, message) {
  if (app.mode !== "playing") return;
  app.mode = "falling";
  app.fallUntil = now + 760;
  app.ball.vx = 0;
  app.ball.vy = 0;
  app.ball.airHeight = 0;
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

  if (gravity.z < -0.02 && app.ball.airHeight <= 0) {
    beginFall(now, "BALL LEFT THE BOARD");
    updateScene(dt, now, gravity);
    return;
  }

  app.elapsed += dt;
  const steps = Math.max(1, Math.ceil(dt / (1 / 180)));
  let impact = 0;
  let landed = false;
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
    landed = stepAir(app.ball, stepTime) || landed;
  }

  if (landed) {
    playTone(190, .04, "triangle", .025);
    haptic(8);
  }

  if (impact > 72 && now > app.impactCooldown) {
    app.impactCooldown = now + 95;
    playTone(850 + Math.min(impact, 250) * 1.8, 0.024, "sine", 0.018);
    haptic(6);
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
    try { localStorage.setItem("tilt-lab-best-v2", app.elapsed.toString()); } catch { /* optional persistence */ }
  }
  ui.resultTime.textContent = formatTime(app.elapsed);
  ui.resultCopy.textContent = `${app.maze.hazards.length} holes + ${app.maze.gaps.length} jump gaps · ${app.maze.turns} turns · ${isBest ? "new best" : `best ${formatTime(previous)}`}`;
  ui.winPanel.classList.add("active");
  playWinSound();
  haptic([22, 35, 22, 35, 75]);
}

function makeWoodTexture() {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 512;
  textureCanvas.height = 1024;
  const wood = textureCanvas.getContext("2d");
  const base = wood.createLinearGradient(0, 0, 512, 0);
  base.addColorStop(0, "#7a431f");
  base.addColorStop(.24, "#a86732");
  base.addColorStop(.53, "#8b4d25");
  base.addColorStop(.78, "#b17038");
  base.addColorStop(1, "#74401f");
  wood.fillStyle = base;
  wood.fillRect(0, 0, 512, 1024);

  const random = (() => {
    let state = 0x51a7f00d;
    return () => {
      state = Math.imul(state ^ (state >>> 15), state | 1);
      return ((state ^ (state >>> 13)) >>> 0) / 4294967296;
    };
  })();
  for (let index = 0; index < 180; index += 1) {
    const x = random() * 512;
    const width = .35 + random() * 2.2;
    const bend = (random() - .5) * 75;
    wood.beginPath();
    wood.moveTo(x, -10);
    wood.bezierCurveTo(x + bend, 270, x - bend * .7, 730, x + bend * .35, 1034);
    wood.strokeStyle = index % 4 === 0 ? `rgba(52,24,10,${.07 + random() * .08})` : `rgba(255,210,143,${.025 + random() * .045})`;
    wood.lineWidth = width;
    wood.stroke();
  }
  for (let index = 0; index < 14; index += 1) {
    const x = random() * 512;
    const y = random() * 1024;
    wood.strokeStyle = "rgba(55,25,10,.17)";
    wood.lineWidth = 1.4;
    wood.beginPath();
    wood.ellipse(x, y, 12 + random() * 30, 4 + random() * 8, random() * .25, 0, Math.PI * 2);
    wood.stroke();
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
  app.renderer.toneMappingExposure = 1.04;

  app.scene = new THREE.Scene();
  app.scene.background = new THREE.Color(0x171009);
  app.camera = new THREE.PerspectiveCamera(38, 1, 1, 2200);
  app.camera.position.set(0, 810, 650);
  app.camera.lookAt(0, 0, -8);

  app.scene.add(new THREE.HemisphereLight(0xffe4ba, 0x1b100a, 1.65));
  app.keyLight = new THREE.DirectionalLight(0xffe0ae, 3.7);
  app.keyLight.position.set(-240, 430, 210);
  app.keyLight.castShadow = true;
  app.keyLight.shadow.mapSize.set(1024, 1024);
  app.keyLight.shadow.camera.left = -280;
  app.keyLight.shadow.camera.right = 280;
  app.keyLight.shadow.camera.top = 380;
  app.keyLight.shadow.camera.bottom = -380;
  app.scene.add(app.keyLight);
  const rim = new THREE.DirectionalLight(0x9fc8d2, 1.2);
  rim.position.set(260, 170, -420);
  app.scene.add(rim);

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshStandardMaterial({ color: 0x160d08, roughness: .94 })
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -35;
  table.receiveShadow = true;
  app.scene.add(table);

  const woodTexture = makeWoodTexture();
  app.materials = {
    board: new THREE.MeshStandardMaterial({ map: woodTexture, color: 0xb8753d, roughness: .68, metalness: 0 }),
    wall: new THREE.MeshStandardMaterial({ map: woodTexture, color: 0x8e532d, roughness: .6, metalness: 0 }),
    frame: new THREE.MeshStandardMaterial({ map: woodTexture, color: 0x6e381c, roughness: .55, metalness: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x090706, roughness: .92 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb8863d, roughness: .3, metalness: .78 }),
    steel: new THREE.MeshPhysicalMaterial({ color: 0xdde2e2, metalness: 1, roughness: .12, clearcoat: 1, clearcoatRoughness: .08 }),
    ink: new THREE.MeshBasicMaterial({ color: 0x3d2414, transparent: true, opacity: .72, depthWrite: false })
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
  marker.fillStyle = "rgba(244,222,180,.82)";
  marker.beginPath();
  marker.arc(48, 48, 26, 0, Math.PI * 2);
  marker.fill();
  marker.strokeStyle = "rgba(72,40,19,.75)";
  marker.lineWidth = 5;
  marker.stroke();
  marker.fillStyle = "#3d2414";
  marker.font = "bold 38px Georgia";
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

  board.add(box(WORLD.width + 48, 18, WORLD.height + 48, app.materials.frame, 0, -13, 0));
  board.add(box(WORLD.width + 12, 7, WORLD.height + 12, app.materials.board, 0, -3.5, 0));
  const railHeight = 30;
  const railWidth = 19;
  board.add(box(WORLD.width + 48, railHeight, railWidth, app.materials.frame, 0, 4, -WORLD.height / 2 - 15));
  board.add(box(WORLD.width + 48, railHeight, railWidth, app.materials.frame, 0, 4, WORLD.height / 2 + 15));
  board.add(box(railWidth, railHeight, WORLD.height + 30, app.materials.frame, -WORLD.width / 2 - 15, 4, 0));
  board.add(box(railWidth, railHeight, WORLD.height + 30, app.materials.frame, WORLD.width / 2 + 15, 4, 0));

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
      new THREE.CylinderGeometry(hazard.radius, hazard.radius * .82, 8, 36),
      app.materials.dark
    );
    well.position.set(position.x, -3.8, position.z);
    well.receiveShadow = true;
    board.add(well);
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(hazard.radius + .8, 1.35, 8, 36),
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
    new THREE.MeshStandardMaterial({ color: 0x6c8a61, roughness: .5, metalness: .25, side: THREE.DoubleSide })
  );
  startRing.rotation.x = -Math.PI / 2;
  startRing.position.set(start.x, .55, start.z);
  startRing.userData.disposableMaterial = true;
  board.add(startRing);

  const goal = worldPosition(app.maze.goal.x, app.maze.goal.y);
  const goalWell = new THREE.Mesh(new THREE.CylinderGeometry(13, 11, 8, 36), app.materials.dark);
  goalWell.position.set(goal.x, -3.8, goal.z);
  board.add(goalWell);
  const goalRing = new THREE.Mesh(new THREE.TorusGeometry(14.2, 2.1, 10, 40), app.materials.brass);
  goalRing.rotation.x = Math.PI / 2;
  goalRing.position.set(goal.x, .35, goal.z);
  goalRing.castShadow = true;
  board.add(goalRing);

  app.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 22), app.materials.steel);
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
    height -= progress * 30;
    app.ballMesh.scale.setScalar(1 - progress * .18);
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
  const follow = Math.min(1, dt * 9);
  app.board.rotation.x = lerpAngle(app.board.rotation.x, gravity.viewPitch, follow);
  app.board.rotation.z = lerpAngle(app.board.rotation.z, -gravity.viewRoll, follow);
  app.keyLight.position.x = -240 - gravity.x * 260;
  app.keyLight.position.z = 210 - gravity.y * 260;
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
  if (app.touch.active && event.pointerId !== app.touch.pointerId) {
    requestJump(7);
    return;
  }
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
  if (event.code === "Space") {
    event.preventDefault();
    requestJump(7);
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
