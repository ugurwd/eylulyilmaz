// Complete Fixed Telegram Bot Service for Vercel
// File: api/webhook.js

// Constants
const CONSTANTS = {
  MAX_MESSAGE_LENGTH: 4096,
  FETCH_TIMEOUT: 120000, // 120 seconds for slow AI
  RETRY_ATTEMPTS: 2,
  RETRY_DELAY: 1000,
  FALLBACK_MESSAGE: "😔 Üzgünüm, şu anda teknik bir sorun yaşıyorum. Lütfen birkaç dakika sonra tekrar deneyin veya bizi doğrudan arayın.",
  DEFAULT_IMAGE_URL: "https://imagedelivery.net/pi0TLCQ1M2O8vn019UBQyw/d257f8eb-c711-4112-f66b-9a0f53bc5100/finalilogo"
};

// Rate limiting class
class RateLimiter {
  constructor() {
    this.requests = new Map();
    this.windowSize = 60 * 1000;
    this.maxRequests = 20;
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

// Session Manager
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.reservations = new Map();
    this.maxSessions = 10000;
    this.sessionTTL = 24 * 60 * 60 * 1000;
    
    console.log('✅ Professional session manager created');
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
        this.reservations.delete(sessionKey);
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
      requestCount: 0,
      reservationState: null
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
    session.requestCount++;
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
      this.reservations.delete(oldestKey);
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
      this.reservations.delete(key);
    });
    
    console.log(`🧹 Cleaned up ${keysToDelete.length} expired sessions`);
  }

  getStats() {
    return {
      totalSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      activeReservations: Array.from(this.reservations.values()).length
    };
  }
}

// Message Formatter with Better Telegram Integration
class MessageFormatter {
  
  // Extract markdown image syntax from Dify responses
  static extractMarkdownImages(text) {
    if (!text) return { cleanText: '', imageUrls: [] };
    
    const imageUrls = [];
    let cleanText = text;
    
    // Extract markdown image syntax: ![alt](url)
    const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    
    while ((match = markdownImageRegex.exec(text)) !== null) {
      const imageUrl = match[2];
      imageUrls.push(imageUrl);
      console.log('🖼️ Found markdown image:', imageUrl);
    }
    
    // Remove markdown images from text
    cleanText = cleanText.replace(markdownImageRegex, '').trim();
    
    // Also check for standalone URLs
    const additionalUrls = this.extractImageUrls(cleanText);
    imageUrls.push(...additionalUrls);
    
    // Remove standalone image URLs
    cleanText = this.removeImageUrls(cleanText);
    
    return {
      cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(),
      imageUrls: [...new Set(imageUrls)] // Remove duplicates
    };
  }
  
  // Enhanced image URL detection
  static isImageUrl(text) {
    if (!text || typeof text !== 'string') return false;
    
    const trimmed = text.trim();
    
    const imageUrlPatterns = [
      /^https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?$/i,
      /^https?:\/\/imagedelivery\.net[^\s]*$/i,
      /^https?:\/\/hcti\.io\/v1\/image\/[a-f0-9-]+$/i,
      /^https?:\/\/[^\s]*cloudinary\.com[^\s]*$/i,
      /^https?:\/\/[^\s]*imgur\.com[^\s]*$/i,
      /^https?:\/\/[^\s]*unsplash\.com[^\s]*$/i,
      /^https?:\/\/[^\s]*pexels\.com[^\s]*$/i,
    ];
    
    return imageUrlPatterns.some(pattern => pattern.test(trimmed));
  }

