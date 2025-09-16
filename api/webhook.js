// Optimized Telegram Bot for Vercel Pro - No generating message
// File: api/webhook.js

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  DIFY_TIMEOUT: 58000, // 58 seconds for Vercel Pro (max safe limit)
  TELEGRAM_TIMEOUT: 8000,
  FALLBACK_MESSAGE: "😔 Üzgünüm, bir sorun oluştu. Lütfen tekrar dene.",
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
  
  // Clean old sessions
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

// Parse Dify response to extract text and image URLs
function parseDifyResponse(difyResponse) {
  const answer = difyResponse?.answer || '';
  
  // Fixed regex to properly capture image URLs
  const urlRegex = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?)/gi;
  
  const imageUrls = [];
  let match;
  while ((match = urlRegex.exec(answer)) !== null) {
    imageUrls.push(match[1]);
  }
  
  // Remove URLs from text
  let cleanText = answer;
  imageUrls.forEach(url => {
    cleanText = cleanText.replace(url, '');
  });
  
  // Clean up formatting
  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  
  if (!cleanText && imageUrls.length > 0) {
    cleanText = "✨ İşte senin için hazırladıklarım:";
  }
  
  return {
    text: cleanText || CONSTANTS.FALLBACK_MESSAGE,
    images: imageUrls
  };
}

