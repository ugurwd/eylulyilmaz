// Adult Companion Telegram Bot Service for Vercel
// File: api/webhook.js

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  FETCH_TIMEOUT: 120000, // 120 seconds for AI response
  RETRY_ATTEMPTS: 2,
  RETRY_DELAY: 1000,
  FALLBACK_MESSAGE: "😔 Üzgünüm, şu anda bir sorun yaşıyorum. Lütfen birkaç dakika sonra tekrar dene.",
};

// Rate limiting class
class RateLimiter {
  constructor() {
    this.requests = new Map();
    this.windowSize = 60 * 1000; // 1 minute
    this.maxRequests = 30; // Increased for companion bot
  }

  isAllowed(userId) {
    if (!userId) return false;
    
    const now = Date.now();
    const userKey = userId.toString();
    
    if (!this.requests.has(userKey)) {
      this.requests.set(userKey, []);
    }
    
    const userRequests = this.requests.get(userKey);
    const validRequests = userRequests.filter(timestamp => now - timestamp < this.windowSize);
    this.requests.set(userKey, validRequests);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }
    
    validRequests.push(now);
    return true;
  }
}

// Session Manager for conversation continuity
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = 10000;
    this.sessionTTL = 24 * 60 * 60 * 1000; // 24 hours
    
    console.log('✅ Session manager initialized');
    // Cleanup old sessions every hour
    setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  getUserSession(userId) {
    if (!userId || typeof userId !== 'number') {
      throw new Error('Invalid userId provided');
    }

    const now = Date.now();
    const sessionKey = userId.toString();
    
    if (this.sessions.has(sessionKey)) {
      const session = this.sessions.get(sessionKey);
      if (now - session.createdAt > this.sessionTTL) {
        this.sessions.delete(sessionKey);
      } else {
        session.lastAccessed = now;
        return session;
      }
    }

    const newSession = {
      userId,
      conversationId: '',
      createdAt: now,
      lastAccessed: now,
      messageCount: 0
    };

    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestSession();
    }

    this.sessions.set(sessionKey, newSession);
    return newSession;
  }

  updateUserSession(userId, conversationId) {
    if (!userId || typeof userId !== 'number') return;
    
    const session = this.getUserSession(userId);
    session.conversationId = conversationId || '';
    session.lastAccessed = Date.now();
    session.messageCount++;
  }

  evictOldestSession() {
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, session] of this.sessions) {
      if (session.lastAccessed < oldestTime) {
        oldestTime = session.lastAccessed;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.sessions.delete(oldestKey);
    }
  }

  cleanup() {
    const now = Date.now();
    const keysToDelete = [];
    
    for (const [key, session] of this.sessions) {
      if (now - session.createdAt > this.sessionTTL) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => {
      this.sessions.delete(key);
    });
    
    console.log(`🧹 Cleaned up ${keysToDelete.length} expired sessions`);
  }
}

// Initialize managers
const sessionManager = new SessionManager();
const rateLimiter = new RateLimiter();

// Fetch with timeout wrapper
async function fetchWithTimeout(url, options = {}, timeout = CONSTANTS.FETCH_TIMEOUT) {
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
    throw error;
  }
}

// Retry operation wrapper
async function retryOperation(operation, maxAttempts = CONSTANTS.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      
      const delay = CONSTANTS.RETRY_DELAY * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
      console.log(`🔄 Retry attempt ${attempt + 1}/${maxAttempts} after ${delay}ms`);
    }
  }
}

