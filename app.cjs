// Startup file for cPanel "Setup Node.js App" (Phusion Passenger), which loads apps with require().
// RecoverKit is an ES module, so this hands over to it with a dynamic import.
// node:sqlite prints an "experimental" warning on every start; it's expected, so keep the log clean.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message || w).includes('SQLite is an experimental') ? undefined : emitWarning.call(process, w, ...rest));
import('./src/start.js').catch((err) => {
  console.error('RecoverKit failed to start:', err);
  process.exit(1);
});
