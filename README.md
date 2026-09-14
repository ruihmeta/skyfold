# TILT//LAB

A small portrait-first PWA labyrinth. Tilt a phone to roll the marble from the lower-left launch pad to the upper-right portal, collecting optional energy cells and avoiding gravity wells.

## Run locally

```bash
npm test
npm run serve
```

Open `http://localhost:4173`. Desktop browsers can use arrow keys or drag anywhere on the board. Mobile motion input needs HTTPS except on `localhost`; iOS asks for motion permission after pressing **Enable tilt & play**.

## PWA bundle

The repository root is the deployable static bundle. `index.html`, `manifest.webmanifest`, `sw.js`, `app.js`, `physics.js`, and `icon.svg` must remain together. The game has no external runtime dependencies or imported assets.

## Milestone completion checks

- Starts through a user gesture and handles iOS motion permission.
- Tilt, touch-drag, and keyboard input all control the same physics model.
- Supports active play, falls, win, retry, timer, calibration, and persistent best time.
- Registers a service worker and remains playable after its first successful load.
- Adapts to phone safe areas and portrait viewports.
