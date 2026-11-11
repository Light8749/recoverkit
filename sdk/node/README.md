# recoverkit

RecoverKit server SDK for Node.js. Tell RecoverKit who your customers are and when a real sale happens, so it can follow up with people who signed up and never bought, or bought once and went quiet.

```bash
npm install recoverkit
```

```js
import { RecoverKit } from 'recoverkit';

const rk = new RecoverKit({
  publicKey: process.env.RK_PUBLIC_KEY,   // rk_pub_...
  secretKey: process.env.RK_SECRET_KEY,   // rk_sec_... server only
  endpoint: process.env.RK_ENDPOINT,      // the business's RecoverKit server, e.g. https://recover.example.com
});

// After sign-up or login:
await rk.identify({ email: user.email, phone: user.phone, firstName: user.firstName });

// When a sale really succeeds (amount in minor units: kobo, cents):
await rk.trackPurchase({ email: user.email, amount: 150000, ref: order.reference });

// Wallet apps (VTU, betting, fintech): a deposit is not a sale.
await rk.walletFunded({ email: user.email, amount: 500000 });

// Right to erasure:
await rk.erase({ email: user.email });
```

- Emails and phone numbers are hashed on your server before they're sent. Contact details are sent only for `identify` (pass `shareContact: false` to keep them), so RecoverKit can message the person; they're stored encrypted.
- Calls time out after 3 seconds and never throw (set `throwOnError: true` while testing), so RecoverKit can never break a checkout.
- Pass your order or payment reference as `ref`: a sale reported by your server and by a gateway webhook is counted once.

Get your keys from the business's RecoverKit dashboard (**Developers** page). Every RecoverKit server has full docs at `/docs`.

Node.js 18+. No dependencies. MIT License.
