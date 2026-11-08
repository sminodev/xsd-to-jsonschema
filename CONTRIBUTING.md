# Contributing

Thanks for helping. [docs/development.md](docs/development.md) has everything you need: the setup, how the converter
works, how to find out why a schema looks wrong, and how to add support for another XML Schema feature.

In short:

- You need Node.js 22.12 or later. `npm ci` installs everything, `npm test` runs the tests.
- Every change comes with a test that fails without it; see [Pull requests](docs/development.md#pull-requests).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). `feat:` and `fix:` messages
  end up in the changelog.
