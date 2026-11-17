// The forge's state and its git object store.
//
// Everything lives in memory: a fresh process is a fresh, empty forge, which is
// exactly what the trial harness expects. Git objects are content-addressed the
// way git itself addresses them — SHA-1 over "<type> <length>\0" + payload — so
// an id the REST contents route mints is the same id a push would produce, and a
// commit built by the merge route hashes identically to one git would build.
//
// The object store is global to the forge (objects are shared across repos,
// like a real object database); repositories hold refs, issues and pulls.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, payload]));
}

// ---------------------------------------------------------------------------
// object store
// ---------------------------------------------------------------------------

export interface StoredObject {
  type: GitObjectType;
  payload: Buffer;
}

const objects = new Map<string, StoredObject>();

export function putObject(type: GitObjectType, payload: Buffer): string {
  const oid = hashObject(type, payload);
  if (!objects.has(oid)) objects.set(oid, { type, payload });
  return oid;
}

export function getObject(oid: string): StoredObject | null {
  return objects.get(oid) ?? null;
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  oid: string;
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    const mode = payload.subarray(i, sp).toString('utf8');
    const nul = payload.indexOf(0x00, sp);
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const oid = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  // git sorts tree entries by name, with directories sorting as if they ended in '/'.
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(payload: Buffer): CommitInfo {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Deterministic identity + clock for commits the forge itself authors. */
const FORGE_EPOCH = 1700000000;
let commitCounter = 0;
export function forgeIdent(): string {
  commitCounter += 1;
  return `make.fun forge <forge@make.fun> ${FORGE_EPOCH + commitCounter} +0000`;
}

/** Every object reachable from a commit (the commit, its tree closure, its history). */
export function collectReachable(tips: string[], exclude: Set<string>): Map<string, StoredObject> {
  const out = new Map<string, StoredObject>();
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || exclude.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.payload);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.payload)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.payload.toString('utf8'));
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** All objects reachable from the given tips (used to compute what a peer already has). */
export function reachableSet(tips: string[]): Set<string> {
  return new Set(collectReachable(tips, new Set()).keys());
}

