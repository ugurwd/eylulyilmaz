// Adult Companion Telegram Bot for Vercel - COMPLETE FIXED VERSION
// File: api/webhook.js

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  DIFY_TIMEOUT: 58000, // 58 seconds for Dify
  TELEGRAM_TIMEOUT: 5000, // 5 seconds
  FALLBACK_MESSAGE: "😔 Üzgünüm, şu anda bir sorun yaşıyorum. Lütfen tekrar dene.",
};

// Simple in-memory session store
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

// Get Dify AI response
async function getDifyResponse(userMessage, userName = 'User', conversationId = '') {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  console.log('[DIFY] Starting request...');
  console.log('[DIFY] API URL:', DIFY_API_URL);
  console.log('[DIFY] Token exists:', !!DIFY_API_TOKEN);
  console.log('[DIFY] Message:', userMessage.substring(0, 100));
  console.log('[DIFY] ConversationId:', conversationId || 'new');

  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    console.error('[DIFY] Missing configuration');
    throw new Error('Dify API not configured');
  }

  const requestBody = {
    inputs: {},
    query: userMessage.substring(0, 4000),
    response_mode: 'blocking',
    user: userName,
    conversation_id: conversationId || '',
    files: [],
    auto_generate_name: false
  };

  try {
    const startTime = Date.now();
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

    const elapsed = Date.now() - startTime;
    console.log(`[DIFY] Response received in ${elapsed}ms`);
    console.log('[DIFY] Status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[DIFY] Error response:', errorText.substring(0, 500));
      throw new Error(`Dify error: ${response.status}`);
    }

    const data = await response.json();
    console.log('[DIFY] Success! Answer length:', data.answer?.length || 0);
    return data;
    
  } catch (error) {
    console.error('[DIFY] Failed:', error.message);
    throw error;
  }
}

// Send Telegram message WITH BUSINESS SUPPORT (SIMPLIFIED)
async function sendTelegramMessage(chatId, text, replyToMessageId = null, businessConnectionId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  console.log('[TELEGRAM] Sending message...');
  console.log('[TELEGRAM] Chat ID:', chatId);
  console.log('[TELEGRAM] Reply to:', replyToMessageId);
  console.log('[TELEGRAM] Business Connection ID:', businessConnectionId || 'none');
  console.log('[TELEGRAM] Text length:', text?.length || 0);
  
  if (!BOT_TOKEN) {
    console.error('[TELEGRAM] No bot token!');
    throw new Error('Bot token missing');
  }

  // Clean text
  let cleanText = text || "✨ İşte senin için hazırladığım yanıt!";
  cleanText = cleanText.substring(0, CONSTANTS.MAX_MESSAGE_LENGTH);
  
  const params = {
    chat_id: chatId,
    text: cleanText,
    disable_web_page_preview: true
  };
  
  // CRITICAL: Add business_connection_id for business messages
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
    console.log('[TELEGRAM] Added business_connection_id to params');
    // Don't add reply_to for business messages (timing issues)
  } else if (replyToMessageId) {
    // Only add reply for regular messages
    params.reply_to_message_id = replyToMessageId;
  }

  try {
    console.log('[TELEGRAM] Sending with params:', JSON.stringify(params).substring(0, 200));
    
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
      console.error('[TELEGRAM] Error:', data.description);
      throw new Error(data.description || 'Telegram API error');
    }

    console.log('[TELEGRAM] Message sent successfully!');
    console.log('[TELEGRAM] Message ID:', data.result?.message_id);
    return data.result;
    
  } catch (error) {
    console.error('[TELEGRAM] Send failed:', error.message);
    throw error;
  }
}

// Send typing action
async function sendTypingAction(chatId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return;
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        action: 'typing' 
      }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('[TYPING] Error:', error.description);
    }
  } catch (error) {
    console.error('[TYPING] Failed:', error.message);
  }
}

// Send typing action for business messages
async function sendTypingActionBusiness(chatId, businessConnectionId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return;
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        action: 'typing',
        business_connection_id: businessConnectionId
      }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('[TYPING] Business error:', error.description);
    }
  } catch (error) {
    console.error('[TYPING] Business failed:', error.message);
  }
}

