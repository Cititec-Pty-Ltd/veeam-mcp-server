# Cititec fork

This is Cititec's fork of [veeam-ai/veeam-mcp-server](https://github.com/veeam-ai/veeam-mcp-server).
The upstream project is licensed under MIT; that licence and its notices still apply to this fork.

Read this before changing anything here: it says which changes go back to Veeam and which stay
in this fork.

## What Cititec uses

Only `servers/vi-mcp` (the Veeam Intelligence MCP server). The **Cititec release** workflow
tests it, builds it and pushes the image to `ghcr.io/cititec-pty-ltd/veeam-vi-mcp`, tagged
`latest` and `v<package.json version>-<short commit>`. It runs when a change to
`servers/vi-mcp/` reaches `main`, or from the Actions tab (**Run workflow**).
`servers/vbr-mcp` is not built or used.

## Two kinds of change

| Kind of change | Branch from | Goes to |
|----------------|-------------|---------|
| Fix or improvement that is useful to everyone | Veeam's current `main` (`upstream/main`) | A PR to `veeam-ai/veeam-mcp-server`, **and** the same branch merged into our `main` |
| Cititec-only: `cititec-*.yml` workflows, this file, the note at the top of `README.md` | Our `main` | Our `main` only - never in a PR to Veeam |

Never open a PR to Veeam from our `main`: it carries the Cititec-only changes.

## Set up once

```bash
git clone https://github.com/Cititec-Pty-Ltd/veeam-mcp-server.git
cd veeam-mcp-server
git remote add upstream https://github.com/veeam-ai/veeam-mcp-server.git
```

## Send a fix to Veeam

```bash
git fetch upstream --no-tags
git switch -c fix/<short-name> upstream/main
# make the change and add tests
git push -u origin fix/<short-name>

# PR to Veeam
gh pr create --repo veeam-ai/veeam-mcp-server --base main --head Cititec-Pty-Ltd:fix/<short-name>
# The same branch into our main, so we have the fix straight away
gh pr create --repo Cititec-Pty-Ltd/veeam-mcp-server --base main --head fix/<short-name>
```

Both this fork and Veeam's repository are **public**. Keep commits, tests and PR text free of
client names, hostnames, user names, server addresses and other internal details - use
made-up example values (`vspc-srv.local`, a dummy GUID).

## Bring Veeam's updates in

```bash
git fetch upstream --no-tags
git switch -c sync/veeam-manual main
git merge upstream/main     # merge - never rebase
# resolve any conflicts, keeping Cititec's version of Cititec-only lines
git push -u origin sync/veeam-manual
gh pr create --repo Cititec-Pty-Ltd/veeam-mcp-server --base main --head sync/veeam-manual
```

Merge the PR with a **merge commit** (not squash), so the fork records Veeam's commits as
merged. Do not rebase our `main` or force-push it.

## Weekly Veeam check (automatic)

The **Cititec Veeam sync** workflow (`.github/workflows/cititec-veeam-sync.yml`) runs every
Tuesday morning (Australian time), and can also be started from the Actions tab
(**Run workflow**):

- Up to date with Veeam: nothing happens.
- New Veeam commits that merge cleanly: it creates a `sync/veeam-<sha>` branch, runs install,
  build and tests of `servers/vi-mcp` on the merged code, and opens a PR into `main`.
  **Review and merge it yourself** (merge commit) - nothing is merged automatically. If CI
  does not start on that PR, close and reopen it.
- Conflicts, Veeam changes to `.github/workflows/`, or PR creation not allowed: it opens an
  issue saying what to merge by hand.

## After a release

A new image changes nothing on the MCP host until its digest is pinned there. Follow the
internal runbook in the private Cititec-Pty-Ltd/Cititec repository
(`claude/mcp-host/README.md`), and update the `cititec-mcp-servers` skill if tools changed.

## Protection

- Ruleset **Protect main**: `main` cannot be deleted or force-pushed.
- Only organization owners can delete repositories in Cititec-Pty-Ltd.
- If Veeam deletes or privatises the upstream repository, this fork stays.
