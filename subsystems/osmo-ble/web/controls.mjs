// What the two Gimbal control clients used to keep as copies of each other: the Direct (Web
// Bluetooth) pathway in app.mjs and the Server (backend) pathway in backend-client.mjs. That covers
// the log, filling Raw command from a clicked frame, the stick toggle, and the joystick's
// latched-speed guard.
//
// Each client still owns its transport. These take a function that sends, so the two pathways
// cannot drift apart on the parts that are meant to be the same.

import { attachJoystick } from './joystick.mjs';

/** A timestamped line logger writing into `el`, which scrolls to the newest line. */
export function createLog(el) {
  return function log(line, cls = '') {
    const row = document.createElement('div');
    if (cls) row.className = cls;
    row.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  };
}

/**
 * Clicking a frame-log row or a coverage-grid cell loads it straight into Raw command, so a gap
 * in coverage, or an unknown RX frame just spotted, is one click from being probed.
 */
export function rawCommandFiller({ cmdSet, cmdId, payload }) {
  return function loadIntoRawCommand({ cmdSet: set, cmdId: id, payloadHex }) {
    cmdSet.value = set;
    cmdId.value = id;
    if (payloadHex !== undefined) payload.value = payloadHex;
  };
}

/**
 * The stick-control toggle, promoted to the main view because the test matrix flags it as a
 * possible precondition for motion commands. It is a local toggle, not read back from the device,
 * which has no query for this state: it tracks what this page last told the gimbal.
 *
 * `send(enable)` sends the frame and resolves once it is out. A failure leaves the state as it was.
 */
export function attachStickToggle(button, { send, log }) {
  let enabled = false;
  button.addEventListener('click', async () => {
    const next = !enabled;
    try {
      await send(next);
      enabled = next;
      button.textContent = `Stick: ${enabled ? 'ON' : 'OFF'}`;
      button.classList.toggle('active', enabled);
    } catch (err) {
      log(`Stick control toggle failed: ${err.message}`, 'warn');
    }
  });
}

/**
 * The joystick, with the guard both pathways need against a speed left latched.
 *
 * Click-drag, touch-drag, or focus + arrow keys. It streams a speed vector while active and sends
 * a zero speed on release. The gimbal's speed command is a latch, not a pulse, so leaving
 * mid-drag (tab closed or hidden) would leave the last speed latched: nothing sends the stop once
 * the page is gone. `exitStop()` is called then, and only while a speed is latched, so hiding the
 * tab with the joystick at rest sends nothing. It must be bounded, since a write that never
 * returns cannot be allowed to hold the page open.
 *
 * @param {HTMLElement} pad
 * @param {{ sendMove: (vector: object) => Promise<unknown>, sendStop: () => Promise<unknown>,
 *   exitStop: () => void, log: (line: string, cls?: string) => void }} handlers
 */
export function attachLatchedJoystick(pad, { sendMove, sendStop, exitStop, log }) {
  let speedLatched = false;
  attachJoystick(pad, {
    onMove: (vector) => {
      speedLatched = true;
      sendMove(vector).catch((err) => log(`Joystick move failed: ${err.message}`, 'warn'));
    },
    onStop: () => {
      speedLatched = false;
      sendStop().catch(() => {
        /* best-effort stop */
      });
    },
  });
  function stopOnPageExit() {
    if (!speedLatched) return;
    speedLatched = false;
    exitStop();
  }
  window.addEventListener('pagehide', stopOnPageExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopOnPageExit();
  });
}