// Main message handler WITH BUSINESS SUPPORT
async function handleMessage(message, businessConnectionId = null) {
  const startTime = Date.now();
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const userMessage = message.text || message.caption || '';
  const userId = message.from?.id;
  const userName = message.from?.first_name || 'User';
  const isBusinessMessage = !!businessConnectionId;

  console.log('=====================================');
  console.log('[MESSAGE] New message received');
  console.log('[MESSAGE] Type:', isBusinessMessage ? 'BUSINESS' : 'REGULAR');
  console.log('[MESSAGE] From:', userName, `(${userId})`);
  console.log('[MESSAGE] Chat:', chatId);
  console.log('[MESSAGE] Business Connection ID:', businessConnectionId || 'NONE');
  console.log('[MESSAGE] Text:', userMessage.substring(0, 100));
  console.log('=====================================');

  if (!chatId || !userMessage) {
    console.log('[MESSAGE] Invalid - missing chatId or text');
    return;
  }

  // For regular messages, only respond to private chats
  if (!isBusinessMessage && message.chat.type !== 'private') {
    console.log('[MESSAGE] Ignoring non-private chat');
    return;
  }

  let typingInterval = null;

  try {
    // Send initial typing indicator
    if (businessConnectionId) {
      await sendTypingActionBusiness(chatId, businessConnectionId);
    } else {
      await sendTypingAction(chatId);
    }
    
    // Keep sending typing indicator every 5 seconds
    typingInterval = setInterval(async () => {
      try {
        if (businessConnectionId) {
          await sendTypingActionBusiness(chatId, businessConnectionId);
        } else {
          await sendTypingAction(chatId);
        }
        console.log('[TYPING] Refreshed typing indicator');
      } catch (err) {
        console.error('[TYPING] Failed to refresh:', err.message);
      }
    }, 5000); // Every 5 seconds
    
    // Get session
    const session = getSession(userId);
    console.log('[SESSION] Current conversation:', session.conversationId || 'new');
    
    // Call Dify AI
    const difyResponse = await getDifyResponse(
      userMessage,
      userName,
      session.conversationId
    );
    
    // Clear typing indicator before sending message
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    
    // Update session if we got a conversation ID
    if (difyResponse?.conversation_id) {
      updateSession(userId, difyResponse.conversation_id);
      console.log('[SESSION] Updated with ID:', difyResponse.conversation_id);
    }
    
    // Extract and send response
    const responseText = difyResponse?.answer || CONSTANTS.FALLBACK_MESSAGE;
    console.log('[RESPONSE] Sending to Telegram...');
    console.log('[RESPONSE] With business ID:', businessConnectionId || 'none');
    
    // CRITICAL: Pass businessConnectionId to sendTelegramMessage
    await sendTelegramMessage(chatId, responseText, messageId, businessConnectionId);
    
    const elapsed = Date.now() - startTime;
    console.log(`[SUCCESS] ✅ Completed in ${elapsed}ms`);
    
  } catch (error) {
    console.error('[ERROR] Processing failed:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    
    // Clear typing indicator if still running
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    
    // Try to send fallback message WITH businessConnectionId
    try {
      await sendTelegramMessage(chatId, CONSTANTS.FALLBACK_MESSAGE, messageId, businessConnectionId);
      console.log('[FALLBACK] Sent fallback message');
    } catch (fallbackError) {
      console.error('[FALLBACK] Failed:', fallbackError.message);
    }
  }
}

// Main webhook handler
export default async function handler(req, res) {
  const startTime = Date.now();
  
  console.log('=====================================');
  console.log(`[WEBHOOK] Called at ${new Date().toISOString()}`);
  console.log('[WEBHOOK] Method:', req.method);
  console.log('[WEBHOOK] Body:', JSON.stringify(req.body).substring(0, 500));
  console.log('=====================================');
  
  // Only accept POST
  if (req.method !== 'POST') {
    console.log('[WEBHOOK] Not POST, returning 405');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check environment variables
  const envVars = {
    TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    DIFY_URL: !!process.env.DIFY_API_URL,
    DIFY_TOKEN: !!process.env.DIFY_API_TOKEN
  };
  
  console.log('[ENV] Variables present:', envVars);
  
  if (!envVars.TOKEN || !envVars.DIFY_URL || !envVars.DIFY_TOKEN) {
    console.error('[ENV] Missing required environment variables');
    return res.status(500).json({ error: 'Configuration error', envVars });
  }
  
  try {
    const update = req.body;
    
    if (!update) {
      console.log('[WEBHOOK] No body, returning 400');
      return res.status(400).json({ error: 'No body' });
    }
    
    // Log update type
    const updateType = Object.keys(update).find(key => key !== 'update_id');
    console.log('[WEBHOOK] Update type:', updateType);
    
    // Handle different update types
    if (update.message) {
      console.log('[WEBHOOK] Processing regular message');
      if (update.message.text || update.message.caption) {
        await handleMessage(update.message, null);
      } else {
        console.log('[WEBHOOK] Message has no text/caption, ignoring');
      }
    } else if (update.business_message) {
      console.log('[WEBHOOK] Processing BUSINESS message');
      if (update.business_message.text || update.business_message.caption) {
        // CRITICAL: Extract and pass business_connection_id
        const businessConnectionId = update.business_message.business_connection_id;
        console.log('[WEBHOOK] Business Connection ID:', businessConnectionId);
        await handleMessage(update.business_message, businessConnectionId);
      } else {
        console.log('[WEBHOOK] Business message has no text/caption, ignoring');
      }
    } else {
      console.log('[WEBHOOK] Ignoring update type:', updateType);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[WEBHOOK] Completed in ${elapsed}ms`);
    
    // Always return success
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('[WEBHOOK] Critical error:', error.message);
    console.error('[WEBHOOK] Stack:', error.stack);
    
    // Still return 200 to prevent Telegram retries
    return res.status(200).json({ ok: true, error: error.message });
  }
}

// Updated: Force deployment
