// A small GraphQL engine for the forge's v4 surface.
//
// It parses the documents gh and github-mcp-server actually send — operations
// with variables, inline enum lists and input objects, aliases, inline
// fragments, batched documents — and executes them against a data-driven
// schema that also powers __type introspection, so a field gh probes for is a
// field that resolves. Unknown fields answer with a GraphQL errors array on a
// 200, the way the real API behaves.

import {
  VIEWER_LOGIN,
  decodeNodeId,
  findIssueByDatabaseId,
  findPullByDatabaseId,
  findRepoByDatabaseId,
  getRepo,
  isAncestor,
  newIssue,
  newPull,
  resolveRef,
  flattenTree,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$=@!|&'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end < 0 ? src.length : end)}"`);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j] + src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_0-9][A-Za-z_0-9.]*/.exec(src.slice(i)) ?? /^-?[0-9][0-9.eE+-]*/.exec(src.slice(i));
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;
  constructor(src: string) { this.tokens = tokenize(src); }
  private peek(): string | undefined { return this.tokens[this.pos]; }
  private next(): string { const t = this.tokens[this.pos]; this.pos += 1; return t; }
  private expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }
  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.parseArgs(); // discard
    }
  }
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (t === 'query' || t === 'mutation' || t === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek() as string)) name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (t === 'fragment') {
        this.next();
        const fname = this.next();
        this.expect('on');
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(fname, this.parseSelectionSet());
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') depth -= 1;
    }
  }
  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      let args: Record<string, Value> = {};
      if (this.peek() === '(') args = this.parseArgs();
      this.skipDirectives();
      let selection: SelectionNode[] | null = null;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { name, alias, args, selection } });
    }
    this.expect('}');
    return selections;
  }
  parseArgs(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (this.peek() !== ')' && this.pos < this.tokens.length) {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) {
      try { return { kind: 'string', value: JSON.parse(t) as string }; }
      catch { return { kind: 'string', value: t.slice(1, -1) }; }
    }
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?[0-9]+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?[0-9.]+([eE][+-]?[0-9]+)?$/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name] ?? null;
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

interface Ctx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: never, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, { type: string; resolve: Resolver }>;
  values?: string[];
}

const S = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Merge-base of two commits by ancestor walking (nearest shared ancestor). */
function mergeBase(a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const set = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (set.has(oid)) continue;
      set.add(oid);
      // parents resolved lazily through the object store
      const parents = commitParents(oid);
      stack.push(...parents);
    }
    return set;
  };
  const aSet = ancestorsOf(a);
  // BFS from b for the first commit also in aSet.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aSet.has(oid)) return oid;
    queue.push(...commitParents(oid));
  }
  return null;
}

import { getObject, parseCommit } from './store.ts';
function commitParents(oid: string): string[] {
  const obj = getObject(oid);
  return obj?.type === 'commit' ? parseCommit(obj.payload).parents : [];
}

/** Changed paths between two commits, mapped to their resulting blob oid. */
function changedPaths(fromCommit: string | null, toCommit: string): Map<string, string | null> {
  const from = fromCommit ? flattenTree(fromCommit) : new Map<string, { oid: string; mode: string }>();
  const to = flattenTree(toCommit);
  const out = new Map<string, string | null>();
  for (const [path, entry] of to) {
    if (from.get(path)?.oid !== entry.oid) out.set(path, entry.oid);
  }
  for (const path of from.keys()) if (!to.has(path)) out.set(path, null);
  return out;
}

