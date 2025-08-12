require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const ADMIN_ID = process.env.ADMIN_ID;
const TARGET_CHAT = process.env.TARGET_CHAT;

const groq = new Groq(process.env.GROQ_API_KEY);

const conversationHistory = new Map();

function readMessageFile(fileName) {
  try {
    const filePath = path.join(__dirname, 'messages', fileName);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Помилка читання файлу ${fileName}:`, error);
    return 'Помилка завантаження повідомлення';
  }
}

function readSystemPrompt() {
  try {
    const filePath = path.join(__dirname, 'system_prompt.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error('Помилка читання системного промпту:', error);
    return 'Ти корисний помічник-бот для студентів ОІС 2025.';
  }
}

function getConversationKey(chatId, userId) {
  return `${chatId}_${userId}`;
}

function addToHistory(chatId, userId, role, content) {
  const key = getConversationKey(chatId, userId);
  if (!conversationHistory.has(key)) {
    conversationHistory.set(key, []);
  }
  
  const history = conversationHistory.get(key);
  history.push({ role, content, timestamp: Date.now() });
  
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  
  conversationHistory.set(key, history);
}

function getHistory(chatId, userId) {
  const key = getConversationKey(chatId, userId);
  return conversationHistory.get(key) || [];
}

async function getGroqResponse(userMessage, chatId, userId) {
  try {
    const systemPrompt = readSystemPrompt();
    const history = getHistory(chatId, userId);
    
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    history.forEach(msg => {
      if (msg.role && msg.content) {
        messages.push({ role: msg.role, content: msg.content });
      }
    });
    
    messages.push({ role: 'user', content: userMessage });
    
    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: 'llama3-8b-8192',
      temperature: 0.7,
      max_tokens: 1000
    });
    
    const response = chatCompletion.choices[0]?.message?.content || 'Вибачте, не можу відповісти на ваше питання.';
    
    addToHistory(chatId, userId, 'user', userMessage);
    addToHistory(chatId, userId, 'assistant', response);
    
    return response;
  } catch (error) {
    console.error('Помилка Groq API:', error);
    return 'Вибачте, виникла помилка при обробці вашого повідомлення.';
  }
}

const menuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📋 Комісія', callback_data: 'commission' },
        { text: '📅 Дати', callback_data: 'dates' }
      ],
      [
        { text: '📚 Предмети', callback_data: 'subjects' },
        { text: '🕐 Розклад', callback_data: 'schedule' }
      ],
      [
        { text: '💰 Стипендія', callback_data: 'studentship' },
        { text: '📊 Оцінювання', callback_data: 'rating' }
      ]
    ]
  }
};

bot.on('new_chat_members', (msg) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  bot.sendMessage(chatId, 'Бот', {reply_to_message_id: messageId});
});

bot.on('message', async (msg) => {
  if (msg.reply_to_message && msg.reply_to_message.from.is_bot) {
    const originalText = msg.reply_to_message.text;
    const replyText = msg.text;
    const chatId = msg.chat.id;
    
    if (originalText === 'Бот' && replyText) {
      bot.sendMessage(chatId, 'Сам бот', {reply_to_message_id: msg.message_id});
    } else if ((originalText === 'Сам бот' || originalText === 'Бот') && replyText === 'Не бот') {
      bot.sendMessage(chatId, 'Це так не працює', {reply_to_message_id: msg.message_id});
    } else {
      const response = await getGroqResponse(replyText, chatId, msg.from.id);
      bot.sendMessage(chatId, response, {reply_to_message_id: msg.message_id});
    }
  }
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Більше корисної інформації тут: https://t.me/EhPhBekPivEwN2Uy \nОберіть розділ:', menuKeyboard);
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Вітаю! Використовуйте /menu для відкриття головного меню.');
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_ID) {
    bot.sendMessage(chatId, 'У вас немає дозволу на використання цієї команди.');
    return;
  }
  
  const message = match[1];
  
  bot.sendMessage(TARGET_CHAT, message)
    .then(() => {
      bot.sendMessage(chatId, 'Повідомлення надіслано в канал OIS_2025 ✅');
    })
    .catch((error) => {
      console.error('Помилка надсилання в канал:', error);
      bot.sendMessage(chatId, 'Помилка надсилання повідомлення ❌');
    });
});

bot.on('callback_query', (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message.chat.id;

  if (data === 'back_to_menu') {
    bot.editMessageText('Оберіть розділ:', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: menuKeyboard.reply_markup
    });
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  let messageContent = '';
  let fileName = '';

  switch (data) {
    case 'commission':
      fileName = 'commission.txt';
      break;
    case 'dates':
      fileName = 'dates.txt';
      break;
    case 'subjects':
      fileName = 'subjects.txt';
      break;
    case 'schedule':
      fileName = 'schedule.txt';
      break;
    case 'studentship':
      fileName = 'studentship.txt';
      break;
    case 'rating':
      fileName = 'rating.txt';
      break;
    default:
      bot.answerCallbackQuery(callbackQuery.id, 'Невідома команда');
      return;
  }

  messageContent = readMessageFile(fileName);
  
  bot.editMessageText(messageContent, {
    chat_id: chatId,
    message_id: message.message_id,
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Назад до меню', callback_data: 'back_to_menu' }]]
    }
  });

  bot.answerCallbackQuery(callbackQuery.id);
});

console.log('Бот запущено і очікує на повідомлення...');