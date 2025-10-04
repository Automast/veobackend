/**
 * public/js/app.js - FINAL VERSION (Updated)
 * ✅ Prevents auto-focus when modal opens
 * ✅ All fields (first, last, email) are required with clear validation
 * ✅ Loading animation on payment button
 * ✅ Better error handling
 * ✅ Mobile-optimized
 */

(function(){
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function getCookie(name) {
    const nameEQ = name + '=';
    const parts = document.cookie.split(';').map(c => c.trim());
    const found = parts.find(c => c.indexOf(nameEQ) === 0);
    return found ? decodeURIComponent(found.slice(nameEQ.length)) : null;
  }

  function setCookie(name, value, days = 365) {
    const exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; samesite=lax`;
  }

  async function bootstrapIdentity() {
    const qp = new URLSearchParams(location.search);
    const fbclid = qp.get('fbclid') || null;

    let _fbc = getCookie('_fbc');
    let _fbp = getCookie('_fbp');

    const now = Math.floor(Date.now() / 1000);
    if (fbclid && !_fbc) {
      _fbc = `fb.1.${now}.${fbclid}`;
      setCookie('_fbc', _fbc, 90);
    }
    if (!_fbp) {
      _fbp = `fb.1.${now}.${Math.floor(Math.random() * 1e10)}`;
      setCookie('_fbp', _fbp, 90);
    }
    if (fbclid) setCookie('fbclid', fbclid, 7);

    try {
      await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fbclid, fbc: _fbc, fbp: _fbp })
      });
    } catch (e) {
      console.error('Identity sync failed:', e);
    }
  }

  async function captureVisitor() {
    try {
      await fetch('/api/visitor', { method: 'POST' });
    } catch (e) {
      console.error('Visitor capture failed:', e);
    }
  }

  function openLeadModal() {
    const modal = $('#leadModal');
    modal.style.display = 'flex';

    // 🚫 Do NOT auto-focus any field when modal opens.
    // If any script or browser behavior focuses an input, blur it immediately.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        document.activeElement.blur();
      }
    });
  }

  function closeLeadModal() {
    $('#leadModal').style.display = 'none';
    // Reset button state when modal closes
    const btn = $('#proceedToPay');
    btn.disabled = false;
    btn.classList.remove('loading');
  }

  function showError(message) {
    showNotification(message, 'error');
  }

  function showInfo(message) {
    showNotification(message, 'info');
  }

  function showNotification(message, type = 'error') {
    let notifDiv = $('#notification');
    if (!notifDiv) {
      notifDiv = document.createElement('div');
      notifDiv.id = 'notification';
      document.body.appendChild(notifDiv);
    }

    const bgColor = type === 'error' ? '#ff4757' : '#667eea';
    
    notifDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${bgColor};
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 99999;
      max-width: 90%;
      font-size: 14px;
      animation: slideInRight 0.3s ease;
      display: block;
    `;

    notifDiv.textContent = message;

    if (type === 'error') {
      setTimeout(() => {
        notifDiv.style.display = 'none';
      }, 5000);
    }
  }

  // 🔒 Validate ALL fields (first name, last name, email)
  function validateLeadFields({ firstName, lastName, email }) {
    if (!firstName) {
      showError('Please enter your first name');
      $('#firstName')?.focus();
      return false;
    }
    if (!lastName) {
      showError('Please enter your surname');
      $('#lastName')?.focus();
      return false;
    }
    if (!email) {
      showError('Please enter your email');
      $('#email')?.focus();
      return false;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      showError('Please enter a valid email address');
      $('#email')?.focus();
      return false;
    }
    return true;
  }

  async function startPayment() {
    const email = $('#email').value.trim();
    const firstName = $('#firstName').value.trim();
    const lastName = $('#lastName').value.trim();

    // ✅ Enforce required fields
    if (!validateLeadFields({ firstName, lastName, email })) {
      return;
    }

    setCookie('lead_email', email, 365);
    setCookie('lead_fn', firstName, 365);
    setCookie('lead_ln', lastName, 365);

    // Show loading state
    const proceedBtn = $('#proceedToPay');
    proceedBtn.disabled = true;
    proceedBtn.classList.add('loading');

    try {
      const initRes = await fetch('/api/tx/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, firstName, lastName })
      });

      const initJson = await initRes.json();

      if (!initJson.ok) {
        showError(initJson.error || 'Could not initialize payment');
        proceedBtn.disabled = false;
        proceedBtn.classList.remove('loading');
        return;
      }

      const { reference, publicKey } = initJson;

      // Close lead modal
      closeLeadModal();

      // Open Paystack modal
      const paystack = PaystackPop.setup({
        key: publicKey,
        email,
        amount: 390000,
        currency: 'NGN',
        ref: reference,
        onClose: function() {
          // User closed Paystack modal - nothing to do
        },
        callback: async function(response) {
          // Show loading indicator
          showInfo('Verifying payment...');
          
          try {
            const vr = await fetch(`/api/tx/verify?reference=${encodeURIComponent(reference)}`);
            const vj = await vr.json();

            if (vj.ok && vj.verified) {
              window.location.href = vj.redirect;
            } else {
              showError('Payment verification failed. If money was deducted, it will be verified automatically.');
            }
          } catch (e) {
            showError('Could not verify payment. Please check your email for confirmation.');
            console.error('Verification error:', e);
          }
        }
      });

      paystack.openIframe();
    } catch (e) {
      showError('An error occurred. Please try again.');
      proceedBtn.disabled = false;
      proceedBtn.classList.remove('loading');
      console.error('Payment init error:', e);
    }
  }

  function wireUi() {
    // CTA -> open modal
    $$('[data-cta]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openLeadModal();
      });
    });

    // Cancel/close modal
    $('#cancelLead')?.addEventListener('click', closeLeadModal);

    // Proceed button
    $('#proceedToPay')?.addEventListener('click', async () => {
      await startPayment();
    });

    // Press Enter in any field -> attempt submit with validation
    ['#firstName', '#lastName', '#email'].forEach(sel => {
      $(sel)?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          startPayment();
        }
      });
    });

    // Click backdrop to close
    $('#leadModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'leadModal') {
        closeLeadModal();
      }
    });
  }

  (async function boot() {
    await bootstrapIdentity();
    await captureVisitor();
    wireUi();

    // Prefill fields from cookie if available
    const ce = getCookie('lead_email');
    const cf = getCookie('lead_fn');
    const cl = getCookie('lead_ln');
    
    if (ce && $('#email')) $('#email').value = ce;
    if (cf && $('#firstName')) $('#firstName').value = cf;
    if (cl && $('#lastName')) $('#lastName').value = cl;

    console.log('✓ App initialized');
  })();

  // Add CSS animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideInRight {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
})();