  // Extract image URLs from text
  static extractImageUrls(text) {
    if (!text) return [];
    
    const urls = [];
    const urlRegex = /https?:\/\/[^\s\n)]+/g;
    let match;
    
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      if (this.isImageUrl(url)) {
        urls.push(url);
        console.log('🖼️ Found image URL:', url);
      }
    }
    
    return urls;
  }

  // Remove image URLs from text
  static removeImageUrls(text) {
    if (!text) return '';
    
    // Remove standalone image URLs
    const urlRegex = /https?:\/\/[^\s\n)]+/g;
    return text.replace(urlRegex, (match) => {
      return this.isImageUrl(match) ? '' : match;
    }).replace(/\n{3,}/g, '\n\n').trim();
  }

  // Convert Dify markdown to Telegram-compatible formatting
  static formatForTelegram(text) {
    if (!text) return text;
    
    let formatted = text;
    
    // First handle literal \n sequences from Dify
    formatted = formatted.replace(/\\n/g, '\n');
    
    // Convert Dify's **bold** to Telegram's *bold*
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
    
    // Format section headers with emojis
    formatted = formatted
      // Specific section headers from Dify
      .replace(/\*Detaylı Açıklama:\*/g, '📋 *Detaylı Açıklama:*')
      .replace(/\*Alerjen Bilgisi:\*/g, '⚠️ *Alerjen Bilgisi:*')
      .replace(/\*Şarap Eşleşmesi Önerisi:\*/g, '🍷 *Şarap Eşleşmesi Önerisi:*')
      
      // Main menu categories
      .replace(/^(ANA YEMEKLER|BAŞLANGIÇLAR|TATLILAR|İÇECEKLER|SALATALAR)\s*$/gm, '🍽️ *$1*')
      
      // Bullet points from Dify (- item: description)
      .replace(/^-\s+([^:]+):\s*(.+)$/gm, '◦ *$1:* $2')
      
      // Format wine names in single quotes
      .replace(/'([^']+)'/g, '`$1`')
      
      // Add proper spacing around emoji headers
      .replace(/(📋|⚠️|🍷)\s*\*/g, '\n$1 *')
      .replace(/🍽️\s*\*/g, '\n🍽️ *')
      
      // Clean up excessive newlines but preserve paragraph breaks
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    return formatted;
  }

  // Main processing function for Dify responses
  static processDifyResponse(responseText) {
    console.log('📝 Processing Dify response for Telegram...');
    
    if (!responseText || typeof responseText !== 'string') {
      return {
        text: '',
        imageUrls: [],
        hasImages: false,
        useMarkdown: false
      };
    }

    // First extract markdown images
    const { cleanText, imageUrls } = this.extractMarkdownImages(responseText);
    
    console.log(`🖼️ Found ${imageUrls.length} images`);
    console.log('📝 Clean text length:', cleanText.length);

    if (cleanText.length > 0) {
      // Format text for Telegram
      const formattedText = this.formatForTelegram(cleanText);
      
      return {
        text: formattedText,
        imageUrls: imageUrls,
        hasImages: imageUrls.length > 0,
        useMarkdown: true
      };
    } else if (imageUrls.length > 0) {
      // Image-only response
      return {
        text: '',
        imageUrls: imageUrls,
        hasImages: true,
        useMarkdown: false
      };
    } else {
      // Fallback
      return {
        text: '✅ İşleminiz tamamlandı!',
        imageUrls: [],
        hasImages: false,
        useMarkdown: false
      };
    }
  }

  // Validate markdown for Telegram compatibility
  static validateTelegramMarkdown(text) {
    if (!text) return { isValid: true, cleaned: '' };
    
    try {
      let cleaned = text;
      
      // Fix unmatched asterisks
      const asteriskCount = (cleaned.match(/\*/g) || []).length;
      if (asteriskCount % 2 !== 0) {
        const lastAsterisk = cleaned.lastIndexOf('*');
        cleaned = cleaned.substring(0, lastAsterisk) + cleaned.substring(lastAsterisk + 1);
      }
      
      // Fix unmatched backticks
      const backtickCount = (cleaned.match(/`/g) || []).length;
      if (backtickCount % 2 !== 0) {
        const lastBacktick = cleaned.lastIndexOf('`');
        cleaned = cleaned.substring(0, lastBacktick) + cleaned.substring(lastBacktick + 1);
      }
      
      // Clean up malformed formatting
      cleaned = cleaned
        .replace(/\*\s*\*/g, '') // Remove empty bold
        .replace(/`\s*`/g, '') // Remove empty code
        .trim();
      
      return { isValid: true, cleaned };
      
    } catch (error) {
      console.error('❌ Markdown validation failed:', error);
      return { isValid: false, cleaned: text.replace(/[*`_]/g, '') };
    }
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
async function getDifyResponse(userMessage, userName = 'Müşteri', conversationId = '') {
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  console.log('🤖 getDifyResponse called');
  console.log('📍 API URL:', DIFY_API_URL);
  console.log('🔑 Token exists:', !!DIFY_API_TOKEN);

  if (!DIFY_API_URL || !DIFY_API_TOKEN) {
    throw new Error('Dify API configuration missing');
  }

  if (!userMessage || typeof userMessage !== 'string') {
    throw new Error('Invalid user message');
  }

  if (userMessage.length > 4000) {
    userMessage = userMessage.substring(0, 4000) + '...';
  }

  return retryOperation(async () => {
    console.log('📤 Sending to Dify:', { 
      message: userMessage.substring(0, 100), 
      user: userName,
      conversationId: conversationId || 'new'
    });

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
    console.log('🌐 Full request URL:', fullUrl);

    const response = await fetchWithTimeout(fullUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'RestaurantBot/1.0'
      },
      body: JSON.stringify(requestBody),
    });

    console.log('📥 Dify response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Dify API error response:', errorText);
      throw new Error(`Dify API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Dify response received successfully');
    console.log('📋 Response preview:', JSON.stringify(data).substring(0, 200));
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
  
  return retryOperation(async () => {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RestaurantBot/1.0'
      },
      body: JSON.stringify(params),
    });

    const data = await response.json();
    
    if (!data.ok) {
      const error = new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
      error.code = data.error_code;
      error.description = data.description;
      
      console.error('❌ Telegram API Error Details:', {
        code: data.error_code,
        description: data.description,
        method: method
      });
      
      if (data.error_code === 400 || data.error_code === 403 || data.error_code === 404) {
        error.noRetry = true;
      }
      
      throw error;
    }

    return data.result;
  });
}

// Send formatted message to Telegram
async function sendFormattedMessage(chatId, responseText, replyToMessageId, businessConnectionId = null) {
  if (!responseText || typeof responseText !== 'string') {
    throw new Error('Invalid response text');
  }

  if (!chatId) {
    throw new Error('Invalid chat ID');
  }

  try {
    console.log('📨 Processing message for Telegram delivery...');
    
    // Process the Dify response
    const processed = MessageFormatter.processDifyResponse(responseText);
    
    console.log('📋 Processing result:', {
      hasImages: processed.hasImages,
      imageCount: processed.imageUrls.length,
      hasText: processed.text.length > 0,
      textLength: processed.text.length,
      useMarkdown: processed.useMarkdown
    });

    // Send images first, then text
    if (processed.hasImages && processed.imageUrls.length > 0) {
      console.log(`📸 Sending ${processed.imageUrls.length} image(s)...`);
      
      // Send first image with caption if we have text
      const firstImageParams = {
        chat_id: chatId,
        photo: processed.imageUrls[0]
      };

      // Add caption if we have text (max 1024 chars for caption)
      if (processed.text && processed.text.length > 0) {
        let caption = processed.text;
        
        // Truncate caption if too long
        if (caption.length > 1000) {
          caption = caption.substring(0, 997) + '...';
        }
        
        firstImageParams.caption = caption;
        
        if (processed.useMarkdown) {
          firstImageParams.parse_mode = 'Markdown';
        }
      }

      if (replyToMessageId) {
        firstImageParams.reply_to_message_id = replyToMessageId;
      }

      if (businessConnectionId) {
        firstImageParams.business_connection_id = businessConnectionId;
      }

      try {
        await telegramApiCall('sendPhoto', firstImageParams);
        console.log('✅ First image sent successfully');
      } catch (imageError) {
        console.error('❌ Failed to send first image:', imageError);
        // Fall through to send text separately
      }

      // Send additional images
      for (let i = 1; i < processed.imageUrls.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Delay between images
        
        const additionalParams = {
          chat_id: chatId,
          photo: processed.imageUrls[i]
        };

        if (businessConnectionId) {
          additionalParams.business_connection_id = businessConnectionId;
        }

        try {
          await telegramApiCall('sendPhoto', additionalParams);
          console.log(`✅ Additional image ${i + 1} sent`);
        } catch (imageError) {
          console.error(`❌ Failed to send image ${i + 1}:`, imageError);
        }
      }

      // Send full text as separate message if it was truncated in caption
      if (processed.text && processed.text.length > 1000) {
        const validation = MessageFormatter.validateTelegramMarkdown(processed.text);
        
        const textParams = {
          chat_id: chatId,
          text: validation.cleaned,
          disable_web_page_preview: true
        };

        if (validation.isValid && processed.useMarkdown) {
          textParams.parse_mode = 'Markdown';
        }

        if (businessConnectionId) {
          textParams.business_connection_id = businessConnectionId;
        }

        try {
          await telegramApiCall('sendMessage', textParams);
          console.log('✅ Full text message sent');
        } catch (textError) {
          console.error('❌ Failed to send full text:', textError);
        }
      }

    } else if (processed.text && processed.text.length > 0) {
      // Text-only message
      console.log('📝 Sending text-only message...');
      
      const validation = MessageFormatter.validateTelegramMarkdown(processed.text);
      
      const params = {
        chat_id: chatId,
        text: validation.cleaned,
        disable_web_page_preview: true
      };

      if (validation.isValid && processed.useMarkdown) {
        params.parse_mode = 'Markdown';
      }

      if (replyToMessageId) {
        params.reply_to_message_id = replyToMessageId;
      }

      if (businessConnectionId) {
        params.business_connection_id = businessConnectionId;
      }

      await telegramApiCall('sendMessage', params);
      console.log('✅ Text message sent successfully');
      
    } else {
      // Fallback message
      console.log('⚠️ No content, sending fallback');
      const fallbackParams = {
        chat_id: chatId,
        text: "✅ *İşleminiz başarıyla tamamlandı!*",
        parse_mode: 'Markdown'
      };

      if (replyToMessageId) {
        fallbackParams.reply_to_message_id = replyToMessageId;
      }

      if (businessConnectionId) {
        fallbackParams.business_connection_id = businessConnectionId;
      }

      await telegramApiCall('sendMessage', fallbackParams);
    }

    return { success: true };

  } catch (error) {
    console.error('❌ Critical error in sendFormattedMessage:', error);
    
    // Final fallback
    const fallbackParams = {
      chat_id: chatId,
      text: "😔 Üzgünüm, şu anda teknik bir sorun yaşıyorum. Lütfen birkaç dakika sonra tekrar deneyin."
    };

    if (replyToMessageId) {
      fallbackParams.reply_to_message_id = replyToMessageId;
    }

    if (businessConnectionId) {
      fallbackParams.business_connection_id = businessConnectionId;
    }

    return await telegramApiCall('sendMessage', fallbackParams);
  }
}

// Handle incoming messages
async function handleMessage(message, isBusiness = false) {
    const startTime = Date.now();
    const businessConnectionId = isBusiness ? message.business_connection_id : null;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const userMessage = message.text || message.caption || 'Media message';
    const userFirstName = message.from?.first_name || (isBusiness ? 'Müşteri' : 'Kullanıcı');
    const userId = message.from?.id;

    console.log('🎯 handleMessage started:', {
        isBusiness,
        chatId,
        userId,
        messagePreview: userMessage.substring(0, 50)
    });

    let typingInterval = null;

    try {
        // Send typing indicator
        const typingParams = { chat_id: chatId, action: 'typing' };
        if (isBusiness) typingParams.business_connection_id = businessConnectionId;
        await telegramApiCall('sendChatAction', typingParams);

        // Keep sending typing indicator
        typingInterval = setInterval(() => {
            telegramApiCall('sendChatAction', typingParams).catch(console.error);
        }, 5000);

        // Check rate limits
        if (!rateLimiter.isAllowed(userId)) {
            console.log(`⚠️ Rate limit exceeded for user ${userId}`);
            clearInterval(typingInterval);
            return;
        }

        // Only respond to private messages (not groups) unless it's a business message
        if (!isBusiness && message.chat.type !== 'private') {
            console.log('⚠️ Ignoring non-private message');
            clearInterval(typingInterval);
            return;
        }

        console.log('✅ [Step 1] Initial checks passed. Preparing to call Dify AI.');
        
        // Get or create user session
        const session = sessionManager.getUserSession(userId);
        
        // Prepare contextual message
        const contextualMessage = isBusiness 
            ? `Müşteri: ${userFirstName}, Mesaj: ${userMessage}` 
            : userMessage;

        console.log('📤 [Step 2] Sending request to Dify AI...');
        console.log('Session info:', {
            conversationId: session.conversationId || 'new',
            requestCount: session.requestCount
        });

        // Call Dify AI
        const difyResponse = await getDifyResponse(
            contextualMessage, 
            userFirstName, 
            session.conversationId
        );
        
        console.log('📥 [Step 3] Successfully received response from Dify AI!');

        // Update session with conversation ID
        if (difyResponse?.conversation_id) {
            sessionManager.updateUserSession(userId, difyResponse.conversation_id);
            console.log('💾 Updated session with conversation ID:', difyResponse.conversation_id);
        }

        // Extract response text
        const responseText = difyResponse?.answer || "🤔 *Anlayamadım, lütfen tekrar söyler misiniz?*";
        
        console.log('✅ [Step 4] Sending final formatted message to Telegram.');
        await sendFormattedMessage(chatId, responseText, messageId, businessConnectionId);
        console.log('🎉 [Step 5] Process complete! Final message sent.');
        
        const processingTime = Date.now() - startTime;
        console.log(`⏱️ Message processed successfully in ${processingTime}ms`);

    } catch (error) {
        console.error('💥 [CRITICAL ERROR] The process failed:', error);
        console.error('Error stack:', error.stack);
        
        // Send fallback message to user
        try {
            await sendFormattedMessage(chatId, CONSTANTS.FALLBACK_MESSAGE, messageId, businessConnectionId);
        } catch (fallbackError) {
            console.error('❌ Failed to send fallback message:', fallbackError);
        }
    } finally {
        if (typingInterval) {
            clearInterval(typingInterval);
        }
    }
}

// Main webhook handler - FIXED FOR VERCEL
export default async function handler(req, res) {
  console.log(`🚀 [${new Date().toISOString()}] Webhook called`);
  console.log('📥 Method:', req.method);
  console.log('📦 Headers:', req.headers);

  // Check environment variables
  const missingVars = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) missingVars.push('TELEGRAM_BOT_TOKEN');
  if (!process.env.DIFY_API_URL) missingVars.push('DIFY_API_URL');
  if (!process.env.DIFY_API_TOKEN) missingVars.push('DIFY_API_TOKEN');
  
  if (missingVars.length > 0) {
    console.error('❌ Missing critical environment variables:', missingVars);
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
    console.log('📨 Received update type:', Object.keys(update).filter(key => key !== 'update_id'));
    console.log('📋 Update content preview:', JSON.stringify(update).substring(0, 500));
    
    // Handle business connection updates
    if (update.business_connection) {
      console.log('🔗 Business connection update received');
      return res.status(200).json({ status: 'business_connection_processed' });
    }

    // CRITICAL FIX: We MUST await handleMessage to ensure it completes
    // before the function terminates on Vercel
    if (update.business_message) {
      console.log('🏢 Processing business message...');
      await handleMessage(update.business_message, true);
      return res.status(200).json({ status: 'business_message_processed' });
    }

    if (update.message) {
      console.log('💬 Processing regular message...');
      await handleMessage(update.message, false);
      return res.status(200).json({ status: 'message_processed' });
    }

    // No relevant update type found
    console.log('ℹ️ No action needed for this update type');
    return res.status(200).json({ status: 'no_action_needed' });

  } catch (error) {
    console.error('💥 Webhook handler critical error:', error);
    console.error('Error stack:', error.stack);
    
    // Try to send error message to user if possible
    try {
      const update = req.body;
      const chatId = update.message?.chat?.id || update.business_message?.chat?.id;
      
      if (chatId) {
        await telegramApiCall('sendMessage', {
          chat_id: chatId,
          text: CONSTANTS.FALLBACK_MESSAGE
        });
      }
    } catch (fallbackError) {
      console.error('Failed to send error message to user:', fallbackError);
    }
    
    // Still return 200 to prevent Telegram from retrying
    // Telegram will keep retrying if we return 500
    return res.status(200).json({ 
      status: 'error_handled',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
