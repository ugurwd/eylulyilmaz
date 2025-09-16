// Queue-Based Telegram Bot - Single File Solution
// File: api/webhook.js

// In-memory queue (resets on deployment, but simple to use)
const messageQueue = [];
const processingMap = new Map();
const sessions = new Map();

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  DIFY_TIMEOUT: 55000,
  TELEGRAM_TIMEOUT: 8000,
  FALLBACK_MESSAGE: "😔 Bir sorun oluştu. Lütfen tekrar dene.",
  MAX_QUEUE_SIZE: 100,
  PROCESS_DELAY: 100, // Delay between processing items
};

// Get or create session
function getSession(userId) {
  const key = userId?.toString();
  if (!key) return { conversationId: '' };
  
  if (!sessions.has(key)) {
    sessions.set(key, { conversationId: '', lastAccess: Date.now() });
  }
  
  const session = sessions.get(key);
  session.lastAccess = Date.now();
  
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

// Parse Dify response
function parseDifyResponse(difyResponse) {
  const answer = difyResponse?.answer || '';
  const urlRegex = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?)/gi;
  const imageUrls = [];
  let match;
  
  while ((match = urlRegex.exec(answer)) !== null) {
    imageUrls.push(match[1]);
  }
  
  let cleanText = answer;
  imageUrls.forEach(url => {
    cleanText = cleanText.replace(url, '');
  });
  
  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  
  if (!cleanText && imageUrls.length > 0) {
    cleanText = "✨ İşte senin için hazırladıklarım:";
  }
  
  return { text: cleanText || CONSTANTS.FALLBACK_MESSAGE, images: imageUrls };
}

// Call Dify API
async function callDifyAPI(text, userName, conversationId) {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;
  
  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    throw new Error('Dify API not configured');
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.DIFY_TIMEOUT);
  
  try {
    console.log('[DIFY] Calling API...');
    const response = await fetch(`${DIFY_API_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {},
        query: text,
        response_mode: 'blocking',
        user: userName,
        conversation_id: conversationId || '',
        files: [],
        auto_generate_name: false
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[DIFY] Error:', errorText.substring(0, 200));
      throw new Error(`Dify error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[DIFY] Response received, length:', data.answer?.length || 0);
    return data;
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[DIFY] Failed:', error.message);
    
    if (error.name === 'AbortError') {
      return {
        answer: "⏱️ Bu işlem çok uzun sürdü. Lütfen daha kısa bir mesajla tekrar dene.",
        conversation_id: conversationId
      };
    }
    
    return {
      answer: "💬 Şu anda yanıt veremiyorum ama tekrar deneyebilirsin! 😊",
      conversation_id: conversationId
    };
  }
}

// Send to Telegram
async function sendToTelegram(chatId, difyResponse, replyToMessageId, businessConnectionId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { text, images } = parseDifyResponse(difyResponse);
  
  console.log('[SEND] Sending response...');
  console.log('[SEND] Text:', text.substring(0, 100));
  console.log('[SEND] Images:', images.length);
  
  try {
    let endpoint, params;
    
    if (images.length === 0) {
      // Text only
      endpoint = 'sendMessage';
      params = {
        chat_id: chatId,
        text: text,
        disable_web_page_preview: false,
        parse_mode: 'HTML'
      };
      
    } else if (images.length === 1) {
      // Single photo
      endpoint = 'sendPhoto';
      params = {
        chat_id: chatId,
        photo: images[0],
        caption: text.substring(0, 1024),
        parse_mode: 'HTML'
      };
      
    } else {
      // Media group
      endpoint = 'sendMediaGroup';
      const media = images.slice(0, 10).map((url, index) => ({
        type: 'photo',
        media: url,
        caption: index === 0 ? text.substring(0, 1024) : undefined,
        parse_mode: index === 0 ? 'HTML' : undefined
      }));
      
      params = {
        chat_id: chatId,
        media: media
      };
    }
    
    // Add business connection or reply
    if (businessConnectionId) {
      params.business_connection_id = businessConnectionId;
    } else if (replyToMessageId) {
      params.reply_to_message_id = replyToMessageId;
    }
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }
    
    console.log('[SEND] Success!');
    return data.result;
    
  } catch (error) {
    console.error('[SEND] Failed:', error.message);
    
    // Send fallback message
    const fallbackParams = {
      chat_id: chatId,
      text: CONSTANTS.FALLBACK_MESSAGE
    };
    
    if (businessConnectionId) {
      fallbackParams.business_connection_id = businessConnectionId;
    } else if (replyToMessageId) {
      fallbackParams.reply_to_message_id = replyToMessageId;
    }
    
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fallbackParams)
    });
  }
}

// Send typing action
async function sendTypingAction(chatId, businessConnectionId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  const params = {
    chat_id: chatId,
    action: 'typing'
  };
  
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
  }
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
  } catch (error) {
    console.error('[TYPING] Failed:', error.message);
  }
}

