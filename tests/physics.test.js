import test from "node:test";
import assert from "node:assert/strict";
import { WORLD, createMaze, resolveCircleRect, seededRandom, stepBall } from "../physics.js";

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

test("hazards stay off the direct solution and inside the board", () => {
  const maze = createMaze(777);
  const solutionCenters = new Set(maze.solution.map((index) => {
    const cell = maze.cells[index];
    return `${(cell.col + .5) * maze.cellWidth}:${(cell.row + .5) * maze.cellHeight}`;
  }));
  for (const hazard of maze.hazards) {
    assert.ok(hazard.x > 0 && hazard.x < WORLD.width);
    assert.ok(hazard.y > 0 && hazard.y < WORLD.height);
    assert.equal(solutionCenters.has(`${hazard.x}:${hazard.y}`), false);
  }
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
  assert.ok(Math.hypot(ball.vx, ball.vy) <= 286);
});
