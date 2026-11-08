# Contributing

The [development guide](docs/development.md) covers setup, code structure and debugging.

- Use Node.js 22.12 or later. `npm ci` installs the dependencies; `npm test` runs the tests.
- Keep pull requests focused and include a regression test for behavior changes. Update the
  [output documentation](docs/output.md) when a mapping changes.
- Run the checks listed under [Pull requests](docs/development.md#pull-requests) before submitting a change.
- Use [Conventional Commits](https://www.conventionalcommits.org) and record user-facing changes in the unreleased
  section of [CHANGELOG.md](CHANGELOG.md).
