# zeee0404-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zeee0404/zeee0404-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zeee0404/zeee0404-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in a single Node program: git smart HTTP (protocol v0 and v2 — advertisement, ls-refs, fetch with real packfiles, receive-pack with fast-forward checks and report-status), the REST v3 resources (repositories, branches, git refs, commits, contents, labels, issues, pull requests with real merges), the GraphQL v4 surface gh and github-mcp-server speak (including `__type` introspection), and an MCP endpoint exposing the forge as agent tools. All four surfaces share one store of genuine git objects — SHA-1 content addressing, zlib packfiles, delta resolution — so a commit minted by the contents API is the same object a clone fetches and a merge builds on. State is in memory: a fresh process is a fresh, empty forge.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, serves until the env answers `{"done": true}` at `/done`, and exits 0. The server itself lives in `app.ts`; `store.ts` holds the object database and forge state, `git.ts` the smart-HTTP transport, `graphql.ts` the GraphQL engine, and `merge.ts` the pull-request merge logic shared by all surfaces.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zc1gf6fe&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
