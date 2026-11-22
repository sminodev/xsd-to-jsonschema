# Contributing

The [development guide](docs/development.md) covers setup, code structure and debugging.

- Use Node.js 22.13.0 or a later 22.x release, Node.js 24, or Node.js 26. Install dependencies with `npm ci` and run
  the tests with `npm test`.
- Keep pull requests focused and include a regression test for behavior changes. Update the
  [output documentation](docs/output.md) when a mapping changes.
- Run the checks listed under [Pull requests](docs/development.md#pull-requests) before submitting a change.
- Use [Conventional Commits](https://www.conventionalcommits.org) and record user-facing changes in the unreleased
  section of [CHANGELOG.md](CHANGELOG.md).