function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = resolveRef(repo, pull.baseRef);
  const headRepo = pull.headRepoKey ? getRepo(pull.headRepoKey.split('/')[0], pull.headRepoKey.split('/')[1]) : repo;
  const headTip = headRepo ? resolveRef(headRepo, pull.headRef) : null;
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (isAncestor(headTip, baseTip)) return 'MERGEABLE';
  const base = mergeBase(baseTip, headTip);
  const headChanges = changedPaths(base, headTip);
  const baseChanges = changedPaths(base, baseTip);
  for (const [path, oid] of headChanges) {
    if (baseChanges.has(path) && baseChanges.get(path) !== oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullFiles(repo: RepoRec, pull: PullRec): string[] {
  const baseTip = resolveRef(repo, pull.baseRef);
  const headRepo = pull.headRepoKey ? getRepo(pull.headRepoKey.split('/')[0], pull.headRepoKey.split('/')[1]) : repo;
  const headTip = headRepo ? resolveRef(headRepo, pull.headRef) : null;
  if (!baseTip || !headTip) return [];
  const base = mergeBase(baseTip, headTip) ?? baseTip;
  return [...changedPaths(base, headTip).keys()].sort();
}

type Wrapped = { __type: string; value: unknown };
const wrap = (type: string, value: unknown): Wrapped => ({ __type: type, value });

function cursorOf(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}
function offsetOf(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const n = Number(text.replace('cursor:', ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function connection<T>(items: T[], args: Record<string, unknown>, type: string, wrapItem: (item: T) => Wrapped): Wrapped {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const start = offsetOf(args.after);
  const page = items.slice(start, start + first);
  return wrap(type, {
    nodes: page.map(wrapItem),
    pageInfo: {
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorOf(start) : null,
      endCursor: page.length ? cursorOf(start + page.length) : null,
    },
    totalCount: items.length,
  });
}

const schema: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'REBASE', 'SQUASH'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  CommentAuthorAssociation: { kind: 'ENUM', values: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] },

  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String!', resolve: (u) => (u as { login: string }).login },
      id: { type: 'ID!', resolve: (u) => Buffer.from(`User:${(u as { login: string }).login}`).toString('base64') },
      name: { type: 'String', resolve: (u) => (u as { login: string }).login },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!', resolve: (r) => (r as { name: string }).name },
      prefix: { type: 'String!', resolve: () => 'refs/heads/' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!', resolve: (p) => (p as { hasNextPage: boolean }).hasNextPage },
      hasPreviousPage: { type: 'Boolean!', resolve: (p) => (p as { hasPreviousPage: boolean }).hasPreviousPage },
      startCursor: { type: 'String', resolve: (p) => (p as { startCursor: string | null }).startCursor },
      endCursor: { type: 'String', resolve: (p) => (p as { endCursor: string | null }).endCursor },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (r) => (r as RepoRec).nodeId },
      databaseId: { type: 'Int', resolve: (r) => (r as RepoRec).databaseId },
      name: { type: 'String!', resolve: (r) => (r as RepoRec).name },
      nameWithOwner: { type: 'String!', resolve: (r) => `${(r as RepoRec).owner}/${(r as RepoRec).name}` },
      description: { type: 'String', resolve: (r) => (r as RepoRec).description || null },
      isPrivate: { type: 'Boolean!', resolve: (r) => (r as RepoRec).isPrivate },
      owner: { type: 'User!', resolve: (r) => wrap('User', { login: (r as RepoRec).owner }) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (r) => {
          const repo = r as RepoRec;
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? wrap('Ref', { name: repo.defaultBranch }) : null;
        },
      },
      viewerPermission: { type: 'RepositoryPermission!', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
      hasPullRequestsEnabled: { type: 'Boolean!', resolve: () => true },
      url: { type: 'URI!', resolve: (r) => `https://make.fun/${(r as RepoRec).owner}/${(r as RepoRec).name}` },
      issue: {
        type: 'Issue',
        resolve: (r, args) => {
          const repo = r as RepoRec;
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          return issue ? wrap('Issue', { repo, issue }) : null;
        },
      },
      issues: {
        type: 'IssueConnection!',
        resolve: (r, args) => {
          const repo = r as RepoRec;
          let list = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length) {
            list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const field = orderBy?.field ?? 'CREATED_AT';
          list.sort((a, b) => {
            const ka = field === 'UPDATED_AT' ? a.updatedSeq : field === 'COMMENTS' ? a.comments.length : a.createdSeq;
            const kb = field === 'UPDATED_AT' ? b.updatedSeq : field === 'COMMENTS' ? b.comments.length : b.createdSeq;
            return orderBy?.direction === 'DESC' ? kb - ka : ka - kb;
          });
          return connection(list, args, 'IssueConnection', (issue) => wrap('Issue', { repo, issue }));
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (r, args) => {
          const repo = r as RepoRec;
          const pull = repo.pulls.find((p) => p.number === Number(args.number));
          return pull ? wrap('PullRequest', { repo, pull }) : null;
        },
      },
      pullRequests: {
        type: 'PullRequestConnection!',
        resolve: (r, args) => {
          const repo = r as RepoRec;
          let list = [...repo.pulls];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length) {
            list = list.filter((p) => states.includes(p.state.toUpperCase()));
          }
          return connection(list, args, 'PullRequestConnection', (pull) => wrap('PullRequest', { repo, pull }));
        },
      },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (w) => (w as { issue: IssueRec }).issue.nodeId },
      databaseId: { type: 'Int', resolve: (w) => (w as { issue: IssueRec }).issue.databaseId },
      number: { type: 'Int!', resolve: (w) => (w as { issue: IssueRec }).issue.number },
      title: { type: 'String!', resolve: (w) => (w as { issue: IssueRec }).issue.title },
      body: { type: 'String', resolve: (w) => (w as { issue: IssueRec }).issue.body || null },
      state: { type: 'IssueState!', resolve: (w) => ((w as { issue: IssueRec }).issue.state === 'open' ? 'OPEN' : 'CLOSED') },
      repository: { type: 'Repository!', resolve: (w) => wrap('Repository', (w as { repo: RepoRec }).repo) },
      author: { type: 'User', resolve: () => wrap('User', { login: VIEWER_LOGIN }) },
      url: { type: 'URI!', resolve: (w) => { const { repo, issue } = w as { repo: RepoRec; issue: IssueRec }; return `https://make.fun/${repo.owner}/${repo.name}/issues/${issue.number}`; } },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]', resolve: (c) => (c as { nodes: Wrapped[] }).nodes },
      edges: { type: '[IssueEdge]', resolve: (c) => (c as { nodes: Wrapped[] }).nodes.map((n) => wrap('IssueEdge', { node: n })) },
      pageInfo: { type: 'PageInfo!', resolve: (c) => wrap('PageInfo', (c as { pageInfo: unknown }).pageInfo) },
      totalCount: { type: 'Int!', resolve: (c) => (c as { totalCount: number }).totalCount },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Issue', resolve: (e) => (e as { node: Wrapped }).node },
      cursor: { type: 'String!', resolve: () => cursorOf(0) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (w) => (w as { pull: PullRec }).pull.nodeId },
      databaseId: { type: 'Int', resolve: (w) => (w as { pull: PullRec }).pull.databaseId },
      number: { type: 'Int!', resolve: (w) => (w as { pull: PullRec }).pull.number },
      title: { type: 'String!', resolve: (w) => (w as { pull: PullRec }).pull.title },
      body: { type: 'String', resolve: (w) => (w as { pull: PullRec }).pull.body || null },
      state: { type: 'PullRequestState!', resolve: (w) => (w as { pull: PullRec }).pull.state.toUpperCase() },
      merged: { type: 'Boolean!', resolve: (w) => (w as { pull: PullRec }).pull.merged },
      headRefName: { type: 'String!', resolve: (w) => shortRef((w as { pull: PullRec }).pull.headRef) },
      baseRefName: { type: 'String!', resolve: (w) => shortRef((w as { pull: PullRec }).pull.baseRef) },
      mergeable: { type: 'MergeableState!', resolve: (w) => { const { repo, pull } = w as { repo: RepoRec; pull: PullRec }; return pullMergeable(repo, pull); } },
      repository: { type: 'Repository!', resolve: (w) => wrap('Repository', (w as { repo: RepoRec }).repo) },
      author: { type: 'User', resolve: () => wrap('User', { login: VIEWER_LOGIN }) },
      url: { type: 'URI!', resolve: (w) => { const { repo, pull } = w as { repo: RepoRec; pull: PullRec }; return `https://make.fun/${repo.owner}/${repo.name}/pull/${pull.number}`; } },
      files: {
        type: 'PullRequestChangedFileConnection!',
        resolve: (w, args) => {
          const { repo, pull } = w as { repo: RepoRec; pull: PullRec };
          const paths = pullFiles(repo, pull);
          return connection(paths, args, 'PullRequestChangedFileConnection', (path) => wrap('PullRequestChangedFile', { path }));
        },
      },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (c) => (c as { nodes: Wrapped[] }).nodes },
      pageInfo: { type: 'PageInfo!', resolve: (c) => wrap('PageInfo', (c as { pageInfo: unknown }).pageInfo) },
      totalCount: { type: 'Int!', resolve: (c) => (c as { totalCount: number }).totalCount },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (c) => (c as { nodes: Wrapped[] }).nodes },
      pageInfo: { type: 'PageInfo!', resolve: (c) => wrap('PageInfo', (c as { pageInfo: unknown }).pageInfo) },
      totalCount: { type: 'Int!', resolve: (c) => (c as { totalCount: number }).totalCount },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!', resolve: (f) => (f as { path: string }).path },
      additions: { type: 'Int!', resolve: () => 0 },
      deletions: { type: 'Int!', resolve: () => 0 },
      changeType: { type: 'String!', resolve: () => 'MODIFIED' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (c) => (c as { nodeId: string }).nodeId },
      databaseId: { type: 'Int', resolve: (c) => (c as { databaseId: number }).databaseId },
      body: { type: 'String!', resolve: (c) => (c as { body: string }).body },
      author: { type: 'User', resolve: () => wrap('User', { login: VIEWER_LOGIN }) },
    },
  },
};

