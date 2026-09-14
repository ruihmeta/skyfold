export const WORLD = Object.freeze({ width: 360, height: 600 });
export const BALL_RADIUS = 8.5;
export const PHYSICS = Object.freeze({
  gravity: 9.80665,
  solidSphereFactor: 5 / 7,
  pixelsPerMeter: 460,
  rollingResistance: 0.008,
  airDrag: 0.00016,
  restitution: 0.28,
  wallFriction: 0.024,
  wallHeight: 17,
  surfaceMotionResponse: 1.65
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function cellIndex(col, row, cols) {
  return row * cols + col;
}

function carveMaze(seed, cols, rows) {
  const random = seededRandom(seed);
  const cells = Array.from({ length: cols * rows }, (_, index) => ({
    col: index % cols,
    row: Math.floor(index / cols),
    walls: [true, true, true, true],
    visited: false
  }));
  const startIndex = cellIndex(0, rows - 1, cols);
  const stack = [startIndex];
  cells[startIndex].visited = true;
  const directions = [
    { dc: 0, dr: -1, wall: 0, opposite: 2 },
    { dc: 1, dr: 0, wall: 1, opposite: 3 },
    { dc: 0, dr: 1, wall: 2, opposite: 0 },
    { dc: -1, dr: 0, wall: 3, opposite: 1 }
  ];

  while (stack.length) {
    const currentIndex = stack[stack.length - 1];
    const current = cells[currentIndex];
    const available = directions.filter(({ dc, dr }) => {
      const col = current.col + dc;
      const row = current.row + dr;
      return col >= 0 && col < cols && row >= 0 && row < rows && !cells[cellIndex(col, row, cols)].visited;
    });
    if (!available.length) {
      stack.pop();
      continue;
    }
    const direction = available[Math.floor(random() * available.length)];
    const nextIndex = cellIndex(current.col + direction.dc, current.row + direction.dr, cols);
    current.walls[direction.wall] = false;
    cells[nextIndex].walls[direction.opposite] = false;
    cells[nextIndex].visited = true;
    stack.push(nextIndex);
  }

  for (const cell of cells) delete cell.visited;
  return cells;
}

function countTurns(solution, cells) {
  let turns = 0;
  for (let index = 1; index < solution.length - 1; index += 1) {
    const previous = cells[solution[index - 1]];
    const current = cells[solution[index]];
    const next = cells[solution[index + 1]];
    const first = [current.col - previous.col, current.row - previous.row];
    const second = [next.col - current.col, next.row - current.row];
    if (first[0] !== second[0] || first[1] !== second[1]) turns += 1;
  }
  return turns;
}

export function createMaze(seed = 0x71a6, cols = 7, rows = 11) {
  const startIndex = cellIndex(0, rows - 1, cols);
  const goalIndex = cellIndex(cols - 1, 0, cols);
  let best = null;

  for (let attempt = 0; attempt < 96; attempt += 1) {
    const attemptSeed = seed + attempt * 7919;
    const cells = carveMaze(attemptSeed, cols, rows);
    const solution = findPath(cells, cols, rows, startIndex, goalIndex);
    const turns = countTurns(solution, cells);
    const score = solution.length + turns * 1.8;
    if (!best || score > best.score) best = { cells, solution, turns, score, attemptSeed };
    if (solution.length >= Math.floor(cols * rows * 0.48) && turns >= 12) break;
  }

  const { cells, solution, turns, attemptSeed } = best;
  const cellWidth = WORLD.width / cols;
  const cellHeight = WORLD.height / rows;
  const center = (index) => ({
    x: (cells[index].col + 0.5) * cellWidth,
    y: (cells[index].row + 0.5) * cellHeight
  });

  const hazards = placeRouteHazards(solution, cells, cellWidth, cellHeight, seed);
  return {
    seed: attemptSeed,
    cols,
    rows,
    cells,
    cellWidth,
    cellHeight,
    walls: buildWallRects(cells, cols, rows),
    start: center(startIndex),
    goal: center(goalIndex),
    solution,
    turns,
    hazards,
    gaps: placeRouteGaps(solution, cells, cellWidth, cellHeight, hazards),
    challengeScore: solution.length + turns * 2
  };
}

export function findPath(cells, cols, rows, startIndex, goalIndex) {
  const queue = [startIndex];
  const previous = new Map([[startIndex, null]]);
  const deltas = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  while (queue.length) {
    const currentIndex = queue.shift();
    if (currentIndex === goalIndex) break;
    const cell = cells[currentIndex];
    cell.walls.forEach((closed, direction) => {
      if (closed) return;
      const [dc, dr] = deltas[direction];
      const col = cell.col + dc;
      const row = cell.row + dr;
      if (col < 0 || col >= cols || row < 0 || row >= rows) return;
      const nextIndex = cellIndex(col, row, cols);
      if (!previous.has(nextIndex)) {
        previous.set(nextIndex, currentIndex);
        queue.push(nextIndex);
      }
    });
  }

  if (!previous.has(goalIndex)) return [];
  const path = [];
  for (let cursor = goalIndex; cursor !== null; cursor = previous.get(cursor)) path.push(cursor);
  return path.reverse();
}

export function placeRouteHazards(solution, cells, cellWidth, cellHeight, seed) {
  const candidates = [];
  for (let pathIndex = 3; pathIndex < solution.length - 3; pathIndex += 1) {
    const previous = cells[solution[pathIndex - 1]];
    const current = cells[solution[pathIndex]];
    const next = cells[solution[pathIndex + 1]];
    const incoming = { x: current.col - previous.col, y: current.row - previous.row };
    const outgoing = { x: next.col - current.col, y: next.row - current.row };
    const isTurn = incoming.x !== outgoing.x || incoming.y !== outgoing.y;
    candidates.push({ pathIndex, current, incoming, outgoing, isTurn });
  }

  const random = seededRandom(seed ^ 0xa53f19);
  const targetCount = Math.min(11, Math.max(7, Math.floor(solution.length / 4.6)));
  const selected = [];
  for (let slot = 0; slot < targetCount; slot += 1) {
    const target = 3 + (solution.length - 7) * ((slot + 0.55) / targetCount);
    const eligible = candidates
      .filter((candidate) => !selected.some((item) => Math.abs(item.pathIndex - candidate.pathIndex) < 2))
      .sort((a, b) => {
        const aScore = Math.abs(a.pathIndex - target) - (a.isTurn ? 1.6 : 0) + random() * 0.08;
        const bScore = Math.abs(b.pathIndex - target) - (b.isTurn ? 1.6 : 0) + random() * 0.08;
        return aScore - bScore;
      });
    if (eligible[0]) selected.push(eligible[0]);
  }

  return selected
    .sort((a, b) => a.pathIndex - b.pathIndex)
    .map((candidate, index) => {
      let offsetX;
      let offsetY;
      if (candidate.isTurn) {
        const length = Math.hypot(
          candidate.incoming.x + candidate.outgoing.x,
          candidate.incoming.y + candidate.outgoing.y
        ) || 1;
        offsetX = (candidate.incoming.x + candidate.outgoing.x) / length;
        offsetY = (candidate.incoming.y + candidate.outgoing.y) / length;
      } else {
        const sign = index % 2 === 0 ? 1 : -1;
        offsetX = -candidate.incoming.y * sign;
        offsetY = candidate.incoming.x * sign;
      }
      const offset = Math.min(cellWidth, cellHeight) * (candidate.isTurn ? 0.17 : 0.2);
      return {
        id: index + 1,
        pathIndex: candidate.pathIndex,
        type: candidate.isTurn ? "corner" : "chicane",
        x: (candidate.current.col + 0.5) * cellWidth + offsetX * offset,
        y: (candidate.current.row + 0.5) * cellHeight + offsetY * offset,
        radius: 12.5
      };
    });
}

export function placeRouteGaps(solution, cells, cellWidth, cellHeight, hazards) {
  const selected = [];
  for (const ratio of [.34, .7]) {
    const target = Math.round(solution.length * ratio);
    const candidates = [];
    for (let pathIndex = 4; pathIndex < solution.length - 4; pathIndex += 1) {
      const previous = cells[solution[pathIndex - 1]];
      const current = cells[solution[pathIndex]];
      const next = cells[solution[pathIndex + 1]];
      const incoming = { x: current.col - previous.col, y: current.row - previous.row };
      const outgoing = { x: next.col - current.col, y: next.row - current.row };
      const straight = incoming.x === outgoing.x && incoming.y === outgoing.y;
      const clearOfHole = hazards.every((hazard) => Math.abs(hazard.pathIndex - pathIndex) >= 2);
      const clearOfGap = selected.every((gap) => Math.abs(gap.pathIndex - pathIndex) >= 5);
      if (straight && clearOfHole && clearOfGap) candidates.push({ pathIndex, current, incoming });
    }
    candidates.sort((a, b) => Math.abs(a.pathIndex - target) - Math.abs(b.pathIndex - target));
    if (candidates[0]) selected.push(candidates[0]);
  }

  return selected
    .sort((a, b) => a.pathIndex - b.pathIndex)
    .map((candidate, index) => {
      const verticalTravel = candidate.incoming.y !== 0;
      const width = verticalTravel ? cellWidth - 22 : 16;
      const height = verticalTravel ? 16 : cellHeight - 22;
      return {
        id: index + 1,
        pathIndex: candidate.pathIndex,
        x: (candidate.current.col + .5) * cellWidth - width / 2,
        y: (candidate.current.row + .5) * cellHeight - height / 2,
        width,
        height
      };
    });
}

export function buildWallRects(cells, cols, rows, thickness = 6.5) {
  const cellWidth = WORLD.width / cols;
  const cellHeight = WORLD.height / rows;
  const walls = [];
  const keys = new Set();
  const add = (key, wall) => {
    if (!keys.has(key)) {
      keys.add(key);
      walls.push(wall);
    }
  };

  for (const cell of cells) {
    const x = cell.col * cellWidth;
    const y = cell.row * cellHeight;
    if (cell.walls[0]) add(`h:${cell.col}:${cell.row}`, { x: x - thickness / 2, y: y - thickness / 2, width: cellWidth + thickness, height: thickness });
    if (cell.walls[1]) add(`v:${cell.col + 1}:${cell.row}`, { x: x + cellWidth - thickness / 2, y: y - thickness / 2, width: thickness, height: cellHeight + thickness });
    if (cell.walls[2]) add(`h:${cell.col}:${cell.row + 1}`, { x: x - thickness / 2, y: y + cellHeight - thickness / 2, width: cellWidth + thickness, height: thickness });
    if (cell.walls[3]) add(`v:${cell.col}:${cell.row}`, { x: x - thickness / 2, y: y - thickness / 2, width: thickness, height: cellHeight + thickness });
  }
  return walls;
}

export function gravityFromAngles(betaDegrees, gammaDegrees, screenAngle = 0) {
  const beta = betaDegrees * Math.PI / 180;
  const gamma = gammaDegrees * Math.PI / 180;
  let x = Math.sin(gamma) * Math.cos(beta);
  let y = Math.sin(beta);
  const z = Math.cos(beta) * Math.cos(gamma);
  const angle = ((screenAngle % 360) + 360) % 360;
  if (angle === 90) [x, y] = [y, -x];
  if (angle === 270) [x, y] = [-y, x];
  if (angle === 180) [x, y] = [-x, -y];
  return { x, y, z };
}

export function resolveCircleRect(ball, radius, rect, restitution = PHYSICS.restitution) {
  const nearestX = clamp(ball.x, rect.x, rect.x + rect.width);
  const nearestY = clamp(ball.y, rect.y, rect.y + rect.height);
  let dx = ball.x - nearestX;
  let dy = ball.y - nearestY;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= radius * radius) return 0;

  let normalX;
  let normalY;
  let overlap;
  if (distanceSquared < 1e-8) {
    const candidates = [
      { distance: Math.abs(ball.x - rect.x), nx: -1, ny: 0 },
      { distance: Math.abs(rect.x + rect.width - ball.x), nx: 1, ny: 0 },
      { distance: Math.abs(ball.y - rect.y), nx: 0, ny: -1 },
      { distance: Math.abs(rect.y + rect.height - ball.y), nx: 0, ny: 1 }
    ].sort((a, b) => a.distance - b.distance);
    normalX = candidates[0].nx;
    normalY = candidates[0].ny;
    overlap = radius + candidates[0].distance;
  } else {
    const distance = Math.sqrt(distanceSquared);
    normalX = dx / distance;
    normalY = dy / distance;
    overlap = radius - distance;
  }

  ball.x += normalX * overlap;
  ball.y += normalY * overlap;
  const normalVelocity = ball.vx * normalX + ball.vy * normalY;
  if (normalVelocity < 0) {
    ball.vx -= (1 + restitution) * normalVelocity * normalX;
    ball.vy -= (1 + restitution) * normalVelocity * normalY;
    const tangentX = -normalY;
    const tangentY = normalX;
    const tangentVelocity = ball.vx * tangentX + ball.vy * tangentY;
    ball.vx -= tangentVelocity * PHYSICS.wallFriction * tangentX;
    ball.vy -= tangentVelocity * PHYSICS.wallFriction * tangentY;
  }
  return Math.abs(normalVelocity);
}

export function stepBall(ball, gravityVector, walls, dt, radius = BALL_RADIUS, onSurface = true) {
  const accelerationFactor = onSurface ? PHYSICS.solidSphereFactor : 1;
  const accelerationScale = PHYSICS.gravity * accelerationFactor * PHYSICS.pixelsPerMeter;
  ball.vx += clamp(gravityVector.x, -1, 1) * accelerationScale * dt;
  ball.vy += clamp(gravityVector.y, -1, 1) * accelerationScale * dt;

  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 0) {
    if (onSurface) {
      const normalGravity = Math.max(0, gravityVector.z ?? 1);
      const rollingDeceleration = PHYSICS.rollingResistance * PHYSICS.gravity * normalGravity * PHYSICS.pixelsPerMeter;
      const reducedSpeed = Math.max(0, speed - rollingDeceleration * dt);
      const rollingScale = reducedSpeed / speed;
      ball.vx *= rollingScale;
      ball.vy *= rollingScale;
    }
    const dragScale = 1 / (1 + PHYSICS.airDrag * speed * dt);
    ball.vx *= dragScale;
    ball.vy *= dragScale;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  let strongestImpact = 0;
  for (const wall of walls) strongestImpact = Math.max(strongestImpact, resolveCircleRect(ball, radius, wall));
  return strongestImpact;
}

export function stepVerticalPhysics(ball, gravityNormal, surfaceAcceleration, dt) {
  const wasAirborne = ball.airHeight > 0;
  const relativeAcceleration = (
    -PHYSICS.gravity * clamp(gravityNormal, -1, 1) -
    clamp(surfaceAcceleration || 0, -30, 30) * PHYSICS.surfaceMotionResponse
  ) * PHYSICS.pixelsPerMeter;

  if (!wasAirborne && ball.verticalVelocity <= 0 && relativeAcceleration <= 0) {
    ball.airHeight = 0;
    ball.verticalVelocity = 0;
    return { airborne: false, liftOff: false, landed: false, impact: 0 };
  }

  ball.verticalVelocity += relativeAcceleration * dt;
  ball.airHeight += ball.verticalVelocity * dt;
  if (ball.airHeight <= 0) {
    const impact = Math.abs(ball.verticalVelocity);
    ball.airHeight = 0;
    ball.verticalVelocity = 0;
    return { airborne: false, liftOff: false, landed: wasAirborne, impact };
  }
  return { airborne: true, liftOff: !wasAirborne, landed: false, impact: 0 };
}

export function holeCaptureRadius(holeRadius, ballRadius = BALL_RADIUS) {
  return Math.sqrt(Math.max(0, holeRadius * holeRadius - ballRadius * ballRadius));
}
