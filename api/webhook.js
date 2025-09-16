// Queue-Based Telegram Bot with Background Processing
// File structure:
// - api/webhook.js (receives messages, adds to queue)
// - api/process.js (processes queue items)

// ============================================
// File: api/webhook.js - Main webhook handler
// ============================================

import { kv } from '@vercel/kv'; // You need to enable Vercel KV Storage

// Constants
const CONSTANTS = {
  QUEUE_KEY: 'message_queue',
  PROCESSING_KEY: 'processing',
  MAX_QUEUE_SIZE: 1000,
};

// Add message to queue
async function addToQueue(message, businessConnectionId = null) {
  const queueItem = {
    id: `${message.from.id}_${Date.now()}`,
    chatId: message.chat.id,
    messageId: message.message_id,
    userId: message.from.id,
    userName: message.from.first_name || 'User',
    text: message.text || message.caption || '',
    businessConnectionId: businessConnectionId,
    timestamp: Date.now(),
    status: 'pending'
  };
  
  // Add to queue in Vercel KV
  await kv.lpush(CONSTANTS.QUEUE_KEY, JSON.stringify(queueItem));
  
  // Trim queue to max size
  await kv.ltrim(CONSTANTS.QUEUE_KEY, 0, CONSTANTS.MAX_QUEUE_SIZE);
  
  console.log('[QUEUE] Added item:', queueItem.id);
  return queueItem;
}

// Send typing indicator
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

// Trigger background processing
async function triggerProcessing() {
  try {
    // Call the process endpoint
    // Using internal function call to avoid network overhead
    fetch(`${process.env.VERCEL_URL}/api/process`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.INTERNAL_SECRET || 'secret'}`,
      }
    }).catch(err => console.log('[TRIGGER] Background process started'));
  } catch (error) {
    console.error('[TRIGGER] Failed to start processing:', error.message);
  }
}

// Main webhook handler
export default async function handler(req, res) {
  console.log('=====================================');
  console.log(`[WEBHOOK] Called at ${new Date().toISOString()}`);
  console.log('[WEBHOOK] Method:', req.method);
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
    
    console.log('[MESSAGE] From:', message.from.first_name, `(${message.from.id})`);
    console.log('[MESSAGE] Text:', (message.text || message.caption || '').substring(0, 100));
    
    // Mark as read for business messages
    if (businessConnectionId) {
      await markBusinessMessageAsRead(message.chat.id, message.message_id, businessConnectionId);
    }
    
    // Send typing indicator
    await sendTypingAction(message.chat.id, businessConnectionId);
    
    // Add to queue
    await addToQueue(message, businessConnectionId);
    
    // Trigger background processing
    await triggerProcessing();
    
    console.log('[WEBHOOK] Message queued successfully');
    
    // Return immediately (don't wait for processing)
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    return res.status(200).json({ ok: true });
  }
}

// ============================================
// File: api/process.js - Background processor
// ============================================

import { kv } from '@vercel/kv';

const PROCESS_CONSTANTS = {
  QUEUE_KEY: 'message_queue',
  PROCESSING_KEY: 'processing',
  SESSION_KEY: 'sessions',
  DIFY_TIMEOUT: 55000,
  MAX_RETRIES: 2,
};

// Get session from KV
async function getSession(userId) {
  const sessions = await kv.hget(PROCESS_CONSTANTS.SESSION_KEY, userId) || {};
  return sessions.conversationId || '';
}

// Update session in KV
async function updateSession(userId, conversationId) {
  if (!conversationId) return;
  await kv.hset(PROCESS_CONSTANTS.SESSION_KEY, userId, { conversationId });
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
  
  return { text: cleanText, images: imageUrls };
}

// Call Dify API
async function callDifyAPI(text, userName, conversationId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROCESS_CONSTANTS.DIFY_TIMEOUT);
  
  try {
    const response = await fetch(`${process.env.DIFY_API_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DIFY_API_TOKEN}`,
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
      throw new Error(`Dify error: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      return {
        answer: "⏱️ Bu işlem çok uzun sürdü. Lütfen daha kısa bir mesajla tekrar dene.",
        conversation_id: conversationId
      };
    }
    
    throw error;
  }
}

