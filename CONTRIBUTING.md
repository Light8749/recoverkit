# Contributing to RecoverKit

Thanks for your interest! RecoverKit is source-available (see [LICENSE](LICENSE)), and feedback from developers who try it on real projects is the most valuable contribution of all.

## Ways to help

- **Try it and tell us what broke.** Open an issue with your stack (framework, database, payment gateway), what you ran, and what happened. Please never paste real customer data, API keys or database passwords into an issue.
- **Report a mapping the connector got wrong.** If `setup` misread your tables, share the table and column *names* (not rows) and what the right answer was. That improves the built-in guesses for everyone.
- **Suggest a gateway, framework or database** we don't support yet.
- **Security issues:** please don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

Small, focused PRs are easiest to review. Before you start on something big, open an issue to discuss it.

1. Fork the repo and create a branch.
2. `npm install`, then make your change.
3. Run `npm run check` and `npm test`. If you touched a connector, also run `npm run test:mysql` and `npm run test:mongo`. Add or update tests for the behaviour you changed.
4. Keep the existing style: no new runtime dependencies without discussion, parameterised queries only, and the connectors stay read-only.

By opening a pull request, you agree that your contribution may be used, changed and distributed by the copyright holder as part of RecoverKit under any license, and you confirm that you have the right to grant that.

## Development notes

- Node.js 22.13+ (`nvm use` picks Node 24 from `.nvmrc`). PHP 7.4+ with PDO is needed for the PHP SDK and connector.
- `npm run demo` starts a dashboard with sample data at http://localhost:8790.
- The full guide is in [docs/GUIDE.md](docs/GUIDE.md).
