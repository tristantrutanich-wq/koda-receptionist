const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const LEADS_FILE = 'leads.json';
const CALLS_FILE = 'calls.json';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8762692819:AAEABk68IAChFEcHOyq0whFJp_BmEgVJfME';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5114986927';

// Gmail setup
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Google Sheets setup
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Load existing data
let leads = [];
let allCalls = [];
if (fs.existsSync(LEADS_FILE)) {
  leads = JSON.parse(fs.readFileSync(LEADS_FILE));
}
if (fs.existsSync(CALLS_FILE)) {
  allCalls = JSON.parse(fs.readFileSync(CALLS_FILE));
}

// Track which calls we've already notified about
const notifiedCalls = new Set();

// Calculate call stats
function getCallStats() {
  const total = allCalls.length;
  const qualified = allCalls.filter(c => c.type === 'lead' || c.type === 'booked' || c.type === 'hot').length;
  const hangups = allCalls.filter(c => c.type === 'hangup').length;
  const short = allCalls.filter(c => c.type === 'short').length;
  const completed = allCalls.filter(c => c.type === 'completed').length;
  
  return { total, qualified, hangups, short, completed };
}

// Determine call type
categorizeCall(duration, transcript, summary) {
  if (!duration || duration < 5) return 'hangup';
  if (duration < 15) return 'short';
  
  const summaryLower = (summary || '').toLowerCase();
  const transcriptLower = (transcript || '').toLowerCase();
  
  if (summaryLower.includes('hot') || summaryLower.includes('ready') || summaryLower.includes('buy') ||
      transcriptLower.includes('i\'m ready') || transcriptLower.includes('sign me up')) {
    return 'hot';
  }
  if (summaryLower.includes('booked') || summaryLower.includes('meeting') || summaryLower.includes('scheduled')) {
    return 'booked';
  }
  if (transcriptLower.includes('interested') || transcriptLower.includes('pricing') || transcriptLower.includes('tell me more')) {
    return 'lead';
  }
  
  return 'completed';
}

// Send Telegram notification
async function sendTelegramNotification(lead) {
  try {
    let message = '';
    
    if (lead.type === 'hot') {
      message = `🔥 *HOT LEAD - READY TO BUY!*\n\n`;
    } else if (lead.type === 'booked') {
      message = `📅 *NEW MEETING BOOKED!*\n\n`;
    } else if (lead.type === 'lead') {
      message = `📞 *NEW LEAD*\n\n`;
    } else {
      return; // Don't notify for hangups/short calls
    }
    
    // Extract key info from transcript
    const transcript = lead.transcript || '';
    const nameMatch = transcript.match(/my name is ([^.\n]+)/i);
    const businessMatch = transcript.match(/(?:business name|company.{0,10}name) is ([^.\n]+)/i) || transcript.match(/company's name is ([^.\n]+)/i);
    const phoneMatch = transcript.match(/(\d{3}[\s-]?\d{3}[\s-]?\d{4})/);
    const timeMatch = transcript.match(/(\d{1,2}\s*(?::\d{2})?\s*(?:AM|PM|am|pm)?)/i);
    const dayMatch = transcript.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow|today)/i);
    
    // Add extracted info to message
    if (nameMatch) message += `*Name:* ${nameMatch[1].trim()}\n`;
    if (businessMatch) message += `*Business:* ${businessMatch[1].trim()}\n`;
    if (dayMatch || timeMatch) {
      message += `*When:* ${dayMatch ? dayMatch[1] : ''} ${timeMatch ? timeMatch[1] : ''}\n`;
    }
    if (phoneMatch) message += `*Phone:* ${phoneMatch[1]}\n`;
    
    message += `\n*Duration:* ${lead.duration || '?'} seconds\n`;
    message += `*Called at:* ${new Date(lead.timestamp).toLocaleTimeString()}\n\n`;
    
    // Show snippet of what they said
    const userLines = transcript.split('\n').filter(line => line.startsWith('User:'));
    if (userLines.length > 0) {
      message += `*They said:* "${userLines[0].replace('User:', '').trim().substring(0, 80)}..."\n\n`;
    }
    
    message += `✅ *Action:* Call them back to confirm!`;
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    
    console.log('📱 Telegram notification sent!');
  } catch (err) {
    console.log('❌ Failed to send Telegram:', err.message);
  }
}