// Send response to Telegram
async function sendToTelegram(chatId, difyResponse, replyToMessageId, businessConnectionId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { text, images } = parseDifyResponse(difyResponse);
  
  console.log('[SEND] Text:', text.substring(0, 100));
  console.log('[SEND] Images:', images.length);
  
  try {
    if (images.length === 0) {
      // Send text only
      const params = {
        chat_id: chatId,
        text: text || "💬 İşte yanıtım!",
        reply_to_message_id: replyToMessageId,
        disable_web_page_preview: false,
        parse_mode: 'HTML'
      };
      
      if (businessConnectionId) {
        params.business_connection_id = businessConnectionId;
        delete params.reply_to_message_id; // Don't reply for business messages
      }
      
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      
      const data = await response.json();
      if (!data.ok) throw new Error(data.description);
      
      return data.result;
      
    } else if (images.length === 1) {
      // Send single photo
      const params = {
        chat_id: chatId,
        photo: images[0],
        caption: text.substring(0, 1024),
        reply_to_message_id: replyToMessageId,
        parse_mode: 'HTML'
      };
      
      if (businessConnectionId) {
        params.business_connection_id = businessConnectionId;
        delete params.reply_to_message_id;
      }
      
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      
      const data = await response.json();
      if (!data.ok) throw new Error(data.description);
      
      return data.result;
      
    } else {
      // Send media group
      const media = images.slice(0, 10).map((url, index) => ({
        type: 'photo',
        media: url,
        caption: index === 0 ? text.substring(0, 1024) : undefined,
        parse_mode: index === 0 ? 'HTML' : undefined
      }));
      
      const params = {
        chat_id: chatId,
        media: media,
        reply_to_message_id: replyToMessageId
      };
      
      if (businessConnectionId) {
        params.business_connection_id = businessConnectionId;
        delete params.reply_to_message_id;
      }
      
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      
      const data = await response.json();
      if (!data.ok) throw new Error(data.description);
      
      return data.result;
    }
  } catch (error) {
    console.error('[SEND] Failed:', error.message);
    
    // Fallback to simple text
    const params = {
      chat_id: chatId,
      text: "😔 Yanıtı gönderemedim. Lütfen tekrar dene.",
      reply_to_message_id: replyToMessageId
    };
    
    if (businessConnectionId) {
      params.business_connection_id = businessConnectionId;
      delete params.reply_to_message_id;
    }
    
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
  }
}

// Process single queue item
async function processQueueItem(item) {
  console.log('[PROCESS] Processing:', item.id);
  const startTime = Date.now();
  
  try {
    // Get session
    const conversationId = await getSession(item.userId);
    
    // Call Dify
    const difyResponse = await callDifyAPI(
      item.text,
      item.userName,
      conversationId
    );
    
    // Update session
    if (difyResponse.conversation_id) {
      await updateSession(item.userId, difyResponse.conversation_id);
    }
    
    // Send response
    await sendToTelegram(
      item.chatId,
      difyResponse,
      item.messageId,
      item.businessConnectionId
    );
    
    const elapsed = Date.now() - startTime;
    console.log(`[PROCESS] Completed ${item.id} in ${elapsed}ms`);
    
    return true;
    
  } catch (error) {
    console.error(`[PROCESS] Failed ${item.id}:`, error.message);
    
    // Send error message
    try {
      const params = {
        chat_id: item.chatId,
        text: "😔 Bir sorun oluştu. Lütfen tekrar dene.",
        reply_to_message_id: item.messageId
      };
      
      if (item.businessConnectionId) {
        params.business_connection_id = item.businessConnectionId;
        delete params.reply_to_message_id;
      }
      
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
    } catch (err) {
      console.error('[PROCESS] Failed to send error message:', err.message);
    }
    
    return false;
  }
}

// Process queue
async function processQueue() {
  // Check if already processing
  const isProcessing = await kv.get(PROCESS_CONSTANTS.PROCESSING_KEY);
  if (isProcessing) {
    console.log('[QUEUE] Already processing, skipping');
    return { processed: 0, message: 'Already processing' };
  }
  
  // Set processing flag
  await kv.set(PROCESS_CONSTANTS.PROCESSING_KEY, true, { ex: 50 });
  
  let processed = 0;
  const maxProcess = 10; // Process max 10 items per run
  
  try {
    while (processed < maxProcess) {
      // Get next item from queue
      const itemJson = await kv.rpop(PROCESS_CONSTANTS.QUEUE_KEY);
      if (!itemJson) break;
      
      const item = JSON.parse(itemJson);
      
      // Skip old items (older than 5 minutes)
      if (Date.now() - item.timestamp > 300000) {
        console.log('[QUEUE] Skipping old item:', item.id);
        continue;
      }
      
      // Process item
      await processQueueItem(item);
      processed++;
      
      // Small delay between items
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
  } finally {
    // Clear processing flag
    await kv.del(PROCESS_CONSTANTS.PROCESSING_KEY);
  }
  
  console.log(`[QUEUE] Processed ${processed} items`);
  return { processed, message: 'Queue processed' };
}

// API handler for process endpoint
export default async function handler(req, res) {
  console.log('[PROCESSOR] Called at', new Date().toISOString());
  
  // Simple auth check
  const auth = req.headers.authorization;
  const expectedAuth = `Bearer ${process.env.INTERNAL_SECRET || 'secret'}`;
  
  if (auth !== expectedAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const result = await processQueue();
    return res.status(200).json(result);
  } catch (error) {
    console.error('[PROCESSOR] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