/** True when `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.payload).parents);
  }
  return false;
}

/** Read a blob's bytes by walking from a commit's tree along a path; null if absent. */
export function blobAtPath(commitOid: string, path: string): { oid: string; payload: Buffer } | null {
  const commit = getObject(commitOid);
  if (commit?.type !== 'commit') return null;
  let treeOid = parseCommit(commit.payload).tree;
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const tree = getObject(treeOid);
    if (tree?.type !== 'tree') return null;
    const entry = parseTree(tree.payload).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      const blob = getObject(entry.oid);
      return blob?.type === 'blob' ? { oid: entry.oid, payload: blob.payload } : null;
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** Flatten a commit's tree into path -> {oid, mode} for every blob. */
export function flattenTree(commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = getObject(commitOid);
  if (commit?.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = getObject(treeOid);
    if (tree?.type !== 'tree') return;
    for (const e of parseTree(tree.payload)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(commit.payload).tree, '');
  return out;
}

/** Insert or replace one path in a commit's tree, returning the new root tree oid. */
export function upsertPath(rootTreeOid: string, path: string, blobOid: string | null, mode = '100644'): string {
  const parts = path.split('/').filter(Boolean);
  const rec = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = treeOid ? parseTree(getObject(treeOid)?.payload ?? Buffer.alloc(0)) : [];
    const name = parts[depth];
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) entries[idx] = { mode, name, oid: blobOid };
      else entries.push({ mode, name, oid: blobOid });
    } else {
      const childOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
      const newChild = rec(childOid, depth + 1);
      if (idx >= 0) entries[idx] = { mode: '40000', name, oid: newChild };
      else entries.push({ mode: '40000', name, oid: newChild });
    }
    return putObject('tree', buildTree(entries));
  };
  return rec(rootTreeOid, 0);
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize a set of objects into a complete (non-delta) packfile with trailer. */
export function buildPack(objs: Map<string, StoredObject>): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.size, 8);
  const chunks: Buffer[] = [head];
  for (const obj of objs.values()) {
    const size = obj.payload.length;
    let first = (TYPE_IDS[obj.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    const bytes: number[] = [];
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    chunks.push(Buffer.from(bytes));
    chunks.push(deflateSync(obj.payload));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { offset |= delta[i] << (8 * bit); i += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { size |= delta[i] << (8 * bit); i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Read a packfile into the object store; returns the number of objects stored. */
export function ingestPack(pack: Buffer): number {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, string>();
  let stored = 0;
  for (let n = 0; n < count; n += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = 0;
    if (typeId === 6) { // OFS_DELTA
      let b = pack[offset];
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === 7) { // REF_DELTA
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // zlib stream: inflate needs a bounded slice; use a streaming inflate via a
    // helper that finds the consumed length by trying the rest of the buffer.
    const { data, consumed } = inflateFrom(pack, offset);
    offset += consumed;
    let payload: Buffer;
    let type: GitObjectType;
    if (typeId === 6 || typeId === 7) {
      const baseKey = typeId === 7 ? baseOid : byOffset.get(baseOffset);
      const base = baseKey ? getObject(baseKey) : null;
      if (!base) throw new Error('delta base missing');
      payload = applyDelta(base.payload, data);
      type = base.type;
    } else {
      type = ID_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      payload = data;
      if (payload.length !== size) { /* sizes in the header are of the inflated data */ }
    }
    const oid = putObject(type, payload);
    byOffset.set(start, oid);
    stored += 1;
  }
  return stored;
}

/** Inflate one zlib stream starting at `offset`; reports how many bytes it used. */
function inflateFrom(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  return inflatePure(buf.subarray(offset));
}

// A compact, correct DEFLATE (RFC 1951) + zlib (RFC 1950) decoder. Packfiles in
// this forge are small (the suite's repositories are a handful of files), and a
// pure implementation keeps ingest fully synchronous without stream plumbing.
export function inflatePure(input: Buffer): { data: Buffer; consumed: number } {
  if (input.length < 2) throw new Error('zlib stream too short');
  let pos = 2; // skip zlib header
  let bitPos = 0;
  const readBit = (): number => {
    const byte = input[pos + (bitPos >> 3)];
    const bit = (byte >> (bitPos & 7)) & 1;
    bitPos += 1;
    return bit;
  };
  const readBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v |= readBit() << i;
    return v;
  };
  interface Huff { counts: number[]; symbols: number[] }
  const buildHuff = (lengths: number[]): Huff => {
    const counts = new Array(16).fill(0);
    for (const l of lengths) if (l > 0) counts[l] += 1;
    const offs = new Array(16).fill(0);
    for (let i = 1; i < 16; i += 1) offs[i] = offs[i - 1] + counts[i - 1];
    const symbols = new Array(lengths.length).fill(0);
    lengths.forEach((l, sym) => { if (l > 0) { symbols[offs[l]] = sym; offs[l] += 1; } });
    return { counts, symbols };
  };
  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= readBit();
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('bad huffman code');
  };
  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const out: number[] = [];
  for (;;) {
    const bfinal = readBits(1);
    const btype = readBits(2);
    if (btype === 0) {
      bitPos += (8 - (bitPos % 8)) % 8;
      const start = pos + (bitPos >> 3);
      const len = input.readUInt16LE(start);
      for (let i = 0; i < len; i += 1) out.push(input[start + 4 + i]);
      bitPos += (4 + len) * 8;
    } else {
      let lit: Huff;
      let dist: Huff;
      if (btype === 1) {
        const litLengths = new Array(288).fill(0);
        for (let i = 0; i < 144; i += 1) litLengths[i] = 8;
        for (let i = 144; i < 256; i += 1) litLengths[i] = 9;
        for (let i = 256; i < 280; i += 1) litLengths[i] = 7;
        for (let i = 280; i < 288; i += 1) litLengths[i] = 8;
        lit = buildHuff(litLengths);
        dist = buildHuff(new Array(32).fill(5));
      } else if (btype === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const codeLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i += 1) codeLengths[ORDER[i]] = readBits(3);
        const codeHuff = buildHuff(codeLengths);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const sym = decode(codeHuff);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            const prev = lengths[lengths.length - 1];
            const rep = 3 + readBits(2);
            for (let i = 0; i < rep; i += 1) lengths.push(prev);
          } else if (sym === 17) {
            const rep = 3 + readBits(3);
            for (let i = 0; i < rep; i += 1) lengths.push(0);
          } else {
            const rep = 11 + readBits(7);
            for (let i = 0; i < rep; i += 1) lengths.push(0);
          }
        }
        lit = buildHuff(lengths.slice(0, hlit));
        dist = buildHuff(lengths.slice(hlit));
      } else {
        throw new Error('bad deflate block type');
      }
      for (;;) {
        const sym = decode(lit);
        if (sym === 256) break;
        if (sym < 256) {
          out.push(sym);
        } else {
          const li = sym - 257;
          const length = LENGTH_BASE[li] + readBits(LENGTH_EXTRA[li]);
          const dsym = decode(dist);
          const distance = DIST_BASE[dsym] + readBits(DIST_EXTRA[dsym]);
          const startIdx = out.length - distance;
          for (let i = 0; i < length; i += 1) out.push(out[startIdx + i]);
        }
      }
    }
    if (bfinal) break;
  }
  const consumed = 2 + Math.ceil(bitPos / 8) + 4; // header + deflate bytes + adler32
  return { data: Buffer.from(out), consumed };
}

// ---------------------------------------------------------------------------
// forge state: users, repositories, issues, pulls
// ---------------------------------------------------------------------------

/** The one viewer every valid bearer token acts as in a trial. */
export const VIEWER_LOGIN = 'zeee0404';

let nextDatabaseId = 100000;
export function allocDatabaseId(): number {
  nextDatabaseId += 1;
  return nextDatabaseId;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  createdSeq: number;
  updatedSeq: number;
  nodeId: string;
  databaseId: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string; // full ref or branch name as given
  baseRef: string;
  headRepoKey: string | null; // "owner/name" when head names another repo
  merged: boolean;
  mergeSha: string | null;
  createdSeq: number;
  nodeId: string;
  databaseId: number;
}

export interface RepoRec {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> oid
  labels: Array<{ name: string; color: string }>;
  issues: IssueRec[];
  pulls: PullRec[];
  nextIssueNumber: number;
  databaseId: number;
  nodeId: string;
}

const repos = new Map<string, RepoRec>();
let seq = 0;
export function nextSeq(): number {
  seq += 1;
  return seq;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const key = repoKey(owner, name);
  const existing = repos.get(key);
  if (existing) return existing;
  const rec: RepoRec = {
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: [],
    issues: [],
    pulls: [],
    nextIssueNumber: 1,
    databaseId: allocDatabaseId(),
    nodeId: '',
  };
  rec.nodeId = encodeNodeId('Repository', rec.databaseId);
  repos.set(key, rec);
  return rec;
}

export function getRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): RepoRec[] {
  return [...repos.values()].filter((r) => r.owner === owner);
}

