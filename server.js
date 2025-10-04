/**
 * server.js - FINAL VERSION
 * ✅ All Meta CAPI required fields
 * ✅ Telegram notifications (optional)
 * ✅ Test event code support
 * ✅ Mobile-optimized
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();

const {
  PORT = 3000,
  SITE_URL,
  PAYSTACK_PUBLIC_KEY,
  PAYSTACK_SECRET_KEY,
  PAYSTACK_WEBHOOK_SECRET,
  MONGODB_URI,
  FB_PIXEL_ID,
  FB_ACCESS_TOKEN,
  FB_GRAPH_VERSION = 'v23.0',
  FB_TEST_EVENT_CODE, // Optional: for testing events
  TELEGRAM_BOT_TOKEN,  // Optional: for notifications
  TELEGRAM_CHAT_ID,    // Optional: your chat ID
  PRODUCT_NAME,
  PRODUCT_ID,
  PRODUCT_PRICE_NGN,
  PRODUCT_PRICE_KOBO,
  CURRENCY = 'NGN',
  DRIVE_LINK,
  WHATSAPP_GROUP_URL
} = process.env;

// MongoDB Setup
mongoose.connect(MONGODB_URI, { autoIndex: true })
  .then(() => console.log('✓ MongoDB connected'))
  .catch((e) => console.error('✗ MongoDB error:', e.message));

const OrderSchema = new mongoose.Schema({
  reference: { type: String, index: true, unique: true },
  email: String,
  firstName: String,
  lastName: String,
  amount: Number,
  currency: String,
  ip: String,
  userAgent: String,
  fbclid: String,
  fbc: String,
  fbp: String,
  country: { type: String, default: 'NG' },
  status: { type: String, enum: ['initialized', 'success', 'failed'], default: 'initialized' },
  verifiedAt: Date,
  capi: {
    sent: { type: Boolean, default: false },
    lastTriedAt: Date,
    tries: { type: Number, default: 0 },
    response: mongoose.Schema.Types.Mixed
  },
  telegram: {
    sent: { type: Boolean, default: false },
    lastTriedAt: Date,
    response: mongoose.Schema.Types.Mixed
  },
  successToken: String,
  tokenExpiresAt: Date,
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

OrderSchema.index({ status: 1, 'capi.sent': 1 });
OrderSchema.index({ successToken: 1, tokenExpiresAt: 1 });

const Order = mongoose.model('Order', OrderSchema);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));
function rawBodySaver(req, res, buf) { if (buf && buf.length) req.rawBody = buf.toString('utf8'); }

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
});

const graphUrl = `https://graph.facebook.com/${FB_GRAPH_VERSION}/${FB_PIXEL_ID}/events`;

const normalizeEmail = (email) => (email || '').trim().toLowerCase();
const sha256 = (value) => crypto.createHash('sha256').update(value || '').digest('hex');

function setCookie(res, name, value, days = 365) {
  res.cookie(name, value, {
    httpOnly: false,
    sameSite: 'Lax',
    maxAge: days * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

// Telegram notification helper (optional)
async function sendTelegramNotification(order, eventData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'Telegram not configured' };
  }

  try {
    const message = `
🎉 *NEW SALE - ${order.currency} ${(order.amount / 100).toLocaleString()}*

*CUSTOMER DETAILS*
📧 Email: \`${order.email}\`
👤 Name: ${order.firstName || 'N/A'} ${order.lastName || 'N/A'}
📱 Phone: N/A (not collected)

*ORDER INFO*
🔖 Reference: \`${order.reference}\`
💵 Amount: ${order.currency} ${(order.amount / 100).toLocaleString()}
🕐 Time: ${new Date(order.verifiedAt || order.createdAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}

*TRACKING DATA*
🌐 IP: \`${order.ip || 'N/A'}\`
🖥️ User-Agent: \`${order.userAgent?.substring(0, 60) || 'N/A'}...\`
🔗 FBC (Click ID): \`${order.fbc || 'N/A'}\`
🍪 FBP (Browser ID): \`${order.fbp || 'N/A'}\`
🌍 Country: ${order.country || 'NG'}

*META CAPI EVENT*
Event Name: Purchase
Event ID: \`${order.reference}\`
Status: ${eventData?.capiSent ? '✅ Successfully Sent' : '⏳ Pending/Retrying'}

*QUICK ACTIONS*
• Reply to: ${order.email}
• View in DB: Reference ${order.reference}
    `.trim();

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const { data } = await axios.post(telegramUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });

    return { sent: true, response: data };
  } catch (err) {
    console.error('Telegram notification failed:', err.response?.data || err.message);
    return { sent: false, error: err.response?.data || err.message };
  }
}

// API: Config
app.get('/api/config', (req, res) => {
  res.json({
    publicKey: PAYSTACK_PUBLIC_KEY,
    product: {
      id: PRODUCT_ID,
      name: PRODUCT_NAME,
      amountKobo: Number(PRODUCT_PRICE_KOBO),
      currency: CURRENCY
    },
    siteUrl: SITE_URL
  });
});

// API: Capture visitor (IP + User-Agent)
app.post('/api/visitor', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const userAgent = req.headers['user-agent'] || '';
  
  setCookie(res, '_vip', ip, 30);
  setCookie(res, '_vua', userAgent, 30);
  
  res.json({ ok: true, ip, userAgent });
});

// API: Identify (fbclid -> _fbc, _fbp)
app.post('/api/identify', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const { fbclid, fbc, fbp } = req.body || {};

  const _fbc = fbc || (fbclid ? `fb.1.${now}.${fbclid}` : (req.cookies._fbc || null));
  const _fbp = fbp || req.cookies._fbp || `fb.1.${now}.${Math.floor(Math.random() * 1e10)}`;

  if (_fbc) setCookie(res, '_fbc', _fbc, 90);
  if (_fbp) setCookie(res, '_fbp', _fbp, 90);
  if (fbclid) setCookie(res, 'fbclid', fbclid, 7);

  res.json({ ok: true, _fbc, _fbp, fbclid: fbclid || req.cookies.fbclid || null });
});

// API: Initialize Transaction
app.post('/api/tx/init', async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Email is required' });

    const ip = req.cookies._vip || (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip);
    const userAgent = req.cookies._vua || req.headers['user-agent'] || '';
    const _fbc = req.cookies._fbc || null;
    const _fbp = req.cookies._fbp || null;
    const fbclid = req.cookies.fbclid || null;

    const reference = `GV3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const initPayload = {
      email,
      amount: Number(PRODUCT_PRICE_KOBO),
      currency: CURRENCY,
      reference,
      metadata: {
        custom_fields: [
          { display_name: 'Product', variable_name: 'product', value: PRODUCT_NAME },
          { display_name: 'Buyer Name', variable_name: 'buyer_name', value: `${firstName || ''} ${lastName || ''}`.trim() }
        ],
        firstName, lastName, productId: PRODUCT_ID,
        fbclid, _fbc, _fbp, ip
      }
    };

    const { data } = await paystack.post('/transaction/initialize', initPayload);
    if (!data || data.status !== true) {
      return res.status(400).json({ ok: false, error: 'Paystack initialization failed', details: data });
    }

    await Order.create({
      reference,
      email, firstName, lastName,
      amount: Number(PRODUCT_PRICE_KOBO),
      currency: CURRENCY,
      ip,
      userAgent,
      fbclid, fbc: _fbc, fbp: _fbp,
      status: 'initialized'
    });

    res.json({
      ok: true,
      reference,
      access_code: data.data.access_code,
      publicKey: PAYSTACK_PUBLIC_KEY
    });
  } catch (e) {
    console.error('tx/init error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// API: Verify Transaction
app.get('/api/tx/verify', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ ok: false, error: 'reference is required' });

  try {
    const { data } = await paystack.get(`/transaction/verify/${reference}`);
    const status = data?.data?.status;
    const paid = status === 'success';
    const amount = data?.data?.amount;

    const order = await Order.findOne({ reference });
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });

    if (paid && amount !== order.amount) {
      console.error(`Amount mismatch: expected ${order.amount}, got ${amount}`);
      return res.status(400).json({ ok: false, error: 'Amount mismatch' });
    }

    if (paid) {
      order.status = 'success';
      order.verifiedAt = new Date();
      
      const token = uuidv4();
      order.successToken = token;
      order.tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await order.save();

      return res.json({
        ok: true,
        verified: true,
        token,
        redirect: `/paycomplete.html?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`
      });
    } else {
      order.status = 'failed';
      await order.save();
      return res.json({ ok: false, verified: false, status });
    }
  } catch (e) {
    console.error('verify error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

// Webhook: Paystack charge.success
app.post('/webhooks/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secret = PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
  const computed = crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex');

  if (signature !== computed) {
    console.error('Invalid webhook signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body?.event;
  if (event === 'charge.success') {
    const ref = req.body?.data?.reference;
    const amount = req.body?.data?.amount;
    
    if (ref) {
      const order = await Order.findOne({ reference: ref });
      if (order) {
        if (amount !== order.amount) {
          console.error(`Webhook amount mismatch for ${ref}`);
        } else if (order.status !== 'success') {
          order.status = 'success';
          order.verifiedAt = new Date();
          await order.save();
          console.log(`✓ Webhook confirmed payment for ${ref}`);
        }
      }
    }
  }

  res.sendStatus(200);
});

// API: Confirm Order & Send CAPI + Telegram
app.get('/api/order/confirm', async (req, res) => {
  const { ref, token } = req.query || {};
  if (!ref || !token) return res.status(400).json({ ok: false, error: 'ref and token required' });

  const order = await Order.findOne({ reference: ref });
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  if (order.successToken !== token) return res.status(403).json({ ok: false, error: 'Invalid token' });
  
  if (order.tokenExpiresAt && new Date() > order.tokenExpiresAt) {
    return res.status(403).json({ ok: false, error: 'Token expired' });
  }
  
  if (order.status !== 'success') {
    return res.status(409).json({ ok: false, error: 'Payment not confirmed yet' });
  }

  // Send CAPI event (one-time)
  let capiSent = order.capi.sent;
  if (!order.capi.sent) {
    try {
      const payload = buildCapiPayload(order);
      const { data } = await axios.post(graphUrl, payload, {
        params: { access_token: FB_ACCESS_TOKEN }
      });

      order.capi = {
        sent: true,
        lastTriedAt: new Date(),
        tries: (order.capi?.tries || 0) + 1,
        response: data
      };
      await order.save();
      capiSent = true;
      console.log(`✓ CAPI event sent for ${ref}`);
    } catch (err) {
      console.error('CAPI send failed:', err.response?.data || err.message);
      order.capi = {
        sent: false,
        lastTriedAt: new Date(),
        tries: (order.capi?.tries || 0) + 1,
        response: { error: err.response?.data || err.message }
      };
      await order.save();
    }
  }

  // Send Telegram notification (one-time, optional)
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !order.telegram?.sent) {
    const telegramResult = await sendTelegramNotification(order, { capiSent });
    order.telegram = {
      sent: telegramResult.sent,
      lastTriedAt: new Date(),
      response: telegramResult
    };
    await order.save();
    if (telegramResult.sent) {
      console.log(`✓ Telegram notification sent for ${ref}`);
    }
  }

  res.json({
    ok: true,
    drive: DRIVE_LINK,
    whatsapp: WHATSAPP_GROUP_URL,
    product: { id: PRODUCT_ID, name: PRODUCT_NAME },
    order: { 
      reference: order.reference, 
      email: order.email, 
      firstName: order.firstName,
      amount: order.amount, 
      currency: order.currency 
    },
    capiSent: order.capi.sent === true,
    telegramSent: order.telegram?.sent === true
  });
});

// Build CAPI Payload with ALL Required Fields + Test Event Code
function buildCapiPayload(order) {
  const eventId = order.reference;
  const eventTime = Math.floor((order.verifiedAt || Date.now()) / 1000);
  const sourceUrl = `${SITE_URL}/paycomplete.html?ref=${encodeURIComponent(order.reference)}`;

  const user_data = {
    em: [sha256(normalizeEmail(order.email))],
    fn: order.firstName ? [sha256(normalizeEmail(order.firstName))] : undefined,
    ln: order.lastName ? [sha256(normalizeEmail(order.lastName))] : undefined,
    external_id: [sha256(normalizeEmail(order.email))],
    client_ip_address: order.ip || undefined,
    client_user_agent: order.userAgent || undefined,
    fbc: order.fbc || undefined,
    fbp: order.fbp || undefined,
    country: order.country ? [sha256(order.country.toLowerCase())] : undefined
  };

  Object.keys(user_data).forEach(key => user_data[key] === undefined && delete user_data[key]);

  const eventData = {
    event_name: 'Purchase',
    event_time: eventTime,
    event_source_url: sourceUrl,
    action_source: 'website',
    event_id: eventId,
    user_data,
    custom_data: {
      currency: order.currency || 'NGN',
      value: Number(order.amount) / 100,
      content_name: PRODUCT_NAME,
      content_ids: [PRODUCT_ID],
      content_type: 'product',
      contents: [
        { 
          id: PRODUCT_ID, 
          quantity: 1, 
          item_price: Number(order.amount) / 100 
        }
      ]
    }
  };

  // Add test_event_code if configured (for testing in Events Manager)
  const payload = { data: [eventData] };
  if (FB_TEST_EVENT_CODE) {
    payload.test_event_code = FB_TEST_EVENT_CODE;
    console.log(`📊 Using test event code: ${FB_TEST_EVENT_CODE}`);
  }

  return payload;
}

// CAPI Retry Worker
setInterval(async () => {
  try {
    const unsent = await Order.find({
      status: 'success',
      'capi.sent': { $ne: true },
      'capi.tries': { $lt: 5 }
    }).limit(10);

    for (const order of unsent) {
      try {
        const payload = buildCapiPayload(order);
        const { data } = await axios.post(graphUrl, payload, {
          params: { access_token: FB_ACCESS_TOKEN }
        });
        
        order.capi = { 
          sent: true, 
          lastTriedAt: new Date(), 
          tries: (order.capi?.tries || 0) + 1, 
          response: data 
        };
        await order.save();
        console.log(`✓ CAPI retry success for ${order.reference}`);
      } catch (err) {
        order.capi = {
          sent: false,
          lastTriedAt: new Date(),
          tries: (order.capi?.tries || 0) + 1,
          response: { error: err.response?.data || err.message }
        };
        await order.save();
        console.error(`✗ CAPI retry failed for ${order.reference}`);
      }
    }
  } catch (e) {
    console.error('CAPI worker error:', e.message);
  }
}, 60 * 1000);

// Start Server
app.listen(PORT, () => {
  console.log(`\n✓ Server running on ${SITE_URL}`);
  console.log(`✓ Paystack: ${PAYSTACK_PUBLIC_KEY ? 'Configured' : 'Missing keys'}`);
  console.log(`✓ Meta CAPI: ${FB_PIXEL_ID && FB_ACCESS_TOKEN ? 'Configured' : 'Missing credentials'}`);
  console.log(`✓ Test Events: ${FB_TEST_EVENT_CODE ? `Enabled (${FB_TEST_EVENT_CODE})` : 'Disabled (production mode)'}`);
  console.log(`✓ Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'Enabled' : 'Disabled (optional)'}`);
});