// Mark business message as read
async function markBusinessMessageAsRead(chatId, messageId, businessConnectionId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!businessConnectionId) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/readBusinessMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_connection_id: businessConnectionId,
        chat_id: chatId,
        message_id: messageId
      })
    });
    console.log('[READ] Marked as read');
  } catch (error) {
    console.error('[READ] Failed:', error.message);
  }
}

// Process queue item
async function processQueueItem(item) {
  const itemId = `${item.userId}_${item.messageId}`;
  
  // Check if already processing
  if (processingMap.has(itemId)) {
    console.log('[PROCESS] Already processing:', itemId);
    return;
  }
  
  processingMap.set(itemId, true);
  
  try {
    console.log('[PROCESS] Starting:', itemId);
    
    // Keep typing indicator active
    const typingInterval = setInterval(() => {
      sendTypingAction(item.chatId, item.businessConnectionId);
    }, 5000);
    
    // Get session
    const session = getSession(item.userId);
    
    // Call Dify
    const difyResponse = await callDifyAPI(
      item.text,
      item.userName,
      session.conversationId
    );
    
    // Update session
    if (difyResponse.conversation_id) {
      updateSession(item.userId, difyResponse.conversation_id);
    }
    
    // Stop typing
    clearInterval(typingInterval);
    
    // Send response
    await sendToTelegram(
      item.chatId,
      difyResponse,
      item.messageId,
      item.businessConnectionId
    );
    
    console.log('[PROCESS] Completed:', itemId);
    
  } catch (error) {
    console.error('[PROCESS] Failed:', itemId, error.message);
  } finally {
    processingMap.delete(itemId);
  }
}

// Background processor
async function processQueue() {
  if (messageQueue.length === 0) return;
  
  console.log('[QUEUE] Processing', messageQueue.length, 'items');
  
  // Process all items in queue
  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    
    // Skip old items (older than 5 minutes)
    if (Date.now() - item.timestamp > 300000) {
      console.log('[QUEUE] Skipping old item');
      continue;
    }
    
    // Process item (don't await, let them run in parallel)
    processQueueItem(item);
    
    // Small delay between starting each item
    await new Promise(resolve => setTimeout(resolve, CONSTANTS.PROCESS_DELAY));
  }
}

// Main webhook handler
export default async function handler(req, res) {
  console.log('=====================================');
  console.log(`[WEBHOOK] Called at ${new Date().toISOString()}`);
  console.log('[WEBHOOK] Method:', req.method);
  
  // Handle process endpoint
  if (req.method === 'GET' && req.query?.process === 'true') {
    await processQueue();
    return res.status(200).json({ processed: true });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Check environment
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.DIFY_API_URL || !process.env.DIFY_API_TOKEN) {
    console.error('[ENV] Missing required variables');
    return res.status(500).json({ error: 'Configuration error' });
  }

  try {
    const update = req.body;
    
    if (!update) {
      return res.status(400).json({ error: 'No body' });
    }
    
    let message = null;
    let businessConnectionId = null;
    
    // Extract message
    if (update.message?.text || update.message?.caption) {
      message = update.message;
    } else if (update.business_message?.text || update.business_message?.caption) {
      message = update.business_message;
      businessConnectionId = update.business_message.business_connection_id;
    }
    
    if (!message) {
      return res.status(200).json({ ok: true });
    }
    
    // Only process private chats
    if (!businessConnectionId && message.chat.type !== 'private') {
      return res.status(200).json({ ok: true });
    }
    
    const chatId = message.chat?.id;
    const messageId = message.message_id;
    const userId = message.from?.id;
    const userName = message.from?.first_name || 'User';
    const text = message.text || message.caption || '';
    
    console.log('[MESSAGE] From:', userName, `(${userId})`);
    console.log('[MESSAGE] Text:', text.substring(0, 100));
    
    // Mark as read for business messages
    if (businessConnectionId) {
      await markBusinessMessageAsRead(chatId, messageId, businessConnectionId);
    }
    
    // Send initial typing indicator
    await sendTypingAction(chatId, businessConnectionId);
    
    // Add to queue
    const queueItem = {
      chatId,
      messageId,
      userId,
      userName,
      text,
      businessConnectionId,
      timestamp: Date.now()
    };
    
    messageQueue.push(queueItem);
    
    // Limit queue size
    if (messageQueue.length > CONSTANTS.MAX_QUEUE_SIZE) {
      messageQueue.shift(); // Remove oldest
    }
    
    console.log('[QUEUE] Added to queue, size:', messageQueue.length);
    
    // Start processing in background (don't await)
    processQueue().catch(err => console.error('[QUEUE] Process error:', err));
    
    // Return immediately
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    return res.status(200).json({ ok: true });
  }
}
