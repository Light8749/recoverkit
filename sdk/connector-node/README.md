# recoverkit-connector

Read-only RecoverKit connector for **MongoDB** apps. It runs on your own server, reads your database where it lives, and sends RecoverKit only hashed IDs, event types, dates and amounts. Nothing is exported, and nothing on the internet can call in.

```bash
npx recoverkit-connector detect /path/to/your/app        # finds your MongoDB connection string (credentials hidden)
npx recoverkit-connector setup  --app=/path/to/your/app  # looks at names only, suggests a mapping, dry run, saves it
npx recoverkit-connector sync   --app=/path/to/your/app  # first run sends history, then only what's new (cron)
```

Set `RK_PUBLIC_KEY`, `RK_SECRET_KEY` and `RK_ENDPOINT` (from your RecoverKit dashboard) in the environment or in your app's `.env`. Use a MongoDB login with only the `read` role: setup checks this, and prints the command to create one.

The business's RecoverKit dashboard has a **Developers** page with these commands filled in, and every RecoverKit server has full docs at `/docs`.

SQL databases (MySQL, MariaDB, PostgreSQL, SQLite) use the PHP connector: download it from the business's RecoverKit server at `/sdk/recoverkit-php.zip`, or see https://github.com/Light8749/recoverkit

License: MIT. See LICENSE.
