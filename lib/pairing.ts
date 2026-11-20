// "pairing": one place for what the pairing command and the
// server's local routes (/api/pairPhone, /api/pairPhoneOff) do. Turn remote access on or off, and
// make the pairing link from this Mac's addresses, the port, the certificate pin, the token and the
// relay (the Thoth relay by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as Firewall from './firewall.ts';
import * as Relay from './relay_client.ts';
import * as Remote from './remote.ts';
import { ne } from './truthy.ts';

export const NO_NETWORK = 'Remote access is on, but this Mac has no private network address now.';
export const NO_NETWORK_FIX = 'Connect this Mac to your Wi-Fi (the same network as a remote client)';

export const FIREWALL_BLOCKED =
  'The macOS firewall blocks connections to Thoth, so a remote client cannot reach this Mac on Wi-Fi.';
export const FIREWALL_RELAY = 'It can still connect through the relay.';

const flagPath = (home: string): string => path.join(home, 'remote-enabled');

/** Remote access on: the server opens the remote listeners (at once from its own routes, else within 30 s). */
export function turnOn(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(flagPath(home), '');
}

/** Remote access off. The token and the certificate stay, so a paired phone works again after turnOn. */
export function turnOff(home: string): void {
  try {
    fs.unlinkSync(flagPath(home));
  } catch {
    /* already off */
  }
}

/** The addresses a phone can use: the ones the server listens on (lib/remote.ts listenPlan). The
 * test hosts stand in for them, as they do for the listeners: CC_PANEL_REMOTE_TEST_LAN_HOST acts
 * like a LAN address, CC_PANEL_REMOTE_TEST_HOST like a Tailscale address. */
export function addresses(
  ifaces: Remote.Interfaces | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { lan: string[]; tailscale: string[] } {
  const testHost = env['CC_PANEL_REMOTE_TEST_HOST'],
    testLanHost = env['CC_PANEL_REMOTE_TEST_LAN_HOST'];
  if (ne(testHost) || ne(testLanHost))
    return { lan: ne(testLanHost) ? [testLanHost] : [], tailscale: ne(testHost) ? [testHost] : [] };
  return { lan: Remote.lanAddresses(ifaces), tailscale: Remote.tailscaleAddresses(ifaces) };
}

export interface WaysOptions {
  ifaces?: Remote.Interfaces;
  env?: NodeJS.ProcessEnv;
}

export interface Ways {
  hosts: string[];
  lan: string[];
  tailscale: string[];
  relay: Relay.PairingInfo | null;
}

/** The ways a phone can reach this Mac now: the addresses and the relay (when one is set up). It changes nothing. */
export function ways(home: string, { ifaces = os.networkInterfaces(), env = process.env }: WaysOptions = {}): Ways {
  const { lan, tailscale } = addresses(ifaces, env);
  return { hosts: [...lan, ...tailscale], lan, tailscale, relay: Relay.pairingInfo(home) };
}

export interface PairingOptions extends WaysOptions {
  port: number;
  rotate?: boolean;
  newCert?: boolean;
}

export interface Pairing extends Ways {
  port: number;
  name: string;
  reachable: boolean;
  token: string;
  pin: string;
  link: string;
}

/** Turn remote access on and return what a phone needs to pair. It sets up the default relay
 * (lib/relay_client.ts ensureDefault) when this Mac has none and "away from home" is not off.
 * `port`: the remote listeners' port. `rotate` makes a new token, `newCert` a new certificate (only
 * the pairing command asks for them). With no address and no relay the phone has no way in:
 * `reachable` is false, and no token, pin or link is read or made. */
export function pairing(
  home: string,
  { port, rotate = false, newCert = false, ifaces = os.networkInterfaces(), env = process.env }: PairingOptions,
): Pairing {
  turnOn(home);
  // away from home: the Thoth relay, unless this Mac has its own relay or its owner turned it off
  try {
    Relay.ensureDefault(home, env);
  } catch {
    /* a home that cannot be written: no relay */
  }
  const { hosts, lan, tailscale, relay } = ways(home, { ifaces, env });
  const name = Remote.macName(env);
  const base = { hosts, lan, tailscale, port, relay, name };
  if (hosts.length === 0 && !relay) return { ...base, reachable: false, token: '', pin: '', link: '' };
  const token = Remote.loadToken(home, rotate);
  const { pin } = Remote.loadCert(home, newCert);
  return {
    ...base,
    reachable: true,
    token,
    pin,
    link: Remote.pairingLink({ hosts, port, pin, token, relay, name }),
  };
}

export interface FirewallView {
  state: 'blocked' | 'allowed' | 'unknown';
  relay: boolean;
  message?: string;
  fix?: string;
}

/** What the macOS firewall means for a pairing. `blocked` is the answer of lib/firewall.ts for the
 * server's node binary `node`: true, false, or null (cannot tell).
 * The firewall stops connections that come in on this Mac's addresses (`hosts`). The relay is a
 * connection from this Mac out, so the firewall does not stop it: `relay` says that one is set up.
 * `message` (what is wrong) and `fix` (a command for a terminal) are there only when the firewall
 * blocks and the phone has an address to use; a pairing with the relay only needs no warning. */
export function firewallView(
  blocked: boolean | null | undefined,
  { hosts = [], relay = null, node = process.execPath }: { hosts?: string[]; relay?: unknown; node?: string } = {},
): FirewallView {
  let state: FirewallView['state'] = 'unknown';
  if (blocked === true) state = 'blocked';
  else if (blocked === false) state = 'allowed';
  const hasRelay = Boolean(relay);
  if (state !== 'blocked' || hosts.length === 0) return { state, relay: hasRelay };
  return {
    state,
    relay: hasRelay,
    message: hasRelay ? `${FIREWALL_BLOCKED} ${FIREWALL_RELAY}` : FIREWALL_BLOCKED,
    fix: `sudo ${Firewall.TOOL} --add '${node}' && sudo ${Firewall.TOOL} --unblockapp '${node}'`,
  };
}
