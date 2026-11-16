#!/usr/bin/env node
// Pair the iPhone app: prints the Tailscale address, port and token,
// and opens a QR code with the pairing link  ccpanel://pair?host=<ip>&port=<port>&token=<token>
//   node scripts/pair.js            turn remote access on (if needed) and show the pairing code
//   node scripts/pair.js --rotate   make a new token (the old phone pairing stops working)
//   node scripts/pair.js --off      turn remote access off
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Remote = require('../lib/remote');
const INST = require('../lib/instance').instance();

const home = INST.home;
const flag = path.join(home, 'remote-enabled');
if (process.argv.includes('--off')) {
  try { fs.unlinkSync(flag); } catch { /* already off */ }
  console.log('Remote access is off (the server closes the remote listener within 30 s).');
  process.exit(0);
}
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(flag, '');
const token = Remote.loadToken(home, process.argv.includes('--rotate'));
const ips = Remote.tailscaleAddresses(os.networkInterfaces());
const port = INST.port;
if (!ips.length) {
  console.log('Remote access is on, but this Mac has no Tailscale address yet.');
  console.log('Install Tailscale on this Mac and the iPhone, sign in to the same account, then run this again.');
  process.exit(1);
}
const host = ips.find((ip) => !ip.includes(':')) || ips[0];
const link = `ccpanel://pair?host=${encodeURIComponent(host)}&port=${port}&token=${encodeURIComponent(token)}`;
console.log(`Address: ${host}:${port}\nToken:   ${token}\n\nIn the iPhone app: Pair → scan the QR code, or type the address and token.`);
const png = path.join(home, 'pair-qr.png');
try {
  execFileSync('swift', [path.join(__dirname, 'qr.swift'), link, png], { stdio: 'ignore', timeout: 120000 });
  fs.chmodSync(png, 0o600);
  execFileSync('open', [png]);
  console.log(`QR code: ${png} (opened). It contains the token; delete it after pairing.`);
} catch (e) {
  console.log(`(Could not make the QR image: ${e.message.split('\n')[0]})`);
}
