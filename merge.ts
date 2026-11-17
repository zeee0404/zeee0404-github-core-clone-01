// Pull-request merging, shared by the REST, GraphQL and MCP surfaces so all
// three agree on what a merge is: a real git commit whose tree applies the
// head branch's changes (relative to the merge base) onto the base branch.
//
// MERGE makes a two-parent merge commit; SQUASH makes a one-parent commit
// carrying the same tree. A conflict — the same path changed to different
// bytes on both sides since the merge base — refuses the merge.

import {
  buildCommit,
  buildTree,
  commitInfoOf,
  flattenTree,
  forgeIdent,
  getRepo,
  isAncestor,
  putObject,
  resolveRef,
  type PullRec,
  type RepoRec,
  type TreeEntry,
} from './store.ts';

function mergeBase(a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const info = commitInfoOf(oid);
    if (info) stack.push(...info.parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  let qHead = 0;
  while (qHead < queue.length) {
    const oid = queue[qHead];
    qHead += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const info = commitInfoOf(oid);
    if (info) queue.push(...info.parents);
  }
  return null;
}

function changedPaths(fromCommit: string | null, toCommit: string): Map<string, { oid: string; mode: string } | null> {
  const from = fromCommit ? flattenTree(fromCommit) : new Map<string, { oid: string; mode: string }>();
  const to = flattenTree(toCommit);
  const out = new Map<string, { oid: string; mode: string } | null>();
  for (const [path, entry] of to) if (from.get(path)?.oid !== entry.oid) out.set(path, entry);
  for (const path of from.keys()) if (!to.has(path)) out.set(path, null);
  return out;
}

/** Build a tree object from a flat path -> entry map; returns the root oid. */
function treeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(parts[i]) as Node;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject('tree', buildTree(entries));
  };
  return build(root);
}

export interface MergeResult {
  ok: boolean;
  sha: string;
  error: string;
  conflict: boolean;
}

export function mergePullRequest(repo: RepoRec, pull: PullRec, method: string): MergeResult {
  const fail = (error: string, conflict = false): MergeResult => ({ ok: false, sha: '', error, conflict });
  if (pull.state === 'merged' || pull.merged) return fail('Pull Request is already merged');
  if (pull.state !== 'open') return fail('Pull Request is not open');
  const baseTip = resolveRef(repo, pull.baseRef);
  const headRepo = pull.headRepoKey
    ? getRepo(pull.headRepoKey.split('/')[0], pull.headRepoKey.split('/')[1])
    : repo;
  const headTip = headRepo ? resolveRef(headRepo, pull.headRef) : null;
  if (!baseTip || !headTip) return fail('base or head ref is missing');
  if (isAncestor(headTip, baseTip)) return fail('There are no commits to merge');

  const base = mergeBase(baseTip, headTip);
  const headChanges = changedPaths(base, headTip);
  const baseChanges = changedPaths(base, baseTip);
  for (const [path, entry] of headChanges) {
    const other = baseChanges.get(path);
    if (baseChanges.has(path) && (other?.oid ?? null) !== (entry?.oid ?? null)) {
      return fail(`Merge conflict in ${path}`, true);
    }
  }

  const merged = flattenTree(baseTip);
  for (const [path, entry] of headChanges) {
    if (entry === null) merged.delete(path);
    else merged.set(path, entry);
  }
  const tree = treeFromFlat(merged);
  const ident = forgeIdent();
  const squash = method.toUpperCase() === 'SQUASH';
  const message = squash
    ? `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}\n`
    : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commit = putObject('commit', buildCommit({
    tree,
    parents: squash ? [baseTip] : [baseTip, headTip],
    author: ident,
    committer: ident,
    message,
  }));
  const baseRefName = pull.baseRef.startsWith('refs/') ? pull.baseRef : `refs/heads/${pull.baseRef}`;
  repo.refs.set(baseRefName, commit);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeSha = commit;
  return { ok: true, sha: commit, error: '', conflict: false };
}
