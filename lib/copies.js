// The brain lists a session once even when several devices have a copy of it (brain.merge_copies).
// A routing decision "handoff" from another device is not needed when this computer has the
// newest copy itself (for example the same Mac joined twice, or a session copied by Migration
// Assistant that went on here): the panel resumes it here instead.

/**
 * read: the brain's answer to GET /api/session?sid=… without a device ({session, copies?}).
 * Returns this computer's copy ({sid, cwd, agent, …}) when it is the newest or has the same
 * dialogue as the newest, otherwise null.
 */
function newestHere(read, localDevice) {
  if (!read || !read.session || !localDevice) return null;
  const copies = Array.isArray(read.copies) && read.copies.length ? read.copies : [{ device: read.session.device, relation: 'main' }];
  const mine = copies.find((c) => c.device === localDevice);
  if (!mine || !['main', 'same'].includes(mine.relation)) return null;
  return { ...read.session, device: localDevice };
}

module.exports = { newestHere };
