# Publishing @twinforce/homebridge-miot

The package is **public** on **https://registry.npmjs.org**. Its public source repository remains **https://github.com/TwinForceIT/homebridge-miot**. The publishing npm account must have access to the `@twinforce` scope; owning the GitHub organization does not grant npm permissions.

## Publishing from a local checkout

The first public release, `0.1.0`, has already been published. For subsequent releases, choose a new version; npm does not allow publishing the same package name and version again.

Use a signed-in npm account with publishing access to `@twinforce`. If this is an npm organization, the account must belong to a team with the appropriate package permissions. Complete any two-factor authentication required by npm.

From a clean checkout containing the intended release:

```sh
npm login --scope=@twinforce --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm ci
npm publish --access public
```

Update the package version and lockfile before publishing. `prepublishOnly` runs type checks, tests, and the build. `prepack` ensures compiled JavaScript is present. Only the declared package files are included; Homebridge users do not need TypeScript or development dependencies.

After publishing, check the registry:

```sh
npm view @twinforce/homebridge-miot version --registry=https://registry.npmjs.org
```

Also verify installation from an environment without npm credentials. Do not put tokens or passwords in repository files. The project's `.npmrc` contains only the public scope-to-registry mapping.

## Automated releases

The `.github/workflows/publish.yml` workflow uses npm Trusted Publishing through OIDC, without a long-lived npm token in GitHub. Before using it, configure the following trusted publisher in the existing package's settings on npmjs.com:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `TwinForceIT` |
| Repository | `homebridge-miot` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed actions | Allow direct `npm publish` |

Adding the workflow to GitHub does not configure npm automatically. Automated publishing will fail until this trust relationship exists. The workflow uses Node 24, an npm version supporting OIDC, a GitHub-hosted runner, and the `id-token: write` permission. npm includes provenance when a public package is published from a public repository.

Once Trusted Publishing is configured, create a release from a clean checkout:

```sh
npm version patch
git push origin main --follow-tags
```

Use the appropriate version increment for the release. The tag must exactly match `v` followed by the version in `package.json`. The workflow checks this, runs tests on Node 22/24/26, and publishes the public package. Stable versions use the `latest` dist-tag; prerelease versions use `next`. An ordinary push to `main` does not publish a package. A manually triggered workflow also requires selecting the matching release tag.

Do not trigger GitHub Actions to republish a version already published locally. Configure Trusted Publishing first, then increment the version for the next release.

## References

- [Public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [Publishing an npm organization-scoped package](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)
- [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