// Optimized Dify API call - handles both streaming and blocking
async function getDifyResponse(userMessage, userName = 'User', conversationId = '') {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  console.log('[DIFY] Starting request...');
  console.log('[DIFY] Message:', userMessage.substring(0, 100));
  console.log('[DIFY] ConversationId:', conversationId || 'new');

  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    throw new Error('Dify API not configured');
  }

  // Try blocking mode first (more reliable)
  const requestBody = {
    inputs: {},
    query: userMessage,
    response_mode: 'blocking', // Use blocking for reliability
    user: userName,
    conversation_id: conversationId || '',
    files: [],
    auto_generate_name: false
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.DIFY_TIMEOUT);

  try {
    const startTime = Date.now();
    
    const response = await fetch(`${DIFY_API_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    
    const elapsed = Date.now() - startTime;
    console.log(`[DIFY] Response received in ${elapsed}ms`);
    console.log('[DIFY] Status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[DIFY] Error:', errorText.substring(0, 500));
      throw new Error(`Dify error: ${response.status}`);
    }

    // Handle the response based on content type
    const contentType = response.headers.get('content-type');
    console.log('[DIFY] Content-Type:', contentType);
    
    if (contentType?.includes('text/event-stream')) {
      // Handle streaming response
      console.log('[DIFY] Handling streaming response...');
      
      const text = await response.text();
      const lines = text.split('\n');
      
      let fullAnswer = '';
      let finalConversationId = conversationId;
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;
          
          try {
            const data = JSON.parse(jsonStr);
            if (data.answer) fullAnswer += data.answer;
            if (data.conversation_id) finalConversationId = data.conversation_id;
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
      
      console.log('[DIFY] Streaming complete. Answer length:', fullAnswer.length);
      
      return {
        answer: fullAnswer || "💬 Merhaba! Seninle sohbet etmek istiyorum 💕",
        conversation_id: finalConversationId
      };
      
    } else {
      // Handle JSON response (blocking mode)
      const data = await response.json();
      console.log('[DIFY] Blocking response received. Answer length:', data.answer?.length || 0);
      
      return {
        answer: data.answer || "💬 Merhaba! Seninle sohbet etmek istiyorum 💕",
        conversation_id: data.conversation_id || conversationId
      };
    }
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[DIFY] Error:', error.message);
    
    if (error.name === 'AbortError' || error.message === 'Request timeout') {
      // Timeout - return friendly message
      return {
        answer: "⏱️ Bu biraz uzun sürdü... Daha kısa bir mesajla tekrar dener misin? 😊",
        conversation_id: conversationId
      };
    }
    
    // Other errors
    return {
      answer: "💬 Hemen yanıt veremiyorum ama seninle konuşmak istiyorum! Tekrar dener misin? 💕",
      conversation_id: conversationId
    };
  }
}

// Send photo to Telegram
async function sendTelegramPhoto(chatId, photoUrl, caption = '', replyToMessageId = null, businessConnectionId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  console.log('[TELEGRAM] Sending photo...');
  console.log('[TELEGRAM] URL:', photoUrl.substring(0, 100));
  
  const params = {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption.substring(0, 1024),
    parse_mode: 'HTML'
  };
  
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
  } else if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.TELEGRAM_TIMEOUT);
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      }
    );
    
    clearTimeout(timeoutId);
    const data = await response.json();
    
    if (!data.ok) {
      console.error('[TELEGRAM] Photo error:', data.description);
      throw new Error(data.description);
    }
    
    console.log('[TELEGRAM] Photo sent successfully!');
    return data.result;
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[TELEGRAM] Photo failed:', error.message);
    throw error;
  }
}

// Send media group
async function sendTelegramMediaGroup(chatId, photoUrls, caption = '', replyToMessageId = null, businessConnectionId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  console.log('[TELEGRAM] Sending media group with', photoUrls.length, 'photos');
  
  const media = photoUrls.slice(0, 10).map((url, index) => ({
    type: 'photo',
    media: url,
    caption: index === 0 ? caption.substring(0, 1024) : undefined,
    parse_mode: index === 0 ? 'HTML' : undefined
  }));
  
  const params = {
    chat_id: chatId,
    media: media
  };
  
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
  } else if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.TELEGRAM_TIMEOUT * 2);
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      }
    );
    
    clearTimeout(timeoutId);
    const data = await response.json();
    
    if (!data.ok) {
      console.error('[TELEGRAM] Media group error:', data.description);
      throw new Error(data.description);
    }
    
    console.log('[TELEGRAM] Media group sent!');
    return data.result;
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[TELEGRAM] Media group failed:', error.message);
    throw error;
  }
}

// Send text message
async function sendTelegramMessage(chatId, text, replyToMessageId = null, businessConnectionId = null) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  console.log('[TELEGRAM] Sending message...');
  console.log('[TELEGRAM] Text:', text.substring(0, 100));
  
  const params = {
    chat_id: chatId,
    text: text.substring(0, CONSTANTS.MAX_MESSAGE_LENGTH),
    disable_web_page_preview: false,
    parse_mode: 'HTML'
  };
  
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
  } else if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.TELEGRAM_TIMEOUT);
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      }
    );
    
    clearTimeout(timeoutId);
    const data = await response.json();
    
    if (!data.ok) {
      console.error('[TELEGRAM] Message error:', data.description);
      throw new Error(data.description);
    }
    
    console.log('[TELEGRAM] Message sent!');
    return data.result;
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[TELEGRAM] Message failed:', error.message);
    throw error;
  }
}

// Smart message sender
async function sendSmartMessage(chatId, difyResponse, replyToMessageId = null, businessConnectionId = null) {
  const { text, images } = parseDifyResponse(difyResponse);
  
  console.log('[SMART] Text:', text.substring(0, 100));
  console.log('[SMART] Images:', images.length);
  
  try {
    if (images.length === 0) {
      // Text only
      return await sendTelegramMessage(chatId, text, replyToMessageId, businessConnectionId);
    } else if (images.length === 1) {
      // Single image with caption
      return await sendTelegramPhoto(chatId, images[0], text, replyToMessageId, businessConnectionId);
    } else {
      // Multiple images
      const result = await sendTelegramMediaGroup(chatId, images, text, replyToMessageId, businessConnectionId);
      
      // Send remaining text if too long
      if (text.length > 1024) {
        await sendTelegramMessage(chatId, text.substring(1024), null, businessConnectionId);
      }
      
      return result;
    }
  } catch (error) {
    console.error('[SMART] Failed, fallback to text');
    const fallbackText = text + (images.length > 0 ? '\n\n' + images.join('\n\n') : '');
    return await sendTelegramMessage(chatId, fallbackText, replyToMessageId, businessConnectionId);
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

// Mark message as read
async function markBusinessMessageAsRead(chatId, messageId, businessConnectionId) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!businessConnectionId) return;
  
  console.log('[READ] Marking as read...');
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/readBusinessMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_connection_id: businessConnectionId,
        chat_id: chatId,
        message_id: messageId
      })
    });
    
    const data = await response.json();
    if (data.ok) {
      console.log('[READ] ✅ Marked as read');
    }
  } catch (error) {
    console.error('[READ] Failed:', error.message);
  }
}

// Main message handler
async function handleMessage(message, businessConnectionId = null) {
  const startTime = Date.now();
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const userMessage = message.text || message.caption || '';
  const userId = message.from?.id;
  const userName = message.from?.first_name || 'User';
  
  console.log('=====================================');
  console.log('[MESSAGE] New message');
  console.log('[MESSAGE] Type:', businessConnectionId ? 'BUSINESS' : 'REGULAR');
  console.log('[MESSAGE] From:', userName, `(${userId})`);
  console.log('[MESSAGE] Text:', userMessage.substring(0, 100));
  console.log('=====================================');

  if (!chatId || !userMessage) return;
  
  // Only respond to private chats
  if (!businessConnectionId && message.chat.type !== 'private') return;

  let typingInterval = null;

  try {
    // Mark as read for business messages
    if (businessConnectionId && messageId) {
      await markBusinessMessageAsRead(chatId, messageId, businessConnectionId);
    }
    
    // Start typing
    await sendTypingAction(chatId, businessConnectionId);
    
    // Keep typing indicator active
    typingInterval = setInterval(() => {
      sendTypingAction(chatId, businessConnectionId);
      console.log('[TYPING] Refreshed');
    }, 5000);
    
    // Get session
    const session = getSession(userId);
    console.log('[SESSION] Conversation:', session.conversationId || 'new');
    
    // Call Dify
    const difyResponse = await getDifyResponse(
      userMessage,
      userName,
      session.conversationId
    );
    
    // Stop typing
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    
    // Update session
    if (difyResponse?.conversation_id) {
      updateSession(userId, difyResponse.conversation_id);
      console.log('[SESSION] Updated:', difyResponse.conversation_id);
    }
    
    // Send response
    console.log('[RESPONSE] Sending...');
    await sendSmartMessage(chatId, difyResponse, messageId, businessConnectionId);
    
    const elapsed = Date.now() - startTime;
    console.log(`[SUCCESS] ✅ Completed in ${elapsed}ms`);
    
  } catch (error) {
    console.error('[ERROR] Failed:', error.message);
    
    // Stop typing
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    
    // Send fallback
    try {
      await sendTelegramMessage(chatId, CONSTANTS.FALLBACK_MESSAGE, messageId, businessConnectionId);
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
  console.log('=====================================');
  
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
    
    // Handle message types
    if (update.message?.text || update.message?.caption) {
      await handleMessage(update.message, null);
    } else if (update.business_message?.text || update.business_message?.caption) {
      const businessConnectionId = update.business_message.business_connection_id;
      await handleMessage(update.business_message, businessConnectionId);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[WEBHOOK] Completed in ${elapsed}ms`);
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    return res.status(200).json({ ok: true });
  }
}
