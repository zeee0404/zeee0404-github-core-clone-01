// Git smart HTTP: the advertisement, protocol v0 and v2 upload-pack, and
// receive-pack, spoken the way git and the suite's own client speak it.
//
// The forge stores real git objects (store.ts), so clone/fetch/push here are
// byte-level honest: a fetched pack recomputes to the same ids the REST
// contents route minted, and a pushed pack is unpacked object by object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildPack,
  collectReachable,
  getObject,
  hasObject,
  ingestPack,
  isAncestor,
  parseCommit,
  reachableSet,
  type RepoRec,
} from './store.ts';

export const AGENT = 'makefun-forge/1.0.0';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

function lines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

export function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Peel an annotated tag to the object it ultimately names. */
function peel(oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = getObject(current);
    if (obj?.type !== 'tag') break;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.payload.toString('utf8'));
    if (!m) break;
    current = m[1];
  }
  return current;
}

// ---------------------------------------------------------------------------
// info/refs advertisement
// ---------------------------------------------------------------------------

export function handleInfoRefs(res: ServerResponse, repo: RepoRec, service: string, protocolV2: boolean): void {
  if (service === 'git-upload-pack') {
    if (protocolV2) {
      const body = Buffer.concat([
        pktLine('version 2\n'),
        pktLine(`agent=${AGENT}\n`),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow wait-for-done filter\n'),
        pktLine('object-format=sha1\n'),
        PKT_FLUSH,
      ]);
      send(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    const caps = 'multi_ack_detailed side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=' + AGENT;
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headOid = repo.refs.get(headTarget(repo)) ?? refs[0][1];
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      for (const [name, oid] of refs) {
        parts.push(pktLine(`${oid} ${name}\n`));
        const peeled = peel(oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }
  // git-receive-pack
  const caps = 'report-status delete-refs side-band-64k quiet atomic ofs-delta agent=' + AGENT;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? refs[0][1];
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) parts.push(pktLine(`${oid} ${name}\n`));
  }
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function packFor(wants: string[], excludeTips: string[], depth: number | null, dropBlobs: boolean): { pack: Buffer; shallow: string[] } {
  const exclude = reachableSet(excludeTips.filter((t) => hasObject(t)));
  let shallow: string[] = [];
  let objs: Map<string, { type: never; payload: never }> | ReturnType<typeof collectReachable>;
  if (depth === null) {
    objs = collectReachable(wants.filter((w) => hasObject(w)), exclude);
  } else {
    // Depth-limited closure: walk commits by generation, cut at the boundary.
    const included = new Set<string>();
    const boundary: string[] = [];
    const seenDepth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = wants.map((w) => ({ oid: w, d: 0 }));
    while (queue.length) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (exclude.has(oid)) continue;
      if (seenDepth.has(oid) && (seenDepth.get(oid) as number) <= d) continue;
      seenDepth.set(oid, d);
      const obj = getObject(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (d >= depth) { boundary.push(oid); continue; }
        included.add(oid);
        const c = parseCommit(obj.payload);
        included.add(c.tree);
        for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
      }
    }
    // Add the trees/blobs of included commits.
    const full = collectReachable([...included].filter((o) => getObject(o)?.type === 'commit'), exclude);
    for (const oid of included) if (full.has(oid)) { /* covered */ }
    objs = full;
    shallow = boundary;
  }
  let map = objs as Map<string, { type: string; payload: Buffer }>;
  if (dropBlobs) {
    map = new Map([...map.entries()].filter(([, o]) => o.type !== 'blob'));
  }
  return { pack: buildPack(map as never), shallow };
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec, protocolV2: boolean): Promise<void> {
  const body = await readBody(req);
  const { packets } = parsePackets(body);
  const allLines = lines(packets);

  if (protocolV2) {
    const command = allLines.find((l) => l.startsWith('command='))?.slice('command='.length) ?? '';
    // Arguments live after the delim packet.
    const delimIdx = packets.findIndex((p) => p.kind === 'delim');
    const argPackets = delimIdx >= 0 ? packets.slice(delimIdx + 1) : packets;
    const args = lines(argPackets);

    if (command === 'ls-refs') {
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const wantPeel = args.includes('peel');
      const wantSymrefs = args.includes('symrefs');
      const wantUnborn = args.includes('unborn');
      const parts: Buffer[] = [];
      const target = headTarget(repo);
      const headOid = repo.refs.get(target);
      if (wantSymrefs || headOid || wantUnborn) {
        let line = `${headOid ?? ZERO_OID} HEAD`;
        if (wantSymrefs) line += ` symref-target:${target}`;
        if (!headOid && wantUnborn) line += ' unborn';
        parts.push(pktLine(`${line}\n`));
      }
      for (const [name, oid] of sortedRefs(repo)) {
        if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) continue;
        let line = `${oid} ${name}`;
        if (wantPeel) {
          const peeled = peel(oid);
          if (peeled !== oid) line += ` peeled:${peeled}`;
        }
        parts.push(pktLine(`${line}\n`));
      }
      parts.push(PKT_FLUSH);
      send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return;
    }

    if (command === 'fetch') {
      const wants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5).trim());
      const haves = args.filter((a) => a.startsWith('have ')).map((a) => a.slice(5).trim());
      const done = args.includes('done');
      const noProgress = args.includes('no-progress');
      const depthLine = args.find((a) => a.startsWith('deepen '));
      const depth = depthLine ? Number(depthLine.slice(7)) : null;
      const dropBlobs = args.some((a) => a === 'filter blob:none');
      const common = haves.filter((h) => hasObject(h));
      // With `done` and no haves at all there is nothing to negotiate: real git
      // answers with the packfile section directly, and its client rejects an
      // acknowledgments section there. The suite's client dispatches by section
      // name, so omitting it is safe for both.
      const parts: Buffer[] = [];
      if (!done || haves.length > 0) {
        parts.push(pktLine('acknowledgments\n'));
        if (common.length) {
          for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
          if (!done) parts.push(pktLine('ready\n'));
        } else {
          parts.push(pktLine('NAK\n'));
        }
      }
      if (!done) {
        parts.push(PKT_FLUSH);
        send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
        return;
      }
      const { pack, shallow } = packFor(wants, common, depth, dropBlobs);
      // Sections are separated by a delim, but the response never starts with
      // one: only push a delim when a section already precedes it.
      if (depth !== null) {
        if (parts.length) parts.push(PKT_DELIM);
        parts.push(pktLine('shallow-info\n'));
        for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      }
      if (parts.length) parts.push(PKT_DELIM);
      parts.push(pktLine('packfile\n'));
      if (!noProgress) parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: pack ready\n')])));
      parts.push(...sidebandPack(pack));
      parts.push(PKT_FLUSH);
      send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return;
    }

    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine(`error: unknown command ${command}\n`), PKT_FLUSH]));
    return;
  }

  // Protocol v0 upload-pack.
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const line of allLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line === 'done') done = true;
  }
  const common = haves.filter((h) => hasObject(h));
  const parts: Buffer[] = [];
  if (common.length) parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  if (done || haves.length === 0) {
    const { pack } = packFor(wants, common, null, false);
    parts.push(...sidebandPack(pack), PKT_FLUSH);
  }
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  let caps = '';
  let sawFlush = false;
  packets.forEach((p, idx) => {
    if (p.kind === 'flush') { sawFlush = true; return; }
    if (p.kind !== 'data' || sawFlush) return;
    let text = p.payload.toString('utf8').replace(/\n$/, '');
    if (idx === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const fields = text.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  });
  const pack = rest.length >= 12 && rest.subarray(0, 4).toString('ascii') === 'PACK' ? rest : null;

  let unpackOk = true;
  let unpackError = '';
  if (pack) {
    try {
      ingestPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const wantReport = caps.includes('report-status');
  const sideband = caps.includes('side-band-64k');
  const quiet = caps.includes('quiet');
  const atomic = caps.includes('atomic');

  // Validate every command before applying any (atomic or not, validation is pure).
  const results = commands.map((cmd) => {
    if (!unpackOk) return { cmd, ok: false, error: `unpack failed: ${unpackError}` };
    if (cmd.newOid === ZERO_OID) return { cmd, ok: true, error: '' }; // delete
    if (!hasObject(cmd.newOid)) return { cmd, ok: false, error: 'missing object' };
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (current !== cmd.oldOid) return { cmd, ok: false, error: 'stale ref' };
    if (cmd.oldOid !== ZERO_OID && cmd.ref.startsWith('refs/heads/')) {
      if (!isAncestor(cmd.oldOid, cmd.newOid)) return { cmd, ok: false, error: 'non-fast-forward' };
    }
    return { cmd, ok: true, error: '' };
  });
  const anyFail = results.some((r) => !r.ok);
  const apply = !(atomic && anyFail);
  if (apply) {
    for (const r of results) {
      if (!r.ok) continue;
      if (r.cmd.newOid === ZERO_OID) repo.refs.delete(r.cmd.ref);
      else repo.refs.set(r.cmd.ref, r.cmd.newOid);
    }
  } else {
    for (const r of results) if (r.ok) { r.ok = false; r.error = 'atomic push rejected'; }
  }

  if (!wantReport) {
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack error: ${unpackError}\n`)];
  for (const r of results) {
    reportLines.push(pktLine(r.ok ? `ok ${r.cmd.ref}\n` : `ng ${r.cmd.ref} ${r.error}\n`));
  }
  const parts: Buffer[] = [];
  if (sideband) {
    if (!quiet) parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: unpacking\n')])));
    for (const line of reportLines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), line])));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(...reportLines, PKT_FLUSH);
  }
  send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
