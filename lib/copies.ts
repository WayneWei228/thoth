// The brain lists a session once even when several devices have a copy of it (brain.merge_copies).
// A routing decision "handoff" from another device is not needed when this computer has the
// newest copy itself (for example the same Mac joined twice, or a session copied by Migration
// Assistant that went on here): the panel resumes it here instead.

export interface BrainSession {
  device?: string;
  [key: string]: unknown;
}
export interface BrainCopy {
  device?: string;
  relation?: string;
}
export interface BrainRead {
  session?: BrainSession | null;
  copies?: BrainCopy[];
}

/**
 * read: the brain's answer to GET /api/session?sid=… without a device ({session, copies?}).
 * Returns this computer's copy ({sid, cwd, agent, …}) when it is the newest or has the same
 * dialogue as the newest, otherwise null.
 */
export function newestHere(
  read: BrainRead | null | undefined,
  localDevice: string | null | undefined,
): BrainSession | null {
  if (!read?.session || localDevice === null || localDevice === undefined || localDevice === '') return null;
  const copies: BrainCopy[] =
    Array.isArray(read.copies) && read.copies.length > 0
      ? read.copies
      : [{ device: read.session.device, relation: 'main' } as BrainCopy];
  const mine = copies.find((c) => c.device === localDevice);
  if (!mine || !['main', 'same'].includes(mine.relation ?? '')) return null;
  return { ...read.session, device: localDevice };
}
