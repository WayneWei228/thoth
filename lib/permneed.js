'use strict';
// Ask for a macOS permission only when a session needs it (user, 2026-11-15: setup must not ask
// for "screen recording" up front; most users never need it). A Claude session's tool output
// (hook PostToolUse / PostToolUseFailure, lib/claude_args.js) that says a permission is missing
// names the permission here; the server then checks the real state (lib/permissions.js) and the
// app shows its guide (PermissionGuide.swift). Pure functions, no I/O.

const WORDS = { accessibility: /accessibility/i, screen_recording: /screen ?(recording|capture)/i };
const MISSING = /permission|not (granted|allowed|permitted|authori[sz]ed)|denied|not trusted/i;
// screencapture without Screen Recording (exit 1)
const SCREENCAPTURE = /could not create image from (display|window)/i;

/** The text a hook payload carries about the tool's result (error, stdout, stderr), short. */
function resultText(payload = {}) {
  const parts = [];
  if (typeof payload.error === 'string') parts.push(payload.error);
  const r = payload.tool_response;
  if (typeof r === 'string') parts.push(r);
  else if (r && typeof r === 'object') for (const k of ['stderr', 'stdout', 'error', 'content']) if (typeof r[k] === 'string') parts.push(r[k]);
  return parts.join('\n').slice(0, 20000);
}

/** The permissions a hook event says are missing: [] or some of ['accessibility', 'screen_recording']. */
function wanted(event, payload = {}) {
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return [];
  const text = resultText(payload);
  if (!text) return [];
  const out = new Set();
  if (SCREENCAPTURE.test(text)) out.add('screen_recording');
  for (const line of text.split('\n')) {
    if (!MISSING.test(line)) continue;
    for (const [id, re] of Object.entries(WORDS)) if (re.test(line)) out.add(id);
  }
  return [...out];
}

/** Ask once per permission in `cooldownMs` (a session that retries must not open the guide again and again). */
function shouldAsk(asked, id, now = Date.now(), cooldownMs = 30 * 60 * 1000) {
  const t = asked.get(id);
  if (t && now - t < cooldownMs) return false;
  asked.set(id, now);
  return true;
}

module.exports = { wanted, resultText, shouldAsk };
