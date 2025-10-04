# Veo Guide – Paystack modal + Meta CAPI + Mongo

## Prereqs
- Node.js 18+ and npm
- MongoDB running locally (or use a cloud URI)
- Paystack account (Test keys)
- Meta Pixel ID + Access Token (Events Manager)
- (Dev) ngrok (or similar) to receive webhooks on localhost

## Setup
1. `npm i`
2. Copy `.env.example` → `.env` and fill:
   - `PAYSTACK_PUBLIC_KEY` and `PAYSTACK_SECRET_KEY`
   - `MONGODB_URI`
   - `FB_PIXEL_ID` and `FB_ACCESS_TOKEN`
   - `SITE_URL` (in dev keep `http://localhost:3000`)
   - `DRIVE_LINK` and `WHATSAPP_GROUP_URL`
3. `npm run start` (or `npm run dev` with nodemon)

## Webhook (very important)
- In Paystack Dashboard → **Settings → API Keys & Webhooks**
- Set Webhook URL to: `https://YOUR-NGROK-ID.ngrok.io/api/paystack/webhook`
- In dev, run: `ngrok http 3000`
- Paystack will send `charge.success` to that URL. We verify the `x-paystack-signature` HMAC SHA512.

## Test flow (Test Mode)
1. Open `http://localhost:3000/`
2. Click CTA → modal appears (Inline v2, no redirect)
3. Use Paystack test card (e.g., 4084 0840 8408 4081…)
4. On success, we verify on the server, then redirect to `/paycomplete.html?ref=...`
5. The success page calls `/api/purchase/complete` → sends **Meta CAPI Purchase** once.
6. Check Events Manager → Test Events to see it arrive.

## Notes
- **Inline modal**: we use Paystack Inline v2 (`https://js.paystack.co/v2/inline.js`).
- **Verify before fulfill**: Don’t fulfill on the client. We verify via `/transaction/verify/:reference` server-side (and also get a `charge.success` webhook).
- **CAPI dedup**: `event_id = reference`. Sent once, retried if needed.
- **_fbc/_fbp**: If we see `fbclid`, we turn that into `_fbc` as `fb.1.<timestamp>.<fbclid>`. We also generate `_fbp` if missing.
- **Receipts with note**: Paystack can send its own notifications, but to include your custom message & link we send our **own** email (optional SMTP in `.env`). 
