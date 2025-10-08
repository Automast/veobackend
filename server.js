/**
 * server.js - UPDATED VERSION
 * ✅ Email-only collection on payment
 * ✅ WhatsApp phone collected on paycomplete page
 * ✅ Two Telegram messages: order event + phone number
 * ✅ Fixed CAPI with proper SHA256 hashing
 * ✅ Improved error handling and retry logic
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
const cors = require('cors');

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
  FB_TEST_EVENT_CODE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
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
  email: { type: String, required: true },
  firstName: String, // Optional - collected via WhatsApp modal
  lastName: String,  // Optional - collected via WhatsApp modal
  phone: String,     // Optional - collected via WhatsApp modal
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
    response: mongoose.Schema.Types.Mixed,
    error: String
  },
  telegram: {
    orderSent: { type: Boolean, default: false },
    phoneSent: { type: Boolean, default: false },
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

// CORS
app.use(
  cors({
    origin: 'https://veoguide.netlify.app',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.options('*', cors());

app.use(express.static(path.join(__dirname, 'public')));

// Helpers
const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  timeout: 30000
});

const graphUrl = `https://graph.facebook.com/${FB_GRAPH_VERSION}/${FB_PIXEL_ID}/events`;

const normalizeEmail = (email) => (email || '').trim().toLowerCase();

/**
 * SHA256 hash function for PII data
 * Per Meta CAPI requirements: lowercase and trim before hashing
 */
const sha256 = (value) => {
  if (!value) return null;
  const normalized = String(value).toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

/**
 * Format phone number for CAPI
 * Remove all non-digits, no + sign needed for hashed version
 */
function formatPhoneForCAPI(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '');
}

function setCookie(res, name, value, days = 365, { httpOnly = false } = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const base = {
    path: '/',
    maxAge: days * 24 * 60 * 60 * 1000,
    httpOnly,
  };

  if (isProd) {
    res.cookie(name, value, {
      ...base,
      sameSite: 'None',
      secure: true,
    });
  } else {
    res.cookie(name, value, {
      ...base,
      sameSite: 'Lax',
      secure: false,
    });
  }
}

// Telegram notification for order
async function sendOrderTelegram(order, eventData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'Telegram not configured' };
  }

  try {
    const message = `
🎉 *NEW SALE - ${order.currency} ${(order.amount / 100).toLocaleString()}*

*CUSTOMER DETAILS*
📧 Email: \`${order.email}\`
${order.phone ? `📱 Phone: \`${order.phone}\`` : ''}

*ORDER INFO*
🔖 Reference: \`${order.reference}\`
💵 Amount: ${order.currency} ${(order.amount / 100).toLocaleString()}
🕐 Time: ${new Date(order.verifiedAt || order.createdAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}

*TRACKING DATA*
🌐 IP: \`${order.ip || 'N/A'}\`
🔗 FBC: \`${order.fbc || 'N/A'}\`
🍪 FBP: \`${order.fbp || 'N/A'}\`
🌍 Country: ${order.country || 'NG'}

*META CAPI EVENT*
Event: Purchase
Event ID: \`${order.reference}\`
Status: ${eventData?.capiSent ? '✅ Sent Successfully' : '⚠️ ' + (eventData?.capiError || 'Pending/Retrying')}
Tries: ${order.capi?.tries || 0}

*GUIDE DELIVERY*
📗 Drive Link: ${DRIVE_LINK}
💬 WhatsApp: ${WHATSAPP_GROUP_URL}
    `.trim();

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const { data } = await axios.post(telegramUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    }, { timeout: 10000 });

    return { sent: true, response: data };
  } catch (err) {
    console.error('❌ Order Telegram notification failed:', err.response?.data || err.message);
    return { sent: false, error: err.response?.data || err.message };
  }
}

