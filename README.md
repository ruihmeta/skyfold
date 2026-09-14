# TILT//LAB

A portrait-first 3D PWA inspired by classic wooden labyrinth toys. Tilt a phone to roll a steel ball from the lower-left start ring to the upper-right brass cup, then lift the phone sharply to jump route holes and low walls.

## Run locally

```bash
npm test
npm run serve
```

Open `http://localhost:4173`. Desktop browsers can use arrow keys or drag anywhere on the board; press Space or use a second pointer to jump. Mobile motion input needs HTTPS except on `localhost`; iOS asks for orientation and motion permission after pressing **Enable motion & play**.

## PWA bundle

The repository root is the deployable static bundle. Keep the files in `vendor/` alongside the app. Three.js is vendored under its MIT license; the game art itself is entirely procedural.

## Milestone completion checks

- Starts through a user gesture and handles iOS motion permission.
- True horizontal is the default zero; optional calibration compensates for a case, table, or preferred holding angle.
- The 3D board follows the phone's full pitch and roll without an artificial angle clamp; overturning it drops the ball.
- A sharp upward phone acceleration launches the ball into a ballistic arc. Airborne balls clear holes, and sufficiently high jumps clear the 17 px walls.
- Two dark floor gaps cross the required route and make the vertical jump axis part of the puzzle rather than an optional flourish.
- Tilt, touch-drag, and keyboard input all drive the same solid-sphere rolling model.
- Physics uses the rolling-sphere acceleration factor `5/7 g sin(theta)`, rolling resistance, air drag, and inelastic wood impacts.
- Procedural 3D wood grain, beveled walls, recessed holes, brass hardware, lighting, shadows, and a reflective steel sphere require no external art assets.
- Route hazards sit at required corners and alternating chicanes instead of harmless dead ends.
- Supports active play, falls, win, retry, timer, calibration, and persistent best time.
- Registers a service worker and remains playable after its first successful load.
- Adapts to phone safe areas and portrait viewports.