function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// ---------------------------------------------------------------------------
// introspection types
// ---------------------------------------------------------------------------

function typeRef(typeStr: string): Wrapped {
  const t = typeStr.trim();
  if (t.endsWith('!')) return wrap('__Type', { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) });
  if (t.startsWith('[') && t.endsWith(']')) return wrap('__Type', { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) });
  const def = schema[t];
  return wrap('__Type', { kind: def?.kind ?? 'OBJECT', name: t, ofType: null, defName: t });
}

Object.assign(schema, {
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (t) => (t as { name: string | null }).name },
      kind: { type: 'String!', resolve: (t) => (t as { kind: string }).kind },
      description: { type: 'String', resolve: () => null },
      ofType: { type: '__Type', resolve: (t) => (t as { ofType: Wrapped | null }).ofType ?? null },
      fields: {
        type: '[__Field]',
        resolve: (t, args) => {
          const defName = (t as { defName?: string; name?: string | null }).defName ?? (t as { name?: string | null }).name ?? '';
          const def = schema[defName];
          if (!def?.fields) return [];
          const includeDeprecated = args.includeDeprecated !== false;
          void includeDeprecated;
          return Object.entries(def.fields).map(([name, f]) => wrap('__Field', { name, typeStr: f.type }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        resolve: (t) => {
          const defName = (t as { defName?: string; name?: string | null }).defName ?? (t as { name?: string | null }).name ?? '';
          const def = schema[defName];
          if (def?.kind !== 'ENUM') return null;
          return (def.values ?? []).map((name) => wrap('__EnumValue', { name }));
        },
      },
      inputFields: { type: '[__InputValue]', resolve: () => null },
      possibleTypes: { type: '[__Type]', resolve: () => null },
      specifiedByURL: { type: 'String', resolve: () => null },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!', resolve: (f) => (f as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      type: { type: '__Type!', resolve: (f) => typeRef((f as { typeStr: string }).typeStr) },
      args: { type: '[__InputValue!]!', resolve: () => [] },
      isDeprecated: { type: 'Boolean!', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!', resolve: (v) => (v as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean!', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
});

// ---------------------------------------------------------------------------
// root operations
// ---------------------------------------------------------------------------

schema.Query = {
  kind: 'OBJECT',
  fields: {
    viewer: { type: 'User!', resolve: () => wrap('User', { login: VIEWER_LOGIN }) },
    repository: {
      type: 'Repository',
      resolve: (_s, args) => {
        const repo = getRepo(S(args.owner), S(args.name));
        return repo ? wrap('Repository', repo) : null;
      },
    },
    node: {
      type: 'Node',
      resolve: (_s, args) => {
        const decoded = decodeNodeId(S(args.id));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoByDatabaseId(decoded.databaseId);
          return repo ? wrap('Repository', repo) : null;
        }
        if (decoded.type === 'Issue') {
          const found = findIssueByDatabaseId(decoded.databaseId);
          return found ? wrap('Issue', found) : null;
        }
        if (decoded.type === 'PullRequest') {
          const found = findPullByDatabaseId(decoded.databaseId);
          return found ? wrap('PullRequest', found) : null;
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_s, args) => {
        const name = S(args.name);
        return schema[name] ? typeRef(name) : null;
      },
    },
    __schema: { type: '__Schema', resolve: () => wrap('__Schema', {}) },
  },
};

schema.__Schema = {
  kind: 'OBJECT',
  fields: {
    types: { type: '[__Type!]!', resolve: () => Object.keys(schema).map((n) => typeRef(n)) },
    queryType: { type: '__Type!', resolve: () => typeRef('Query') },
    mutationType: { type: '__Type', resolve: () => typeRef('Mutation') },
    subscriptionType: { type: '__Type', resolve: () => null },
    directives: { type: '[__Directive!]!', resolve: () => [] },
  },
};

schema.Mutation = {
  kind: 'OBJECT',
  fields: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(S(input.repositoryId));
        const repo = decoded ? findRepoByDatabaseId(decoded.databaseId) : null;
        if (!repo) throw new Error('repository not found');
        const issue = newIssue(repo, S(input.title), S(input.body), []);
        return wrap('CreateIssuePayload', { clientMutationId: input.clientMutationId ?? null, issue: wrap('Issue', { repo, issue }) });
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(S(input.issueId));
        const found = decoded ? findIssueByDatabaseId(decoded.databaseId) : null;
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        return wrap('CloseIssuePayload', { clientMutationId: input.clientMutationId ?? null, issue: wrap('Issue', found) });
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(S(input.repositoryId));
        const repo = decoded ? findRepoByDatabaseId(decoded.databaseId) : null;
        if (!repo) throw new Error('repository not found');
        const pull = newPull(repo, S(input.title), S(input.body), S(input.headRefName), S(input.baseRefName), null);
        return wrap('CreatePullRequestPayload', { clientMutationId: input.clientMutationId ?? null, pullRequest: wrap('PullRequest', { repo, pull }) });
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(S(input.pullRequestId));
        const found = decoded ? findPullByDatabaseId(decoded.databaseId) : null;
        if (!found) throw new Error('pull request not found');
        const result = mergePull(found.repo, found.pull, S(input.mergeMethod) || 'MERGE');
        if (!result.ok) {
          ctx.errors.push({ message: result.error });
          return wrap('MergePullRequestPayload', { clientMutationId: input.clientMutationId ?? null, pullRequest: wrap('PullRequest', found) });
        }
        return wrap('MergePullRequestPayload', { clientMutationId: input.clientMutationId ?? null, pullRequest: wrap('PullRequest', found) });
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(S(input.subjectId));
        if (!decoded) throw new Error('subject not found');
        const body = S(input.body);
        let commentId = 0;
        if (decoded.type === 'Issue') {
          const found = findIssueByDatabaseId(decoded.databaseId);
          if (!found) throw new Error('subject not found');
          commentId = found.issue.comments.length + 1;
          found.issue.comments.push({ id: commentId, body });
        } else if (decoded.type === 'PullRequest') {
          const found = findPullByDatabaseId(decoded.databaseId);
          if (!found) throw new Error('subject not found');
          commentId = 1;
          void found;
        }
        const nodeId = Buffer.from(`IssueComment:${commentId}`, 'utf8').toString('base64');
        const comment = wrap('IssueComment', { nodeId, databaseId: commentId, body });
        return wrap('AddCommentPayload', {
          clientMutationId: input.clientMutationId ?? null,
          commentEdge: wrap('CommentEdge', { node: comment }),
          subject: null,
        });
      },
    },
  },
};

