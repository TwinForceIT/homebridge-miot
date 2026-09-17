# Publishing @twinforce/homebridge-miot

The package is public on [npm](https://www.npmjs.com/package/@twinforce/homebridge-miot). Its [GitHub repository](https://github.com/TwinForceIT/homebridge-miot) also remains public.

## One-time npm setup

A package maintainer must configure **Trusted Publisher** in the package's **Settings** on npmjs.com. Owning the GitHub organization does not grant npm package permissions.

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `TwinForceIT` |
| Repository | `homebridge-miot` |
| Workflow filename | `publish.yml` (filename only) |
| Environment name | Leave empty |
| Allowed actions | Enable direct **`npm publish`** |

New trusted publishers may default to staged publishing only. Direct publishing must be enabled for unattended releases. Save the configuration and complete npm's account verification if requested.

GitHub Actions must be enabled for this repository and allowed to use `actions/checkout` and `actions/setup-node`. No npm token, GitHub personal access token, repository secret, or environment is required. The workflow requests only `contents: read` and, in the publishing job, `id-token: write`. It uses GitHub-hosted runners, Node 24, and pinned npm 11.8.0 (trusted publishing requires npm 11.5.1 or later). npm automatically attaches provenance for this public repository and package.

Saving the workflow does not create the npm trust relationship. The first publication cannot succeed until the npm settings above are saved.

## Every push or merge to main

The default branch is **`main`**, not `master`. `.github/workflows/publish.yml` starts on every push to `main`, including merged pull requests and documentation-only changes:

1. Check out the exact source commit and run type checks, tests, build, and package inspection on Node 22, 24, and 26.
2. Read the public npm release history and select the next stable patch version, for example `0.2.1` → `0.2.2`.
3. Stamp that version into `package.json` and both root lockfile entries on the runner.
4. Publish to the public registry with the `latest` tag using npm Trusted Publishing. Package lifecycle checks must also pass before publication.
5. Record the published version and package link in the workflow's run summary.

Pull requests and other branches are tested by `ci.yml` and never published. The publishing workflow can also be run manually from **Actions → Publish to npm → Run workflow**, selecting `main`.

There are no automatic commits back to the repository and no tag-triggered release loops. The version in the source checkout is a **minimum requested release version**, not necessarily the current npm version; the installed package always contains its actual published version. Each release records its source commit and workflow run ID in npm metadata, in addition to provenance.

To request a larger release, set a stable version higher than every published stable version in both package files, for example:

```sh
npm version minor --no-git-tag-version
```

Check the current npm version first: if the checkout's version lags behind npm, set an explicit higher version instead. Commit and push the change normally. Prereleases are rejected by this stable-release workflow.

## Queueing, retries, and recovery

Releases share one queue, so version selection and publication cannot race with another run of this workflow. GitHub allows up to 100 pending runs with `queue: max`; avoid overlapping manual publication from a developer machine. A failed check or registry request fails the run without publishing.

Rerunning a commit already present on npm is a successful no-op. An older commit whose descendant was already published is also skipped, preventing an old rerun or out-of-order queued run from rolling back `latest`. Divergent or unreadable source history fails the release instead of guessing. The first automated release accepts the existing manually published versions without commit metadata and establishes this source tracking.

If npm trust setup was missing or publication failed, fix the cause and choose **Re-run failed jobs** on the affected workflow. Do not bump the version just to retry. If npm accepted a release before the runner lost its connection, a retry detects its recorded source commit and does not publish it twice. Do not unpublish versions and expect the same version number to become reusable.

Read the run summary in [GitHub Actions](https://github.com/TwinForceIT/homebridge-miot/actions/workflows/publish.yml) and verify the public registry:

```sh
npm view @twinforce/homebridge-miot version --registry=https://registry.npmjs.org
npm view @twinforce/homebridge-miot@latest x-homebridge-miot-release --json
```

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow concurrency and queueing](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Public scoped npm packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
