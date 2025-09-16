// Simple Telegram Bot - No Timeout Issues
// Sends immediate acknowledgment, processes in background
// File: api/webhook.js

const sessions = new Map();

// Get session
function getSession(userId) {
  const key = userId?.toString();
  if (!key) return { conversationId: '' };
  
  if (!sessions.has(key)) {
    sessions.set(key, { conversationId: '' });
  }
  
  return sessions.get(key);
}

// Update session  
function updateSession(userId, conversationId) {
  if (!userId || !conversationId) return;
  sessions.set(userId.toString(), { conversationId });
}

// Parse Dify response
function parseDifyResponse(answer = '') {
  const urlRegex = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?)/gi;
  const imageUrls = answer.match(urlRegex) || [];
  
  let text = answer;
  imageUrls.forEach(url => {
    text = text.replace(url, '');
  });
  
  text = text.replace(/\s+/g, ' ').trim() || "✨ İşte senin için hazırladıklarım!";
  
  return { text, images: imageUrls };
}

// Main handler
export default async function handler(req, res) {
  console.log('[WEBHOOK] Called at', new Date().toISOString());
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;

  if (!BOT_TOKEN || !DIFY_API_URL || !DIFY_API_TOKEN) {
    console.error('[ERROR] Missing environment variables');
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;
    
    // Extract message
    const message = update.message || update.business_message;
    const businessConnectionId = update.business_message?.business_connection_id;
    
    if (!message?.text || (message.chat.type !== 'private' && !businessConnectionId)) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const userId = message.from.id;
    const userName = message.from.first_name || 'User';
    const userText = message.text;

    console.log(`[MESSAGE] From ${userName}: ${userText.substring(0, 50)}`);

    // Send immediate acknowledgment with typing
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: 'typing',
        ...(businessConnectionId && { business_connection_id: businessConnectionId })
      })
    });

    // Send "thinking" message
    const thinkingResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: "💭 Düşünüyorum...",
        reply_to_message_id: businessConnectionId ? undefined : messageId,
        ...(businessConnectionId && { business_connection_id: businessConnectionId })
      })
    });

    const thinkingResult = await thinkingResponse.json();
    const thinkingMessageId = thinkingResult.result?.message_id;

    // Return immediately to prevent timeout
    res.status(200).json({ ok: true });

    // Continue processing in background
    try {
      // Get session
      const session = getSession(userId);
      
      // Call Dify with shorter timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout
      
      const difyResponse = await fetch(`${DIFY_API_URL}/chat-messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DIFY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: {},
          query: userText.substring(0, 500), // Limit for faster response
          response_mode: 'blocking',
          user: userName,
          conversation_id: session.conversationId || '',
          files: []
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      let answer = "💬 Merhaba! Seninle sohbet etmek istiyorum!";
      let conversationId = session.conversationId;

      if (difyResponse.ok) {
        const data = await difyResponse.json();
        answer = data.answer || answer;
        conversationId = data.conversation_id || conversationId;
        updateSession(userId, conversationId);
      }

      // Delete thinking message
      if (thinkingMessageId) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: thinkingMessageId
          })
        }).catch(() => {}); // Ignore delete errors
      }

      // Parse response
      const { text, images } = parseDifyResponse(answer);

      // Send final response
      let endpoint = 'sendMessage';
      let params = {
        chat_id: chatId,
        reply_to_message_id: businessConnectionId ? undefined : messageId,
        ...(businessConnectionId && { business_connection_id: businessConnectionId })
      };

      if (images.length === 0) {
        // Text only
        params.text = text;
        params.parse_mode = 'HTML';
      } else if (images.length === 1) {
        // Single photo
        endpoint = 'sendPhoto';
        params.photo = images[0];
        params.caption = text.substring(0, 1024);
        params.parse_mode = 'HTML';
      } else {
        // Media group
        endpoint = 'sendMediaGroup';
        params.media = images.slice(0, 10).map((url, index) => ({
          type: 'photo',
          media: url,
          caption: index === 0 ? text.substring(0, 1024) : undefined,
          parse_mode: index === 0 ? 'HTML' : undefined
        }));
      }

      const finalResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      const finalResult = await finalResponse.json();
      if (!finalResult.ok) {
        console.error('[ERROR] Send failed:', finalResult.description);
      } else {
        console.log('[SUCCESS] Message sent!');
      }

    } catch (error) {
      console.error('[ERROR] Background processing:', error.message);
      
      // Try to send error message
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "😔 Bir sorun oluştu. Lütfen tekrar dene.",
          reply_to_message_id: businessConnectionId ? undefined : messageId,
          ...(businessConnectionId && { business_connection_id: businessConnectionId })
        })
      }).catch(() => {});
    }

  } catch (error) {
    console.error('[ERROR] Main handler:', error.message);
    return res.status(200).json({ ok: true });
  }
}
