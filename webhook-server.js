const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const LEADS_FILE = 'leads.json';
const TELEGRAM_BOT_TOKEN = '8762692819:AAEABk68IAChFEcHOyq0whFJp_BmEgVJfME';
const TELEGRAM_CHAT_ID = '5114986927';

// Load existing leads
let leads = [];
if (fs.existsSync(LEADS_FILE)) {
  leads = JSON.parse(fs.readFileSync(LEADS_FILE));
}

// Track which calls we've already notified about
const notifiedCalls = new Set();

// Send Telegram notification
async function sendTelegramNotification(lead) {
  try {
    let message = '';
    
    if (lead.status === 'hot') {
      message = `🔥 *HOT LEAD - READY TO BUY!*\n\n`;
    } else if (lead.status === 'booked') {
      message = `📅 *NEW MEETING BOOKED!*\n\n`;
    } else {
      message = `📞 *NEW LEAD*\n\n`;
    }
    
    // Extract key info from transcript
    const transcript = lead.transcript || '';
    const nameMatch = transcript.match(/my name is ([^\.\n]+)/i);
    const businessMatch = transcript.match(/(?:business name|company.{0,10}name) is ([^\.\n]+)/i) || transcript.match(/company's name is ([^\.\n]+)/i);
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
  
  // Extract key info
  const lead = {
    id: data.id,
    timestamp: new Date().toISOString(),
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    duration: data.endedAt ? Math.round((new Date(data.endedAt) - new Date(data.startedAt)) / 1000) : null,
    transcript: data.message?.transcript || 'No transcript captured',
    summary: data.analysis?.summary || 'No analysis',
    customer: data.customer?.number || 'Unknown number',
    status: 'new'
  };
  
  // Check if it's a hot lead
  const summary = (data.analysis?.summary || '').toLowerCase();
  const transcript = (data.message?.transcript || '').toLowerCase();
  if (summary.includes('hot') || summary.includes('ready') || summary.includes('buy') ||
      transcript.includes('i\'m ready') || transcript.includes('sign me up')) {
    lead.status = 'hot';
  } else if (summary.includes('booked') || summary.includes('meeting')) {
    lead.status = 'booked';
  }
  
  // Save to file
  leads.unshift(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  
  // Send Telegram notification
  sendTelegramNotification(lead);
  
  console.log('\n✅ Lead saved to leads.json');
  console.log(`📊 You now have ${leads.length} leads total`);
  
  res.json({ received: true });
});

// API endpoint for dashboard to get leads data
app.get('/leads-data', (req, res) => {
  res.json(leads);
});

// Serve the dashboard HTML
app.get('/', (req, res) => {
  const dashboardPath = '/Users/tristantrutanich/.openclaw/workspace/dashboard.html';
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.json({ status: 'Webhook running', leads: leads.length, message: 'Dashboard file not found' });
  }
});

// Also serve dashboard at /dashboard
app.get('/dashboard', (req, res) => {
  const dashboardPath = '/Users/tristantrutanich/.openclaw/workspace/dashboard.html';
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.json({ status: 'Webhook running', leads: leads.length, message: 'Dashboard file not found' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Webhook server + Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`\n📱 To access from phone: use your ngrok URL`);
  console.log(`\nNext steps:`);
  console.log('1. In another terminal: ngrok http 3000');
  console.log('2. Copy the https URL');
  console.log('3. Update Vapi webhook with: node update-webhook.js https://YOUR-URL.ngrok.io/webhook');
});
