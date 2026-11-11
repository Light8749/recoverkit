// Startup file for cPanel "Setup Node.js App" (Phusion Passenger), which loads apps with require().
// RecoverKit is an ES module, so this hands over to it with a dynamic import.
import('./src/start.js').catch((err) => {
  console.error('RecoverKit failed to start:', err);
  process.exit(1);
});