// Send Gmail notification
async function sendGmailNotification(lead) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.log('⚠️ Gmail not configured, skipping email');
    return;
  }
  
  if (lead.type !== 'hot' && lead.type !== 'booked' && lead.type !== 'lead') {
    return; // Only email for qualified leads
  }
  
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD
      }
    });
    
    let subject = 'New Lead from Koda Receptionist';
    if (lead.type === 'hot') subject = '🔥 HOT LEAD - Ready to Buy!';
    if (lead.type === 'booked') subject = '📅 Meeting Booked!';
    
    const mailOptions = {
      from: `Koda Receptionist <${GMAIL_USER}>`,
      to: GMAIL_USER,
      subject: subject,
      html: `
        <h2>${subject}</h2>
        <p><strong>Status:</strong> ${lead.type}</p>
        <p><strong>Customer:</strong> ${lead.customer}</p>
        <p><strong>Duration:</strong> ${lead.duration} seconds</p>
        <p><strong>Time:</strong> ${new Date(lead.timestamp).toLocaleString()}</p>
        <hr>
        <p><strong>Transcript:</strong></p>
        <pre>${lead.transcript}</pre>
        <hr>
        <p><strong>Summary:</strong> ${lead.summary}</p>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log('📧 Gmail notification sent!');
  } catch (err) {
    console.log('❌ Failed to send Gmail:', err.message);
  }
}

// Add to Google Sheets
async function addToGoogleSheets(lead) {
  if (!GOOGLE_SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.log('⚠️ Google Sheets not configured, skipping');
    return;
  }
  
  if (lead.type !== 'hot' && lead.type !== 'booked' && lead.type !== 'lead') {
    return; // Only track qualified leads
  }
  
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    
    const values = [
      [
        new Date(lead.timestamp).toLocaleString(),
        lead.type,
        lead.customer,
        lead.duration,
        lead.summary,
        lead.transcript.substring(0, 500)
      ]
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Leads!A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values }
    });
    
    console.log('📊 Added to Google Sheets!');
  } catch (err) {
    console.log('❌ Failed to add to Sheets:', err.message);
  }
}

// Webhook endpoint - receives calls from Vapi
app.post('/webhook', async (req, res) => {
  const data = req.body;
  
  // Skip if no call ID (ping/health check)
  if (!data.id) {
    console.log('🔕 No call ID, skipping (probably a ping)');
    res.json({ received: true });
    return;
  }
  
  // Skip if we already processed this call
  if (notifiedCalls.has(data.id)) {
    console.log('🔕 Already processed call', data.id);
    res.json({ received: true });
    return;
  }
  
  // Only process calls that have ended OR have transcript data
  if (!data.endedAt && !data.message?.transcript) {
    console.log('⏳ Call still in progress, waiting...');
    res.json({ received: true });
    return;
  }
  
  // Mark as processed so we don't notify again
  notifiedCalls.add(data.id);
  
  console.log('\n📞 PROCESSING COMPLETED CALL:', data.id);
  console.log(JSON.stringify(data, null, 2));
  
  // Calculate duration
  const duration = data.endedAt ? 
    Math.round((new Date(data.endedAt) - new Date(data.startedAt)) / 1000) : 0;
  
  const transcript = data.message?.transcript || '';
  const summary = data.analysis?.summary || 'No analysis';
  
  // Categorize the call
  const callType = categorizeCall(duration, transcript, summary);
  
  // Build call record
  const call = {
    id: data.id,
    timestamp: new Date().toISOString(),
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    duration: duration,
    customer: data.customer?.number || 'Unknown number',
    type: callType,
    transcript: transcript,
    summary: summary
  };
  
  // Add to all calls log
  allCalls.unshift(call);
  fs.writeFileSync(CALLS_FILE, JSON.stringify(allCalls, null, 2));
  
  // If it's a qualified lead, also add to leads file
  if (callType === 'hot' || callType === 'booked' || callType === 'lead') {
    leads.unshift(call);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
    
    // Send notifications for qualified leads
    sendTelegramNotification(call);
    sendGmailNotification(call);
    addToGoogleSheets(call);
  }
  
  const stats = getCallStats();
  console.log('\n✅ Call logged:', callType);
  console.log(`📊 Stats: ${stats.total} total | ${stats.qualified} qualified | ${stats.hangups} hangups | ${stats.short} short | ${stats.completed} completed`);
  
  res.json({ received: true });
});

// API endpoint for dashboard to get ALL calls data
app.get('/calls-data', (req, res) => {
  const stats = getCallStats();
  res.json({ calls: allCalls, stats: stats });
});

// API endpoint for dashboard to get leads data (backwards compatible)
app.get('/leads-data', (req, res) => {
  res.json(leads);
});

// Serve the dashboard HTML
app.get('/', (req, res) => {
  const dashboardPath = path.join(__dirname, 'dashboard.html');
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.json({ 
      status: 'Webhook running', 
      stats: getCallStats(),
      message: 'Dashboard file not found' 
    });
  }
});

// Also serve dashboard at /dashboard
app.get('/dashboard', (req, res) => {
  const dashboardPath = path.join(__dirname, 'dashboard.html');
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.json({ 
      status: 'Webhook running', 
      stats: getCallStats(),
      message: 'Dashboard file not found' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Webhook server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📞 Call tracking: ALL calls logged with categorization`);
});
