// Embedded in the Node supervisor. No PID registry survives its live owner.
export const ownedDescendantProgram = String.raw`
function parseOwnedInventory(text, ignoredPid) {
  const rows = new Map();
  for (const line of text.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([RSDITZU?][A-Za-z0-9+<>-]*)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) throw Error('owned process inventory unknown');
    const pid = Number(m[1]);
    if (pid === ignoredPid) continue;
    if (rows.has(pid)) throw Error('duplicate process identity');
    rows.set(pid, { pid, parent: Number(m[2]), group: Number(m[3]), state: m[4],
      started: m[5].replace(/\s+/g, ' '), command: m[6] });
  }
  return rows;
}
class OwnedDescendants {
  constructor(ownerPid) { this.ownerPid = ownerPid; this.known = new Map(); }
  observe(rows, childPid, childLive) {
    for (const [pid, identity] of this.known) {
      const row = rows.get(pid);
      if (!row || row.started !== identity.started || row.state[0] === 'Z') this.known.delete(pid);
    }
    const proven = new Set();
    const child = rows.get(childPid);
    if (childLive && child && child.state[0] !== '?' && child.parent === this.ownerPid && child.group === this.ownerPid) proven.add(child.pid);
    for (const [pid, identity] of this.known) {
      const row = rows.get(pid);
      if (row && row.state[0] !== '?' && row.started === identity.started && row.command === identity.command) proven.add(pid);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows.values()) if (row.pid !== this.ownerPid && !['Z','?'].includes(row.state[0]) &&
        (proven.has(row.pid) || proven.has(row.parent))) {
        if (!proven.has(row.pid)) { proven.add(row.pid); changed = true; }
        this.known.set(row.pid, { started: row.started, command: row.command });
      }
      if (this.known.size > 4096) throw Error('owned process registry limit');
    }
  }
  escaped(rows) {
    const live = []; let unknown = false;
    for (const [pid, identity] of this.known) {
      const row = rows.get(pid);
      if (!row || row.started !== identity.started || row.state[0] === 'Z') continue;
      if (row.group === this.ownerPid) continue;
      // macOS ps can expose '?' during a transition. Preserve uncertainty
      // for this identity, without discarding trustworthy unrelated rows.
      if (row.state[0] === '?') { unknown = true; continue; }
      if (row.command !== identity.command) { unknown = true; continue; }
      live.push(row);
    }
    return { live, unknown };
  }
}
`;