// Telegram notification for phone number
async function sendPhoneTelegram(order) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'Telegram not configured' };
  }

  if (!order.phone) {
    return { sent: false, reason: 'No phone number' };
  }

  try {
    const message = `
📱 *WHATSAPP NUMBER COLLECTED*

*ORDER REFERENCE*
🔖 Reference: \`${order.reference}\`

*CUSTOMER INFO*
📧 Email: \`${order.email}\`
📱 WhatsApp: \`${order.phone}\`

*TIME*
🕐 Submitted: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}

*ACTION REQUIRED*
✅ Send the guide to: ${order.phone}
💬 WhatsApp Link: ${WHATSAPP_GROUP_URL}
📗 Drive Link: ${DRIVE_LINK}
    `.trim();

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const { data } = await axios.post(telegramUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    }, { timeout: 10000 });

    return { sent: true, response: data };
  } catch (err) {
    console.error('❌ Phone Telegram notification failed:', err.response?.data || err.message);
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

// API: Capture visitor
app.post('/api/visitor', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const userAgent = req.headers['user-agent'] || '';
  
  setCookie(res, '_vip', ip, 30);
  setCookie(res, '_vua', userAgent, 30);
  
  res.json({ ok: true, ip, userAgent });
});

// API: Identify
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

// API: Initialize Transaction (EMAIL ONLY)
app.post('/api/tx/init', async (req, res) => {
  try {
    const { email } = req.body;
    
    // Validation - only email required
    if (!email || !email.trim()) {
      return res.status(400).json({ ok: false, error: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

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
          { display_name: 'Product', variable_name: 'product', value: PRODUCT_NAME }
        ],
        productId: PRODUCT_ID,
        fbclid, 
        _fbc, 
        _fbp, 
        ip
      }
    };

    const { data } = await paystack.post('/transaction/initialize', initPayload);
    if (!data || data.status !== true) {
      console.error('❌ Paystack init failed:', data);
      return res.status(400).json({ ok: false, error: 'Paystack initialization failed', details: data });
    }

    await Order.create({
      reference,
      email, 
      amount: Number(PRODUCT_PRICE_KOBO),
      currency: CURRENCY,
      ip,
      userAgent,
      fbclid, 
      fbc: _fbc, 
      fbp: _fbp,
      status: 'initialized'
    });

    console.log(`✓ Payment initialized: ${reference}`);

    res.json({
      ok: true,
      reference,
      access_code: data.data.access_code,
      publicKey: PAYSTACK_PUBLIC_KEY
    });
  } catch (e) {
    console.error('❌ tx/init error:', e.response?.data || e.message);
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
    if (!order) {
      console.error(`❌ Order not found: ${reference}`);
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    if (paid && amount !== order.amount) {
      console.error(`❌ Amount mismatch for ${reference}: expected ${order.amount}, got ${amount}`);
      return res.status(400).json({ ok: false, error: 'Amount mismatch' });
    }

    if (paid) {
      order.status = 'success';
      order.verifiedAt = new Date();
      
      const token = uuidv4();
      order.successToken = token;
      order.tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await order.save();

      console.log(`✓ Payment verified: ${reference}`);

      return res.json({
        ok: true,
        verified: true,
        token,
        redirect: `/paycomplete.html?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`
      });
    } else {
      order.status = 'failed';
      await order.save();
      console.log(`⚠️ Payment failed: ${reference} - Status: ${status}`);
      return res.json({ ok: false, verified: false, status });
    }
  } catch (e) {
    console.error('❌ verify error:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

// Webhook: Paystack charge.success
app.post('/webhooks/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secret = PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
  const computed = crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex');

  if (signature !== computed) {
    console.error('❌ Invalid webhook signature');
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
          console.error(`❌ Webhook amount mismatch for ${ref}`);
        } else if (order.status !== 'success') {
          order.status = 'success';
          order.verifiedAt = new Date();
          await order.save();
          console.log(`✓ Webhook confirmed payment: ${ref}`);
        }
      }
    }
  }

  res.sendStatus(200);
});

// Build CAPI Payload (Email Only with proper SHA256 hashing per Meta docs)
function buildCapiPayload(order) {
  const eventId = order.reference;
  const eventTime = Math.floor((order.verifiedAt || Date.now()) / 1000);
  const sourceUrl = `${SITE_URL}/paycomplete.html?ref=${encodeURIComponent(order.reference)}`;

  // Build user_data with proper hashing per Meta CAPI requirements
  const user_data = {
    em: order.email ? [sha256(normalizeEmail(order.email))] : undefined,
    external_id: order.email ? [sha256(normalizeEmail(order.email))] : undefined,
    client_ip_address: order.ip || undefined,
    client_user_agent: order.userAgent || undefined,
    fbc: order.fbc || undefined,
    fbp: order.fbp || undefined,
    country: order.country ? [sha256(order.country.toLowerCase())] : undefined
  };

  // Add phone if available (will be added after WhatsApp modal submission)
  if (order.phone) {
    user_data.ph = [sha256(formatPhoneForCAPI(order.phone))];
  }

  // Remove undefined fields
  Object.keys(user_data).forEach(key => {
    if (user_data[key] === undefined || user_data[key] === null) {
      delete user_data[key];
    }
  });

  // Validate we have minimum required fields
  if (!user_data.em && !user_data.ph) {
    throw new Error('CAPI requires at least email or phone');
  }

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

  const payload = { data: [eventData] };
  
  if (FB_TEST_EVENT_CODE) {
    payload.test_event_code = FB_TEST_EVENT_CODE;
  }

  return payload;
}

// API: Confirm Order & Send CAPI + Telegram
app.get('/api/order/confirm', async (req, res) => {
  const { ref, token } = req.query || {};
  if (!ref || !token) {
    return res.status(400).json({ ok: false, error: 'ref and token required' });
  }

  const order = await Order.findOne({ reference: ref });
  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found' });
  }
  
  if (order.successToken !== token) {
    return res.status(403).json({ ok: false, error: 'Invalid token' });
  }
  
  if (order.tokenExpiresAt && new Date() > order.tokenExpiresAt) {
    return res.status(403).json({ ok: false, error: 'Token expired' });
  }
  
  if (order.status !== 'success') {
    return res.status(409).json({ ok: false, error: 'Payment not confirmed yet' });
  }

  // Send CAPI event (one-time)
  let capiSent = order.capi.sent;
  let capiError = order.capi.error;
  
  if (!order.capi.sent) {
    try {
      const payload = buildCapiPayload(order);
      
      console.log(`📤 Sending CAPI event for ${ref}...`);
      
      const { data } = await axios.post(graphUrl, payload, {
        params: { access_token: FB_ACCESS_TOKEN },
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`✅ CAPI response for ${ref}:`, JSON.stringify(data, null, 2));

      if (data.events_received === 0 || (data.messages && data.messages.length > 0)) {
        throw new Error(`CAPI rejected event: ${JSON.stringify(data.messages || data)}`);
      }

      order.capi = {
        sent: true,
        lastTriedAt: new Date(),
        tries: (order.capi?.tries || 0) + 1,
        response: data,
        error: null
      };
      await order.save();
      capiSent = true;
      capiError = null;
      console.log(`✅ CAPI event sent successfully for ${ref}`);
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
      console.error(`❌ CAPI send failed for ${ref}:`, errorMsg);
      
      order.capi = {
        sent: false,
        lastTriedAt: new Date(),
        tries: (order.capi?.tries || 0) + 1,
        response: err.response?.data,
        error: errorMsg
      };
      await order.save();
      capiError = errorMsg;
    }
  }

  // Send order Telegram notification (one-time)
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !order.telegram?.orderSent) {
    const telegramResult = await sendOrderTelegram(order, { capiSent, capiError });
    order.telegram = {
      ...order.telegram,
      orderSent: telegramResult.sent,
      lastTriedAt: new Date(),
      response: telegramResult
    };
    await order.save();
    if (telegramResult.sent) {
      console.log(`✅ Order Telegram notification sent for ${ref}`);
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
      amount: order.amount, 
      currency: order.currency 
    },
    capiSent: order.capi.sent === true,
    capiError: order.capi.error,
    telegramSent: order.telegram?.orderSent === true
  });
});

