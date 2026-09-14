import test from "node:test";
import assert from "node:assert/strict";
import {
  WORLD,
  BALL_RADIUS,
  PHYSICS,
  createMaze,
  gravityFromAngles,
  holeCaptureRadius,
  resolveCircleRect,
  seededRandom,
  stepBall,
  stepVerticalPhysics
} from "../physics.js";

test("seeded random is deterministic", () => {
  const first = seededRandom(42);
  const second = seededRandom(42);
  assert.deepEqual(Array.from({ length: 8 }, first), Array.from({ length: 8 }, second));
});

test("generated maze is deterministic and has a start-to-goal path", () => {
  const first = createMaze(1234);
  const second = createMaze(1234);
  assert.deepEqual(first.cells, second.cells);
  assert.ok(first.solution.length > 1);
  assert.equal(first.solution[0], (first.rows - 1) * first.cols);
  assert.equal(first.solution.at(-1), first.cols - 1);
  assert.ok(first.solution.length >= Math.floor(first.cols * first.rows * 0.48));
  assert.ok(first.turns >= 12);
});

test("all maze cells are connected", () => {
  const maze = createMaze(9001);
  const seen = new Set([0]);
  const queue = [0];
  const deltas = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  while (queue.length) {
    const index = queue.shift();
    const cell = maze.cells[index];
    cell.walls.forEach((closed, direction) => {
      if (closed) return;
      const [dc, dr] = deltas[direction];
      const next = (cell.row + dr) * maze.cols + cell.col + dc;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    });
  }
  assert.equal(seen.size, maze.cells.length);
});

test("numbered hazards challenge the required route without sealing it", () => {
  const maze = createMaze(777);
  assert.ok(maze.hazards.length >= 7);
  for (const hazard of maze.hazards) {
    assert.ok(hazard.x > 0 && hazard.x < WORLD.width);
    assert.ok(hazard.y > 0 && hazard.y < WORLD.height);
    assert.equal(maze.solution[hazard.pathIndex] != null, true);
    assert.equal(holeCaptureRadius(hazard.radius) < Math.min(maze.cellWidth, maze.cellHeight) / 2 - BALL_RADIUS, true);
  }
});

test("jump gaps cross straight sections of the required route", () => {
  const maze = createMaze(777);
  assert.equal(maze.gaps.length, 2);
  for (const gap of maze.gaps) {
    assert.ok(maze.solution[gap.pathIndex] != null);
    assert.ok(gap.width > 0 && gap.height > 0);
    assert.ok(maze.hazards.every((hazard) => Math.abs(hazard.pathIndex - gap.pathIndex) >= 2));
  }
});

test("true horizontal orientation produces zero plane gravity", () => {
  assert.deepEqual(gravityFromAngles(0, 0), { x: 0, y: 0, z: 1 });
  const tenDegreesRight = gravityFromAngles(0, 10);
  assert.ok(Math.abs(tenDegreesRight.x - Math.sin(10 * Math.PI / 180)) < 1e-10);
  assert.equal(tenDegreesRight.y, 0);
  assert.ok(tenDegreesRight.z > 0.98);
});

test("orientation is not clamped and reports an overturned board", () => {
  const vertical = gravityFromAngles(90, 0);
  assert.ok(Math.abs(vertical.y - 1) < 1e-10);
  assert.ok(Math.abs(vertical.z) < 1e-10);
  const overturned = gravityFromAngles(120, 0);
  assert.ok(overturned.z < 0);
});

test("solid sphere acceleration follows 5/7 g and rolling resistance", () => {
  const ball = { x: 100, y: 100, vx: 0, vy: 0 };
  const gravityComponent = Math.sin(10 * Math.PI / 180);
  stepBall(ball, { x: gravityComponent, y: 0 }, [], 0.01);
  const idealDelta = gravityComponent * PHYSICS.gravity * PHYSICS.solidSphereFactor * PHYSICS.pixelsPerMeter * 0.01;
  assert.ok(ball.vx > 0);
  assert.ok(ball.vx < idealDelta);
  assert.equal(ball.vy, 0);
});

test("circle collision pushes the ball out and reflects velocity", () => {
  const ball = { x: 14, y: 20, vx: -100, vy: 0 };
  const impact = resolveCircleRect(ball, 10, { x: 10, y: 0, width: 5, height: 40 });
  assert.ok(impact > 0);
  assert.ok(ball.x >= 25);
  assert.ok(ball.vx > 0);
});

test("physics accelerates toward input and remains finite against maze walls", () => {
  const maze = createMaze(42);
  const ball = { ...maze.start, vx: 0, vy: 0 };
  for (let index = 0; index < 600; index += 1) stepBall(ball, { x: 1, y: -0.35 }, maze.walls, 1 / 120);
  assert.ok(Number.isFinite(ball.x) && Number.isFinite(ball.y));
  assert.ok(ball.x >= 0 && ball.x <= WORLD.width);
  assert.ok(ball.y >= 0 && ball.y <= WORLD.height);
  assert.ok(Number.isFinite(ball.vx) && Number.isFinite(ball.vy));
  assert.ok(Math.hypot(ball.vx, ball.vy) < 4000);
});

test("vertical surface acceleration naturally creates and lands an arc", () => {
  const ball = { airHeight: 0, verticalVelocity: 0 };
  const pressed = stepVerticalPhysics(ball, 1, 8, 1 / 120);
  assert.equal(pressed.airborne, false);
  let lifted = false;
  for (let index = 0; index < 12; index += 1) {
    const state = stepVerticalPhysics(ball, 1, -16, 1 / 120);
    lifted = lifted || state.liftOff;
  }
  assert.equal(lifted, true);
  assert.ok(ball.airHeight > 0);
  let landed = false;
  for (let index = 0; index < 240; index += 1) {
    landed = stepVerticalPhysics(ball, 1, 0, 1 / 120).landed || landed;
  }
  assert.equal(landed, true);
  assert.equal(ball.airHeight, 0);
  assert.equal(ball.verticalVelocity, 0);
});

test("airborne planar motion uses projectile gravity without rolling resistance", () => {
  const ball = { x: 100, y: 100, vx: 180, vy: -40 };
  stepBall(ball, { x: 1, y: 1, z: .5 }, [], .1, BALL_RADIUS, false);
  assert.ok(ball.vx > 180);
  assert.ok(ball.vy > -40);
  assert.ok(ball.x > 118);
  assert.ok(ball.y > 96);
});

test("an inverted board releases the ball through the same contact equation", () => {
  const ball = { airHeight: 0, verticalVelocity: 0 };
  const state = stepVerticalPhysics(ball, -1, 0, 1 / 120);
  assert.equal(state.liftOff, true);
  assert.ok(ball.airHeight > 0);
});
