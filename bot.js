require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const ADMIN_ID = process.env.ADMIN_ID;
const TARGET_CHAT = process.env.TARGET_CHAT;

function readMessageFile(fileName) {
  try {
    const filePath = path.join(__dirname, 'messages', fileName);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Помилка читання файлу ${fileName}:`, error);
    return 'Помилка завантаження повідомлення';
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
  const newMembers = msg.new_chat_members;
  
  const welcomeMessage = `🎓 Вітаю в чаті OIS 2025! 

Я бот-помічник, який допоможе вам зорієнтуватися в навчанні. 

📋 Доступні команди:
/menu - відкрити головне меню з інформацією
/start - почати роботу з ботом

💡 Через меню ви можете дізнатися про:
• Комісії та оцінювання
• Важливі дати
• Предмети та розклад  
• Стипендії та їх види
• Систему оцінювання

Бажаю успіхів у навчанні! 📚✨`;

  bot.sendMessage(chatId, welcomeMessage, {reply_to_message_id: messageId});
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const menuMessage = `📚 Головне меню OIS 2025

Оберіть розділ для отримання детальної інформації:`;
  
  bot.sendMessage(chatId, menuMessage, menuKeyboard);
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const startMessage = `🎓 Вітаю! Я бот-помічник для студентів OIS 2025.

Я можу допомогти вам з інформацією про:
📋 Комісії та систему оцінювання
📅 Важливі дати семестру
📚 Предмети першого курсу
🕐 Розклад занять
💰 Стипендії та їх види
📊 Систему рейтингового оцінювання

Використовуйте /menu для відкриття головного меню з детальною інформацією.

Удачі в навчанні! ✨`;
  
  bot.sendMessage(chatId, startMessage);
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
    const menuMessage = `📚 Головне меню OIS 2025

Оберіть розділ для отримання детальної інформації:`;
    
    bot.editMessageText(menuMessage, {
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