// API: Submit WhatsApp Phone Number
app.post('/api/submit-phone', async (req, res) => {
  try {
    const { reference, phone } = req.body;
    
    if (!reference || !phone) {
      return res.status(400).json({ ok: false, error: 'Reference and phone required' });
    }
    
    if (phone.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }
    
    const order = await Order.findOne({ reference });
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    
    if (order.status !== 'success') {
      return res.status(400).json({ ok: false, error: 'Order not completed' });
    }
    
    // Update phone number
    order.phone = phone.trim();
    await order.save();
    
    console.log(`📱 Phone number collected for ${reference}: ${phone}`);
    
    // Send phone Telegram notification
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !order.telegram?.phoneSent) {
      const phoneResult = await sendPhoneTelegram(order);
      order.telegram = {
        ...order.telegram,
        phoneSent: phoneResult.sent,
        lastTriedAt: new Date()
      };
      await order.save();
      
      if (phoneResult.sent) {
        console.log(`✅ Phone Telegram notification sent for ${reference}`);
      }
    }
    
    res.json({ 
      ok: true, 
      message: 'Phone number received',
      telegramSent: order.telegram?.phoneSent === true
    });
    
  } catch (e) {
    console.error('❌ submit-phone error:', e.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// CAPI Retry Worker - runs every minute
setInterval(async () => {
  try {
    const unsent = await Order.find({
      status: 'success',
      'capi.sent': { $ne: true },
      'capi.tries': { $lt: 5 }
    }).limit(10);

    if (unsent.length > 0) {
      console.log(`🔄 CAPI Retry worker: Found ${unsent.length} unsent events`);
    }

    for (const order of unsent) {
      try {
        const payload = buildCapiPayload(order);
        
        console.log(`🔄 Retrying CAPI for ${order.reference} (attempt ${(order.capi?.tries || 0) + 1})...`);
        
        const { data } = await axios.post(graphUrl, payload, {
          params: { access_token: FB_ACCESS_TOKEN },
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        });

        if (data.events_received === 0 || (data.messages && data.messages.length > 0)) {
          throw new Error(`CAPI rejected event: ${JSON.stringify(data.messages || data)}`);
        }
        
        order.capi = { 
          sent: true, 
          lastTriedAt: new Date(), 
          tries: (order.capi?.tries || 0) + 1, 
          response: data,
          error: null
        };
        await order.save();
        console.log(`✅ CAPI retry success for ${order.reference}`);
      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
        console.error(`❌ CAPI retry failed for ${order.reference}: ${errorMsg}`);
        
        order.capi = {
          sent: false,
          lastTriedAt: new Date(),
          tries: (order.capi?.tries || 0) + 1,
          response: err.response?.data,
          error: errorMsg
        };
        await order.save();
      }
    }
  } catch (e) {
    console.error('❌ CAPI worker error:', e.message);
  }
}, 60 * 1000);

// Start Server
app.listen(PORT, () => {
  console.log(`\n✅ Server running on ${SITE_URL || `http://localhost:${PORT}`}`);
  console.log(`✅ Paystack: ${PAYSTACK_PUBLIC_KEY ? 'Configured' : '❌ Missing keys'}`);
  console.log(`✅ Meta CAPI: ${FB_PIXEL_ID && FB_ACCESS_TOKEN ? 'Configured' : '❌ Missing credentials'}`);
  console.log(`📊 Test Events: ${FB_TEST_EVENT_CODE ? `Enabled (${FB_TEST_EVENT_CODE})` : 'Disabled (production mode)'}`);
  console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'Enabled' : 'Disabled (optional)'}`);
  console.log(`\n🔍 CAPI Retry Worker: Active (checks every 60 seconds)`);
  console.log(`📱 WhatsApp Collection: Enabled on paycomplete page`);
});
