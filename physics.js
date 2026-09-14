export const WORLD = Object.freeze({ width: 360, height: 600 });

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

export function createMaze(seed = 0x71a6, cols = 6, rows = 10) {
  const random = seededRandom(seed);
  const cells = Array.from({ length: cols * rows }, (_, index) => ({
    col: index % cols,
    row: Math.floor(index / cols),
    walls: [true, true, true, true],
    visited: false
  }));
  const startIndex = cellIndex(0, rows - 1, cols);
  const goalIndex = cellIndex(cols - 1, 0, cols);
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

  const solution = findPath(cells, cols, rows, startIndex, goalIndex);
  const cellWidth = WORLD.width / cols;
  const cellHeight = WORLD.height / rows;
  const center = (index) => ({
    x: (cells[index].col + 0.5) * cellWidth,
    y: (cells[index].row + 0.5) * cellHeight
  });
  const solutionSet = new Set(solution);
  const hazardCandidates = cells
    .map((_, index) => index)
    .filter((index) => !solutionSet.has(index) && index !== startIndex && index !== goalIndex)
    .sort(() => random() - 0.5)
    .slice(0, 3);
  const pickupIndices = [0.25, 0.5, 0.75]
    .map((ratio) => solution[Math.floor((solution.length - 1) * ratio)])
    .filter((index, position, values) => index !== startIndex && index !== goalIndex && values.indexOf(index) === position);

  return {
    seed,
    cols,
    rows,
    cells,
    cellWidth,
    cellHeight,
    walls: buildWallRects(cells, cols, rows),
    start: center(startIndex),
    goal: center(goalIndex),
    solution,
    hazards: hazardCandidates.map((index) => ({ ...center(index), radius: 15 })),
    pickups: pickupIndices.map((index, id) => ({ id, ...center(index), collected: false }))
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

export function buildWallRects(cells, cols, rows, thickness = 7) {
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

export function resolveCircleRect(ball, radius, rect, bounce = 0.3) {
  const nearestX = clamp(ball.x, rect.x, rect.x + rect.width);
  const nearestY = clamp(ball.y, rect.y, rect.y + rect.height);
  let dx = ball.x - nearestX;
  let dy = ball.y - nearestY;
  let distanceSquared = dx * dx + dy * dy;
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
    ball.vx -= (1 + bounce) * normalVelocity * normalX;
    ball.vy -= (1 + bounce) * normalVelocity * normalY;
  }
  return Math.abs(normalVelocity);
}

export function stepBall(ball, input, walls, dt, radius = 10) {
  const acceleration = 560;
  const maxSpeed = 285;
  const damping = Math.pow(0.986, dt * 60);
  ball.vx += clamp(input.x, -1, 1) * acceleration * dt;
  ball.vy += clamp(input.y, -1, 1) * acceleration * dt;
  ball.vx *= damping;
  ball.vy *= damping;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > maxSpeed) {
    ball.vx = ball.vx / speed * maxSpeed;
    ball.vy = ball.vy / speed * maxSpeed;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  let strongestImpact = 0;
  for (const wall of walls) strongestImpact = Math.max(strongestImpact, resolveCircleRect(ball, radius, wall));
  return strongestImpact;
}