export function allRepos(): RepoRec[] {
  return [...repos.values()];
}

// ---------------------------------------------------------------------------
// GraphQL node ids: base64 of "Type:databaseId", stable for the object's life.
// ---------------------------------------------------------------------------

export function encodeNodeId(type: string, databaseId: number): string {
  return Buffer.from(`${type}:${databaseId}`, 'utf8').toString('base64');
}

export function decodeNodeId(id: string): { type: string; databaseId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const databaseId = Number(text.slice(colon + 1));
    if (!Number.isFinite(databaseId)) return null;
    return { type: text.slice(0, colon), databaseId };
  } catch {
    return null;
  }
}

export function findRepoByDatabaseId(databaseId: number): RepoRec | null {
  return allRepos().find((r) => r.databaseId === databaseId) ?? null;
}

export function findIssueByDatabaseId(databaseId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of allRepos()) {
    const issue = repo.issues.find((i) => i.databaseId === databaseId);
    if (issue) return { repo, issue };
  }
  return null;
}

export function findPullByDatabaseId(databaseId: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of allRepos()) {
    const pull = repo.pulls.find((p) => p.databaseId === databaseId);
    if (pull) return { repo, pull };
  }
  return null;
}

export function newIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: nextSeq(),
    updatedSeq: nextSeq(),
    nodeId: '',
    databaseId: allocDatabaseId(),
  };
  repo.nextIssueNumber += 1;
  issue.nodeId = encodeNodeId('Issue', issue.databaseId);
  repo.issues.push(issue);
  return issue;
}

export function newPull(
  repo: RepoRec,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
  headRepoKey: string | null,
): PullRec {
  const pull: PullRec = {
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headRepoKey,
    merged: false,
    mergeSha: null,
    createdSeq: nextSeq(),
    nodeId: '',
    databaseId: allocDatabaseId(),
  };
  repo.nextIssueNumber += 1;
  pull.nodeId = encodeNodeId('PullRequest', pull.databaseId);
  repo.pulls.push(pull);
  return pull;
}

/** Resolve a branch name or full ref to an oid inside a repo. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const asBranch = `refs/heads/${ref}`;
  if (repo.refs.has(asBranch)) return repo.refs.get(asBranch) as string;
  if (/^[0-9a-f]{40}$/.test(ref) && hasObject(ref)) return ref;
  return null;
}