for (const payload of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  schema[payload] = {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String', resolve: (p) => (p as { clientMutationId: string | null }).clientMutationId },
      issue: { type: 'Issue', resolve: (p) => (p as { issue?: Wrapped }).issue ?? null },
      pullRequest: { type: 'PullRequest', resolve: (p) => (p as { pullRequest?: Wrapped }).pullRequest ?? null },
      commentEdge: { type: 'CommentEdge', resolve: (p) => (p as { commentEdge?: Wrapped }).commentEdge ?? null },
      subject: { type: 'Node', resolve: () => null },
    },
  };
}
schema.CommentEdge = {
  kind: 'OBJECT',
  fields: {
    node: { type: 'IssueComment', resolve: (e) => (e as { node: Wrapped }).node },
    cursor: { type: 'String!', resolve: () => cursorOf(0) },
  },
};

// The merge itself lives in merge.ts to avoid a cycle; app.ts injects it.
// (store-level import here keeps graphql.ts self-contained for queries.)
import { mergePullRequest as mergePullImpl } from './merge.ts';
function mergePull(repo: RepoRec, pull: PullRec, method: string): { ok: boolean; error: string } {
  return mergePullImpl(repo, pull, method);
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function executeSelectionSet(
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  doc: Document,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = schema[typeName];
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, sel.selection, doc, ctx));
      } else if (source && typeof source === 'object' && (source as Wrapped).__type === sel.typeCondition) {
        Object.assign(out, executeSelectionSet(sel.typeCondition, (source as Wrapped).value, sel.selection, doc, ctx));
      }
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = doc.fragments.get(sel.name);
      if (frag) Object.assign(out, executeSelectionSet(typeName, source, frag, doc, ctx));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = typeDef?.fields?.[field.name];
    if (!fieldDef) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, ctx.vars);
    let value: unknown;
    try {
      value = fieldDef.resolve(source as never, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, doc, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, doc: Document, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(v, field, doc, ctx));
  if (typeof value === 'object' && (value as Wrapped).__type) {
    const wrapped = value as Wrapped;
    if (!field.selection) return wrapped.value;
    return executeSelectionSet(wrapped.__type, wrapped.value, field.selection, doc, ctx);
  }
  return value;
}

export function executeGraphQL(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((doc) => executeGraphQL(doc));
  const req = (body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (typeof req.query !== 'string') {
    return { errors: [{ message: 'a query is required' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(req.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const op = req.operationName
    ? doc.operations.find((o) => o.name === req.operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (!op) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { vars: req.variables ?? {}, errors: [] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, op.selection, doc, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