// Get Dify AI response
async function getDifyResponse(userMessage, userName = 'User', conversationId = '') {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  console.log('🤖 Calling Dify AI...');
  console.log('📍 API URL:', DIFY_API_URL);
  console.log('🔑 Token exists:', !!DIFY_API_TOKEN);
  console.log('💬 Message preview:', userMessage.substring(0, 100));
  console.log('🆔 Conversation ID:', conversationId || 'new');

  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    throw new Error('Dify API configuration missing');
  }

  if (!userMessage || typeof userMessage !== 'string') {
    throw new Error('Invalid user message');
  }

  // Truncate if message is too long
  if (userMessage.length > 4000) {
    userMessage = userMessage.substring(0, 4000) + '...';
  }

  return retryOperation(async () => {
    const requestBody = {
      inputs: {},
      query: userMessage,
      response_mode: 'blocking',
      user: userName,
      conversation_id: conversationId || '',
      files: [],
      auto_generate_name: true
    };

    const fullUrl = `${DIFY_API_URL}/chat-messages`;
    console.log('🌐 Making request to:', fullUrl);

    const response = await fetchWithTimeout(fullUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'CompanionBot/1.0'
      },
      body: JSON.stringify(requestBody),
    });

    console.log('📥 Dify response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Dify API error:', errorText);
      throw new Error(`Dify API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Dify response received');
    console.log('📋 Response data:', {
      hasAnswer: !!data.answer,
      answerLength: data.answer?.length || 0,
      conversationId: data.conversation_id,
      messageId: data.message_id
    });
    
    return data;
  });
}

// Telegram API call wrapper
async function telegramApiCall(method, params) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!BOT_TOKEN) {
    throw new Error('Telegram bot token missing');
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  
  console.log(`📱 Telegram API call: ${method}`);
  console.log('📋 Parameters:', JSON.stringify(params).substring(0, 200));
  
  return retryOperation(async () => {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    }, 10000); // 10 second timeout for Telegram

    const data = await response.json();
    
    if (!data.ok) {
      const error = new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
      error.code = data.error_code;
      error.description = data.description;
      
      console.error('❌ Telegram API Error:', {
        code: data.error_code,
        description: data.description,
        method: method,
        params: JSON.stringify(params).substring(0, 200)
      });
      
      // Don't retry on client errors
      if (data.error_code === 400 || data.error_code === 403 || data.error_code === 404) {
        error.noRetry = true;
      }
      
      throw error;
    }

    console.log('✅ Telegram API call successful:', method);
    return data.result;
  });
}

// Process and clean text for Telegram
function processTextForTelegram(text) {
  if (!text) return '';
  
  // Remove any image URLs or markdown images
  let cleaned = text;
  
  // Remove markdown image syntax ![alt](url)
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '');
  
  // Remove standalone image URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s\n]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?/gi, '');
  
  // Handle literal \n from Dify
  cleaned = cleaned.replace(/\\n/g, '\n');
  
  // Clean up excessive newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  // Ensure text doesn't exceed Telegram limits
  if (cleaned.length > CONSTANTS.MAX_MESSAGE_LENGTH) {
    cleaned = cleaned.substring(0, CONSTANTS.MAX_MESSAGE_LENGTH - 3) + '...';
  }
  
  return cleaned.trim();
}

// Send message to Telegram with proper error handling
async function sendTelegramMessage(chatId, text, replyToMessageId = null, businessConnectionId = null) {
  if (!chatId) {
    throw new Error('Invalid chat ID');
  }
  
  if (!text || text.length === 0) {
    text = "✨ İşte senin için hazırladığım yanıt!";
  }
  
  // Process text for Telegram
  const processedText = processTextForTelegram(text);
  
  console.log('📤 Sending message to Telegram');
  console.log('Chat ID:', chatId);
  console.log('Text length:', processedText.length);
  console.log('Reply to:', replyToMessageId);
  console.log('Business connection:', businessConnectionId);
  
  try {
    // Build message parameters
    const params = {
      chat_id: chatId,
      text: processedText,
      parse_mode: 'HTML', // Using HTML for better compatibility
      disable_web_page_preview: true
    };
    
    if (replyToMessageId) {
      params.reply_to_message_id = replyToMessageId;
    }
    
    if (businessConnectionId) {
      params.business_connection_id = businessConnectionId;
    }
    
    // Send the message
    const result = await telegramApiCall('sendMessage', params);
    console.log('✅ Message sent successfully to Telegram');
    return result;
    
  } catch (error) {
    console.error('❌ Failed to send message:', error);
    
    // Try sending without parse_mode if it failed
    if (error.description && error.description.includes('parse')) {
      console.log('🔄 Retrying without parse_mode...');
      
      const fallbackParams = {
        chat_id: chatId,
        text: processedText,
        disable_web_page_preview: true
      };
      
      if (replyToMessageId) {
        fallbackParams.reply_to_message_id = replyToMessageId;
      }
      
      if (businessConnectionId) {
        fallbackParams.business_connection_id = businessConnectionId;
      }
      
      return await telegramApiCall('sendMessage', fallbackParams);
    }
    
    throw error;
  }
}

// Handle incoming messages
async function handleMessage(message, isBusiness = false) {
  const startTime = Date.now();
  const businessConnectionId = isBusiness ? message.business_connection_id : null;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const userMessage = message.text || message.caption || '';
  const userFirstName = message.from?.first_name || 'User';
  const userId = message.from?.id;

  console.log('=====================================');
  console.log('🎯 Processing new message');
  console.log('User:', userFirstName, '(ID:', userId, ')');
  console.log('Chat ID:', chatId);
  console.log('Message ID:', messageId);
  console.log('Is Business:', isBusiness);
  console.log('Message:', userMessage.substring(0, 100));
  console.log('=====================================');

  let typingInterval = null;

  try {
    // Send typing indicator
    console.log('⌨️ Sending typing indicator...');
    const typingParams = { 
      chat_id: chatId, 
      action: 'typing' 
    };
    
    if (businessConnectionId) {
      typingParams.business_connection_id = businessConnectionId;
    }
    
    await telegramApiCall('sendChatAction', typingParams);

    // Keep sending typing indicator every 5 seconds
    typingInterval = setInterval(async () => {
      try {
        await telegramApiCall('sendChatAction', typingParams);
      } catch (err) {
        console.error('Failed to send typing indicator:', err.message);
      }
    }, 5000);

    // Check rate limits
    if (!rateLimiter.isAllowed(userId)) {
      console.log('⚠️ Rate limit exceeded for user:', userId);
      clearInterval(typingInterval);
      await sendTelegramMessage(
        chatId, 
        "⏳ Lütfen biraz yavaşla, çok hızlı mesaj gönderiyorsun. Birkaç saniye bekle.",
        messageId,
        businessConnectionId
      );
      return;
    }

    // Only respond to private messages unless it's a business message
    if (!isBusiness && message.chat.type !== 'private') {
      console.log('⚠️ Ignoring non-private message');
      clearInterval(typingInterval);
      return;
    }

    // Get or create user session
    console.log('📁 Getting user session...');
    const session = sessionManager.getUserSession(userId);
    console.log('Session:', {
      conversationId: session.conversationId || 'new',
      messageCount: session.messageCount
    });

    // Call Dify AI
    console.log('🤖 Calling Dify AI...');
    const difyResponse = await getDifyResponse(
      userMessage, 
      userFirstName, 
      session.conversationId
    );

    // Update session with conversation ID
    if (difyResponse?.conversation_id) {
      sessionManager.updateUserSession(userId, difyResponse.conversation_id);
      console.log('💾 Session updated with conversation ID:', difyResponse.conversation_id);
    }

    // Extract response text
    const responseText = difyResponse?.answer || "🤔 Bir şeyler ters gitti, tekrar dener misin?";
    console.log('📝 AI Response received, length:', responseText.length);

    // Clear typing indicator before sending
    clearInterval(typingInterval);
    typingInterval = null;

    // Send the response to Telegram
    console.log('📨 Sending response to Telegram...');
    await sendTelegramMessage(chatId, responseText, messageId, businessConnectionId);
    
    const processingTime = Date.now() - startTime;
    console.log(`✅ Message processed successfully in ${processingTime}ms`);

  } catch (error) {
    console.error('💥 Error processing message:', error);
    console.error('Error stack:', error.stack);
    
    // Clear typing indicator
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    
    // Send fallback message to user
    try {
      await sendTelegramMessage(
        chatId, 
        CONSTANTS.FALLBACK_MESSAGE, 
        messageId, 
        businessConnectionId
      );
    } catch (fallbackError) {
      console.error('❌ Failed to send fallback message:', fallbackError);
    }
  }
}

// Main webhook handler
export default async function handler(req, res) {
  console.log('=====================================');
  console.log(`🚀 Webhook called at ${new Date().toISOString()}`);
  console.log('Method:', req.method);
  console.log('Headers:', req.headers);
  console.log('=====================================');

  // Check environment variables
  const missingVars = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) missingVars.push('TELEGRAM_BOT_TOKEN');
  if (!process.env.DIFY_API_URL) missingVars.push('DIFY_API_URL');
  if (!process.env.DIFY_API_TOKEN) missingVars.push('DIFY_API_TOKEN');
  
  if (missingVars.length > 0) {
    console.error('❌ Missing environment variables:', missingVars);
    return res.status(500).json({ 
      error: 'Missing environment variables', 
      missing: missingVars 
    });
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check for request body
  if (!req.body) {
    return res.status(400).json({ error: 'No request body' });
  }

  try {
    const update = req.body;
    console.log('📨 Update received:', JSON.stringify(update).substring(0, 500));
    console.log('Update type:', Object.keys(update).filter(key => key !== 'update_id'));
    
    // Handle business connection updates
    if (update.business_connection) {
      console.log('🔗 Business connection update received');
      return res.status(200).json({ status: 'ok' });
    }

    // Handle business messages
    if (update.business_message) {
      console.log('🏢 Processing business message...');
      await handleMessage(update.business_message, true);
      return res.status(200).json({ status: 'ok' });
    }

    // Handle regular messages
    if (update.message) {
      console.log('💬 Processing regular message...');
      await handleMessage(update.message, false);
      return res.status(200).json({ status: 'ok' });
    }

    // Handle callback queries (button presses)
    if (update.callback_query) {
      console.log('🔘 Callback query received (ignoring)');
      return res.status(200).json({ status: 'ok' });
    }

    // No relevant update type found
    console.log('ℹ️ No action needed for this update type');
    return res.status(200).json({ status: 'ok' });

  } catch (error) {
    console.error('💥 Critical webhook error:', error);
    console.error('Stack:', error.stack);
    
    // Try to notify user about the error
    try {
      const update = req.body;
      const chatId = update.message?.chat?.id || update.business_message?.chat?.id;
      
      if (chatId) {
        await sendTelegramMessage(chatId, CONSTANTS.FALLBACK_MESSAGE);
      }
    } catch (notifyError) {
      console.error('Failed to notify user:', notifyError);
    }
    
    // Always return 200 to prevent Telegram from retrying
    return res.status(200).json({ 
      status: 'error_handled',
      timestamp: new Date().toISOString()
    });
  }
}
