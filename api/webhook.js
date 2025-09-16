// Real Queue System - No initial message
// File: api/webhook.js

// Global queue that persists between function calls in the same instance
// Note: This will reset on new deployments or cold starts
global.messageQueue = global.messageQueue || [];
global.processing = global.processing || new Set();

export default async function handler(req, res) {
  console.log('[WEBHOOK] Called at', new Date().toISOString());
  
  // Handle queue processing endpoint
  if (req.query?.action === 'process') {
    return processQueue(req, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const update = req.body;
    const message = update.message || update.business_message;
    const businessConnectionId = update.business_message?.business_connection_id;
    
    if (!message?.text) {
      return res.status(200).json({ ok: true });
    }
    
    if (!businessConnectionId && message.chat?.type !== 'private') {
      return res.status(200).json({ ok: true });
    }

    const queueItem = {
      id: `${message.from.id}_${message.message_id}_${Date.now()}`,
      chatId: message.chat.id,
      messageId: message.message_id,
      userId: message.from.id,
      userName: message.from.first_name || 'User',
      text: message.text,
      businessConnectionId: businessConnectionId,
      timestamp: Date.now(),
      retries: 0
    };

    console.log('[QUEUE] Adding item:', queueItem.id);
    
    // Add to queue
    global.messageQueue.push(queueItem);
    
    // Keep only last 100 messages
    if (global.messageQueue.length > 100) {
      global.messageQueue = global.messageQueue.slice(-100);
    }
    
    // Send typing indicator
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        action: 'typing',
        ...(businessConnectionId && { business_connection_id: businessConnectionId })
      })
    }).catch(err => console.error('[TYPING] Failed:', err.message));
    
    // Trigger processing (fire and forget)
    fetch(`${process.env.VERCEL_URL || 'https://eylulyilmaz.vercel.app'}/api/webhook?action=process`, {
      method: 'GET',
      headers: { 'x-secret': process.env.INTERNAL_SECRET || 'default-secret' }
    }).catch(() => {}); // Don't wait, don't care if it fails
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('[ERROR]:', error.message);
    return res.status(200).json({ ok: true });
  }
}

// Process queue function
async function processQueue(req, res) {
  console.log('[PROCESSOR] Starting, queue size:', global.messageQueue.length);
  
  // Simple auth check
  const secret = req.headers['x-secret'];
  if (secret !== (process.env.INTERNAL_SECRET || 'default-secret')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;
  
  if (!BOT_TOKEN || !DIFY_API_URL || !DIFY_API_TOKEN) {
    return res.status(500).json({ error: 'Missing configuration' });
  }
  
  let processed = 0;
  const maxProcess = 5; // Process max 5 items per run
  
  while (global.messageQueue.length > 0 && processed < maxProcess) {
    const item = global.messageQueue.shift();
    
    if (!item) break;
    
    // Skip if already processing
    if (global.processing.has(item.id)) {
      global.messageQueue.push(item); // Put it back
      continue;
    }
    
    // Skip old messages (older than 5 minutes)
    if (Date.now() - item.timestamp > 300000) {
      console.log('[PROCESSOR] Skipping old item:', item.id);
      continue;
    }
    
    global.processing.add(item.id);
    processed++;
    
    // Process item (don't await - parallel processing)
    processItem(item).finally(() => {
      global.processing.delete(item.id);
    });
  }
  
  console.log('[PROCESSOR] Processed:', processed, 'Remaining:', global.messageQueue.length);
  
  // If there are more items, trigger another processing run
  if (global.messageQueue.length > 0) {
    setTimeout(() => {
      fetch(`${process.env.VERCEL_URL || 'https://eylulyilmaz.vercel.app'}/api/webhook?action=process`, {
        method: 'GET',
        headers: { 'x-secret': process.env.INTERNAL_SECRET || 'default-secret' }
      }).catch(() => {});
    }, 1000); // Wait 1 second before next batch
  }
  
  return res.status(200).json({ 
    processed, 
    remaining: global.messageQueue.length 
  });
}

// Process single item
async function processItem(item) {
  console.log('[PROCESS] Starting:', item.id);
  const startTime = Date.now();
  
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const DIFY_API_URL = process.env.DIFY_API_URL;
  const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;
  
  try {
    // Keep sending typing indicator
    const typingInterval = setInterval(() => {
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: item.chatId,
          action: 'typing',
          ...(item.businessConnectionId && { business_connection_id: item.businessConnectionId })
        })
      }).catch(() => {});
    }, 5000);
    
    // Call Dify
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 50000); // 50 second timeout
    
    const difyResponse = await fetch(`${DIFY_API_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {},
        query: item.text,
        response_mode: 'blocking',
        user: item.userName,
        conversation_id: '', // You can add session management here
        files: []
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    clearInterval(typingInterval);
    
    let answer = "💬 Merhaba! Tekrar dener misin?";
    
    if (difyResponse.ok) {
      const data = await difyResponse.json();
      answer = data.answer || answer;
    }
    
    // Parse response for images
    const urlRegex = /(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?)/gi;
    const imageUrls = answer.match(urlRegex) || [];
    let text = answer;
    imageUrls.forEach(url => {
      text = text.replace(url, '');
    });
    text = text.replace(/\s+/g, ' ').trim() || "✨ İşte senin için!";
    
    // Send response
    let endpoint = 'sendMessage';
    let params = {
      chat_id: item.chatId,
      ...(item.businessConnectionId && { business_connection_id: item.businessConnectionId }),
      ...(!item.businessConnectionId && { reply_to_message_id: item.messageId })
    };
    
    if (imageUrls.length === 0) {
      params.text = text;
    } else if (imageUrls.length === 1) {
      endpoint = 'sendPhoto';
      params.photo = imageUrls[0];
      params.caption = text.substring(0, 1024);
    } else {
      endpoint = 'sendMediaGroup';
      params.media = imageUrls.slice(0, 10).map((url, index) => ({
        type: 'photo',
        media: url,
        caption: index === 0 ? text.substring(0, 1024) : undefined
      }));
    }
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    
    const result = await response.json();
    if (result.ok) {
      console.log(`[PROCESS] Success for ${item.id} in ${Date.now() - startTime}ms`);
    } else {
      throw new Error(result.description || 'Failed to send message');
    }
    
  } catch (error) {
    console.error(`[PROCESS] Failed ${item.id}:`, error.message);
    
    // Retry logic
    if (item.retries < 2 && error.name !== 'AbortError') {
      item.retries++;
      console.log(`[PROCESS] Retrying ${item.id}, attempt ${item.retries}`);
      global.messageQueue.push(item);
    } else {
      // Send error message
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: item.chatId,
            text: "😔 Üzgünüm, bir sorun oluştu. Lütfen tekrar dene.",
            ...(item.businessConnectionId && { business_connection_id: item.businessConnectionId }),
            ...(!item.businessConnectionId && { reply_to_message_id: item.messageId })
          })
        });
      } catch (err) {
        console.error('[PROCESS] Failed to send error message:', err.message);
      }
    }
  }
}

// Export for Vercel
export const config = {
  maxDuration: 60, // Allow 60 seconds for processing
};
