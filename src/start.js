// Starts the RecoverKit server from .env / environment variables.
// Used by `node src/server.js`, `npm start`, and cPanel's app.cjs.
import { existsSync } from 'node:fs';
import { loadDotEnv, readConfig } from './config.js';
import { createApp } from './server.js';

loadDotEnv();
const config = readConfig();
if (!existsSync(config.dbPath)) console.log(`Creating database at ${config.dbPath}`);
console.warn(`Email for invites and password resets: ${config.mail.mode === 'none' ? 'not set up (add RK_MAIL_FROM to .env)' : config.mail.mode === 'smtp' ? `SMTP via ${config.mail.host}:${config.mail.port}` : config.mail.mode}`);
if (!config.publicUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.publicUrl)) {
  console.warn('WARNING: RK_PUBLIC_URL is not https. Run behind TLS in production (cookies are only marked Secure on https).');
}
const app = await createApp({ config });
// Hosting panels (cPanel/Passenger, Render, Railway…) tell the app which port to use through PORT.
const port = Number(process.env.PORT || config.port);
app.server.listen(port, config.host, () => {
  console.log(`RecoverKit listening on http://${config.host}:${port}  (public URL ${config.publicUrl})`);
  console.log(config.ai.provider === 'none' ? 'Default AI: none (templates). Businesses can choose a model in the dashboard.' : `Default AI: ${config.ai.provider} / ${config.ai.model}`);
});
const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
