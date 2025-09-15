// Optimized Adult Companion Telegram Bot for Vercel
// File: api/webhook.js

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  DIFY_TIMEOUT: 58000, // 58 seconds (safe margin for Dify's 55s response)
  TELEGRAM_TIMEOUT: 5000, // 5 seconds
  FALLBACK_MESSAGE: "😔 Üzgünüm, şu anda bir sorun yaşıyorum. Lütfen tekrar dene.",
};

// Simple in-memory session store (resets on each deployment)
const sessions = new Map();

// Get or create session
function getSession(userId) {
  const key = userId?.toString();
  if (!key) return { conversationId: '' };
  
  if (!sessions.has(key)) {
    sessions.set(key, { conversationId: '', lastAccess: Date.now() });
  }
  
  const session = sessions.get(key);
  session.lastAccess = Date.now();
  
  // Clean old sessions (simple cleanup)
  if (sessions.size > 1000) {
    const oldestKey = Array.from(sessions.keys())[0];
    sessions.delete(oldestKey);
  }
  
  return session;
}

// Update session
function updateSession(userId, conversationId) {
  const key = userId?.toString();
  if (!key || !conversationId) return;
  
  const session = getSession(userId);
  session.conversationId = conversationId;
  sessions.set(key, session);
}

// Fast fetch with timeout
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

// Get Dify AI response (OPTIMIZED)
async function getDifyResponse(userMessage, userName = 'User', conversationId = '') {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    console.error('Missing Dify configuration');
    throw new Error('Dify API not configured');
  }

  const requestBody = {
    inputs: {},
    query: userMessage.substring(0, 4000), // Limit message length
    response_mode: 'blocking',
    user: userName,
    conversation_id: conversationId || '',
    files: [],
    auto_generate_name: false // Faster without auto-naming
  };

  try {
    console.log('Calling Dify...');
    const response = await fetchWithTimeout(
      `${DIFY_API_URL}/chat-messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DIFY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
      CONSTANTS.DIFY_TIMEOUT
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Dify error:', response.status, errorText.substring(0, 200));
      throw new Error(`Dify error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Dify responded successfully');
    return data;
    
  } catch (error) {
    console.error('Dify call failed:', error.message);
    throw error;
  }
}

// Send Telegram message (OPTIMIZED)
async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!BOT_TOKEN) {
    throw new Error('Bot token missing');
  }

  // Clean text
  let cleanText = text || "✨ İşte senin için hazırladığım yanıt!";
  cleanText = cleanText.substring(0, CONSTANTS.MAX_MESSAGE_LENGTH);
  
  const params = {
    chat_id: chatId,
    text: cleanText,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  
  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
      CONSTANTS.TELEGRAM_TIMEOUT
    );

    const data = await response.json();
    
    if (!data.ok) {
      console.error('Telegram error:', data.description);
      
      // If message to reply not found, send without reply
      if (data.description?.includes('message to be replied not found') || 
          data.description?.includes('MESSAGE_ID_INVALID')) {
        console.log('Retrying without reply_to_message_id...');
        delete params.reply_to_message_id;
        
        const retryResponse = await fetchWithTimeout(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          },
          CONSTANTS.TELEGRAM_TIMEOUT
        );
        const retryData = await retryResponse.json();
        if (retryData.ok) {
          console.log('Message sent successfully without reply');
          return retryData.result;
        }
      }
      
      // Retry without parse_mode if parsing failed
      if (data.description?.includes('parse')) {
        delete params.parse_mode;
        const retryResponse = await fetchWithTimeout(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          },
          CONSTANTS.TELEGRAM_TIMEOUT
        );
        return await retryResponse.json();
      }
      
      throw new Error(data.description || 'Telegram API error');
    }

    return data.result;
    
  } catch (error) {
    console.error('Telegram send failed:', error.message);
    throw error;
  }
}

// Send typing action (fire and forget)
async function sendTypingAction(chatId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return;
  
  try {
    // Don't await - fire and forget for speed
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        action: 'typing' 
      }),
    }).catch(() => {}); // Ignore errors
  } catch (error) {
    // Ignore typing errors
  }
}

// Main message handler (OPTIMIZED FOR SPEED)
async function handleMessage(message) {
  const startTime = Date.now();
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const userMessage = message.text || message.caption || '';
  const userId = message.from?.id;
  const userName = message.from?.first_name || 'User';

  if (!chatId || !userMessage) {
    console.log('Invalid message data');
    return;
  }

  // Only respond to private chats
  if (message.chat.type !== 'private') {
    console.log('Ignoring non-private chat');
    return;
  }

  console.log(`Processing message from ${userName} (${userId}): "${userMessage.substring(0, 50)}..."`);

  try {
    // Send typing indicator (don't await)
    sendTypingAction(chatId);
    
    // Get session
    const session = getSession(userId);
    
    // Call Dify AI
    const difyResponse = await getDifyResponse(
      userMessage,
      userName,
      session.conversationId
    );
    
    // Update session if we got a conversation ID
    if (difyResponse?.conversation_id) {
      updateSession(userId, difyResponse.conversation_id);
    }
    
    // Extract and send response
    const responseText = difyResponse?.answer || CONSTANTS.FALLBACK_MESSAGE;
    await sendTelegramMessage(chatId, responseText, messageId);
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Processed in ${elapsed}ms`);
    
  } catch (error) {
    console.error('Processing error:', error.message);
    
    // Try to send fallback message
    try {
      await sendTelegramMessage(chatId, CONSTANTS.FALLBACK_MESSAGE, messageId);
    } catch (fallbackError) {
      console.error('Fallback failed:', fallbackError.message);
    }
  }
}

// Main webhook handler (SUPER OPTIMIZED)
export default async function handler(req, res) {
  // Immediate response for non-POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check environment variables
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.DIFY_API_URL || !process.env.DIFY_API_TOKEN) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Configuration error' });
  }

  const startTime = Date.now();
  
  try {
    const update = req.body;
    
    if (!update) {
      return res.status(400).json({ error: 'No body' });
    }
    
    // Log update type
    const updateType = Object.keys(update).find(key => key !== 'update_id');
    console.log(`Webhook called: ${updateType}`);
    
    // Handle different update types
    if (update.message && update.message.text) {
      // Process regular text messages
      await handleMessage(update.message);
    } else if (update.business_message && update.business_message.text) {
      // Process business messages
      await handleMessage(update.business_message);
    } else {
      // Ignore other update types
      console.log('Ignoring update type:', updateType);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Webhook completed in ${elapsed}ms`);
    
    // Always return success quickly
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error.message);
    
    // Still return 200 to prevent Telegram retries
    return res.status(200).json({ ok: true, error: error.message });
  }
}

// Add a health check endpoint
export async function GET(req, res) {
  return res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    sessions: sessions.size
  });
}
