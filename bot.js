require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const ADMIN_ID = process.env.ADMIN_ID;
const TARGET_CHAT = process.env.TARGET_CHAT;

const groq = new Groq(process.env.GROQ_API_KEY);

const conversationHistory = new Map();
const chatMemory = new Map();

const MEMORY_CONFIG = {
  MAX_HISTORY_TOKENS: 32000,
  COMPACT_TO_TOKENS: 16000,
  COMPACT_THRESHOLD: 0.8,
  CHAT_MEMORY_LIMIT: 100
};

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

function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}

function calculateHistoryTokens(history) {
  return history.reduce((total, msg) => {
    return total + estimateTokens(msg.content);
  }, 0);
}

async function compactHistory(history) {
  if (history.length <= 3) return history;
  
  const systemMessage = history[0]?.role === 'system' ? history[0] : null;
  const recentMessages = history.slice(-3);
  const middleMessages = history.slice(systemMessage ? 1 : 0, -3);
  
  if (middleMessages.length === 0) return history;
  
  try {
    const conversationSummary = middleMessages.map(msg => 
      `${msg.role}: ${msg.content.substring(0, 200)}...`
    ).join('\n');
    
    const summaryPrompt = `Зсумуй цю частину розмови в 2-3 реченнях, зберігши ключові моменти:\n${conversationSummary}`;
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Ти помічник, який створює короткі та точні саммарі розмов.' },
        { role: 'user', content: summaryPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 200
    });
    
    const summary = chatCompletion.choices[0]?.message?.content || 'Попередня частина розмови.';
    
    const compactedHistory = [];
    if (systemMessage) compactedHistory.push(systemMessage);
    
    compactedHistory.push({
      role: 'assistant',
      content: `[Саммарі попередньої розмови: ${summary}]`,
      timestamp: Date.now(),
      isCompacted: true
    });
    
    compactedHistory.push(...recentMessages);
    
    console.log(`Історія скомпактована: ${history.length} → ${compactedHistory.length} повідомлень`);
    return compactedHistory;
    
  } catch (error) {
    console.error('Помилка компактування історії:', error);
    return history.slice(-10);
  }
}

async function addToHistory(chatId, userId, role, content) {
  const key = getConversationKey(chatId, userId);
  if (!conversationHistory.has(key)) {
    conversationHistory.set(key, []);
  }
  
  let history = conversationHistory.get(key);
  history.push({ role, content, timestamp: Date.now() });
  
  const totalTokens = calculateHistoryTokens(history);
  
  if (totalTokens > MEMORY_CONFIG.MAX_HISTORY_TOKENS * MEMORY_CONFIG.COMPACT_THRESHOLD) {
    console.log(`Перевищено ліміт токенів (${totalTokens}/${MEMORY_CONFIG.MAX_HISTORY_TOKENS}), компактуємо історію...`);
    history = await compactHistory(history);
  }
  
  if (history.length > 25) {
    history.splice(0, history.length - 25);
  }
  
  conversationHistory.set(key, history);
}

function getHistory(chatId, userId) {
  const key = getConversationKey(chatId, userId);
  return conversationHistory.get(key) || [];
}

function clearUserMemory(chatId, userId) {
  const key = getConversationKey(chatId, userId);
  const hadMemory = conversationHistory.has(key);
  conversationHistory.delete(key);
  console.log(`Пам'ять очищено для користувача ${userId} в чаті ${chatId} (ключ: ${key}). Була історія: ${hadMemory}`);
  return true;
}

async function addToChatMemory(chatId, content, author = 'unknown') {
  if (!chatMemory.has(chatId)) {
    chatMemory.set(chatId, []);
  }
  
  const memory = chatMemory.get(chatId);
  memory.push({
    content: content.substring(0, 200),
    author,
    timestamp: Date.now()
  });
  
  if (memory.length > MEMORY_CONFIG.CHAT_MEMORY_LIMIT) {
    memory.splice(0, memory.length - MEMORY_CONFIG.CHAT_MEMORY_LIMIT);
  }
  
  chatMemory.set(chatId, memory);
}

function getChatMemoryContext(chatId) {
  const memory = chatMemory.get(chatId) || [];
  if (memory.length === 0) return '';
  
  const recentMemory = memory.slice(-20).map(m => 
    `[${m.author}]: ${m.content}`
  ).join('\n');
  
  return `\n\nКонтекст чату:\n${recentMemory}`;
}

function formatMessageForTelegram(text) {
  if (!text) return text;
  
  try {
    // Спочатку перевіряємо чи є таблиці і обробляємо їх
    let formatted = formatTablesForTelegram(text);
    
    // Конвертуємо різні типи виділення в Telegram Markdown
    formatted = formatted
      // HTML теги
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/br>/gi, '\n')
      .replace(/<p>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
      .replace(/<b>(.*?)<\/b>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '_$1_')
      .replace(/<i>(.*?)<\/i>/gi, '_$1_')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>(.*?)<\/pre>/gis, '```$1```')
      .replace(/<u>(.*?)<\/u>/gi, '$1')
      .replace(/<s>(.*?)<\/s>/gi, '~$1~')
      .replace(/<strike>(.*?)<\/strike>/gi, '~$1~')
      .replace(/<del>(.*?)<\/del>/gi, '~$1~')
      .replace(/<h[1-6]>(.*?)<\/h[1-6]>/gi, '*$1*')
      .replace(/<ul>/gi, '')
      .replace(/<\/ul>/gi, '')
      .replace(/<ol>/gi, '')
      .replace(/<\/ol>/gi, '')
      .replace(/<li>(.*?)<\/li>/gi, '• $1\n')
      .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '🖼️ $1')
      .replace(/<hr\s*\/?>/gi, '─────────')
      .replace(/<div[^>]*>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<span[^>]*>/gi, '')
      .replace(/<\/span>/gi, '')
      // Видаляємо залишкові HTML теги
      .replace(/<[^>]*>/g, '')
      // Markdown форматування
      .replace(/\*\*(.*?)\*\*/g, '*$1*')
      .replace(/_(.*?)_/g, '_$1_')
      .replace(/`(.*?)`/g, '`$1`')
      .replace(/```([\s\S]*?)```/g, '```$1```')
      // Заголовки в жирний текст
      .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*')
      // Списки з емодзі для кращої читабельності
      .replace(/^\s*[-*+]\s+/gm, '• ')
      // Очищаємо зайві переноси рядків
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
    
    // Перевіряємо і виправляємо некоректні Markdown символи
    formatted = fixMarkdownEntities(formatted);
    
    return formatted;
  } catch (error) {
    console.error('Помилка форматування повідомлення:', error);
    // Повертаємо простий текст без форматування в разі помилки
    return text.replace(/<[^>]*>/g, '').replace(/[*_`]/g, '');
  }
}

function fixMarkdownEntities(text) {
  if (!text) return text;
  
  try {
    let fixed = text;
    
    // Видаляємо пусті Markdown теги
    fixed = fixed.replace(/\*\*/g, '').replace(/\*\s*\*/g, '');
    fixed = fixed.replace(/_{2,}/g, '').replace(/_\s*_/g, '');
    fixed = fixed.replace(/`{3,}/g, '```').replace(/`\s*`/g, '');
    fixed = fixed.replace(/~{2,}/g, '~').replace(/~\s*~/g, '');
    
    // Виправляємо непарні символи форматування
    const boldCount = (fixed.match(/\*/g) || []).length;
    const italicCount = (fixed.match(/_/g) || []).length;
    const codeCount = (fixed.match(/`/g) || []).length;
    const strikeCount = (fixed.match(/~/g) || []).length;
    
    // Видаляємо останній символ якщо він непарний
    if (boldCount % 2 !== 0) {
      const lastBold = fixed.lastIndexOf('*');
      if (lastBold !== -1) {
        fixed = fixed.substring(0, lastBold) + fixed.substring(lastBold + 1);
      }
    }
    
    if (italicCount % 2 !== 0) {
      const lastItalic = fixed.lastIndexOf('_');
      if (lastItalic !== -1) {
        fixed = fixed.substring(0, lastItalic) + fixed.substring(lastItalic + 1);
      }
    }
    
    if (codeCount % 2 !== 0 && !fixed.includes('```')) {
      const lastCode = fixed.lastIndexOf('`');
      if (lastCode !== -1) {
        fixed = fixed.substring(0, lastCode) + fixed.substring(lastCode + 1);
      }
    }
    
    if (strikeCount % 2 !== 0) {
      const lastStrike = fixed.lastIndexOf('~');
      if (lastStrike !== -1) {
        fixed = fixed.substring(0, lastStrike) + fixed.substring(lastStrike + 1);
      }
    }
    
    // Екрануємо спеціальні символи в URL
    fixed = fixed.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (match, text, url) => {
      const cleanUrl = url.replace(/[*_`~]/g, '');
      const cleanText = text.replace(/[*_`~]/g, '');
      return `[${cleanText}](${cleanUrl})`;
    });
    
    return fixed;
  } catch (error) {
    console.error('Помилка виправлення Markdown:', error);
    return text.replace(/[*_`~]/g, '');
  }
}

function formatTablesForTelegram(text) {
  // Пошук Markdown таблиць (з |)
  const markdownTableRegex = /(\|[^\n]*\|[\s]*\n)+/g;
  
  // Пошук даних схожих на таблиці (кілька рядків з розділювачами | або рядки з ключ-значення)
  const tableDataRegex = /(?:\|[^\n]*\|[\s]*\n){2,}|(?:^[^|\n]*\|[^|\n]*$[\s]*\n){2,}/gm;
  
  // Пошук списків з структурованими даними (ключ: значення)
  const structuredDataRegex = /(?:^[•\-\*]\s*[^:\n]+:\s*[^\n]+$[\s]*\n){3,}/gm;
  
  let formatted = text;
  
  // Обробляємо Markdown таблиці
  formatted = formatted.replace(markdownTableRegex, (match) => {
    return '```\n' + match.trim() + '\n```\n';
  });
  
  // Обробляємо дані схожі на таблиці
  formatted = formatted.replace(tableDataRegex, (match) => {
    if (!match.includes('```')) { // якщо не вже в коді
      return '```\n' + match.trim() + '\n```\n';
    }
    return match;
  });
  
  // Обробляємо структуровані списки (якщо є багато ключ:значення)
  formatted = formatted.replace(structuredDataRegex, (match) => {
    if (!match.includes('```')) { // якщо не вже в коді
      return '```\n' + match.trim() + '\n```\n';
    }
    return match;
  });
  
  return formatted;
}

async function searchWeb(query) {
  try {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $('.result').each((i, elem) => {
      if (i < 3) {
        const title = $(elem).find('.result__title a').text().trim();
        const snippet = $(elem).find('.result__snippet').text().trim();
        const url = $(elem).find('.result__title a').attr('href');
        
        if (title && snippet) {
          results.push({
            title,
            snippet,
            url
          });
        }
      }
    });
    
    return results;
  } catch (error) {
    console.error('Помилка веб-пошуку:', error);
    return [];
  }
}

async function getRepoInfo(repo) {
  try {
    const repoUrl = `https://api.github.com/repos/${repo}`;
    const response = await axios.get(repoUrl, {
      timeout: 10000,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OIS2025-Bot'
      }
    });
    
    return {
      name: response.data.name,
      description: response.data.description,
      language: response.data.language,
      stars: response.data.stargazers_count,
      forks: response.data.forks_count,
      size: response.data.size,
      topics: response.data.topics || [],
      license: response.data.license?.name,
      created_at: response.data.created_at,
      updated_at: response.data.updated_at
    };
  } catch (error) {
    console.error('Помилка отримання інформації про репозиторій:', error);
    return null;
  }
}

async function analyzeRepoStructure(repo) {
  try {
    const rootContents = await fetchFromGitHub(repo);
    if (!rootContents || rootContents.type !== 'directory') return null;
    
    const importantFiles = ['README.md', 'README.txt', 'package.json', 'requirements.txt', 'Cargo.toml', 'pom.xml', 'go.mod', 'setup.py'];
    const configFiles = ['.gitignore', 'Dockerfile', 'docker-compose.yml', '.github'];
    
    const structure = {
      files: rootContents.files,
      hasReadme: false,
      readmeContent: '',
      packageInfo: null,
      hasTests: false,
      hasDocs: false,
      hasCI: false,
      mainLanguage: null
    };
    
    for (const file of rootContents.files) {
      if (file.name.toLowerCase().includes('readme')) {
        structure.hasReadme = true;
        const readmeData = await fetchFromGitHub(repo, file.name);
        if (readmeData && readmeData.type === 'file') {
          structure.readmeContent = readmeData.content;
        }
      }
      
      if (file.name === 'package.json') {
        const packageData = await fetchFromGitHub(repo, file.name);
        if (packageData && packageData.type === 'file') {
          try {
            structure.packageInfo = JSON.parse(packageData.content);
          } catch (e) {}
        }
      }
      
      if (file.name.toLowerCase().includes('test') || file.name === '__tests__') {
        structure.hasTests = true;
      }
      
      if (file.name.toLowerCase().includes('doc') || file.name === 'docs') {
        structure.hasDocs = true;
      }
      
      if (file.name === '.github') {
        structure.hasCI = true;
      }
    }
    
    return structure;
  } catch (error) {
    console.error('Помилка аналізу структури репозиторія:', error);
    return null;
  }
}

async function fetchFromGitHub(repo, path = '') {
  try {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const response = await axios.get(apiUrl, {
      timeout: 10000,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OIS2025-Bot'
      }
    });
    
    if (response.data.type === 'file') {
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      return {
        type: 'file',
        name: response.data.name,
        content: content.length > 2000 ? content.substring(0, 2000) + '...' : content
      };
    } else if (response.data.length) {
      return {
        type: 'directory',
        files: response.data.map(item => ({
          name: item.name,
          type: item.type,
          size: item.size
        })).slice(0, 10)
      };
    }
    
    return null;
  } catch (error) {
    console.error('Помилка GitHub API:', error);
    return null;
  }
}

function formatRepoAnalysis(repoInfo, structure) {
  let analysis = '';
  
  if (repoInfo) {
    analysis += `📦 **${repoInfo.name}**\n`;
    if (repoInfo.description) analysis += `📝 ${repoInfo.description}\n`;
    analysis += `🌟 ${repoInfo.stars} зірок | 🍴 ${repoInfo.forks} форків\n`;
    if (repoInfo.language) analysis += `💻 Основна мова: ${repoInfo.language}\n`;
    if (repoInfo.license) analysis += `📜 Ліцензія: ${repoInfo.license}\n`;
    if (repoInfo.topics && repoInfo.topics.length > 0) {
      analysis += `🏷️ Теги: ${repoInfo.topics.join(', ')}\n`;
    }
    analysis += '\n';
  }
  
  if (structure) {
    analysis += '📁 **Структура проекту:**\n';
    
    if (structure.hasReadme) {
      analysis += '✅ README присутній\n';
    } else {
      analysis += '❌ README відсутній\n';
    }
    
    if (structure.packageInfo) {
      analysis += `✅ package.json: ${structure.packageInfo.name}\n`;
      if (structure.packageInfo.scripts) {
        const scripts = Object.keys(structure.packageInfo.scripts).slice(0, 3);
        analysis += `🔧 Скрипти: ${scripts.join(', ')}\n`;
      }
    }
    
    analysis += `${structure.hasTests ? '✅' : '❌'} Тести\n`;
    analysis += `${structure.hasDocs ? '✅' : '❌'} Документація\n`;
    analysis += `${structure.hasCI ? '✅' : '❌'} CI/CD\n\n`;
    
    if (structure.readmeContent) {
      analysis += '📖 **Опис з README:**\n';
      const summary = structure.readmeContent.substring(0, 500);
      analysis += summary + (structure.readmeContent.length > 500 ? '...' : '') + '\n\n';
    }
    
    analysis += '📋 **Рекомендації:**\n';
    const recommendations = [];
    
    if (!structure.hasReadme) recommendations.push('• Додати README.md з описом проекту');
    if (!structure.hasTests) recommendations.push('• Додати тести для покращення якості коду');
    if (!structure.hasDocs) recommendations.push('• Створити документацію');
    if (!structure.hasCI) recommendations.push('• Налаштувати GitHub Actions для автоматизації');
    
    if (recommendations.length === 0) {
      recommendations.push('• Проект має гарну структуру! Продовжуйте в тому ж дусі');
    }
    
    analysis += recommendations.join('\n');
  }
  
  return analysis;
}

async function fetchWebPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    $('script, style, nav, footer, aside').remove();
    
    const title = $('title').text().trim() || 'Без назви';
    const content = $('body').text()
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1500);
    
    return {
      title,
      content,
      url
    };
  } catch (error) {
    console.error('Помилка завантаження сторінки:', error);
    return null;
  }
}

async function getGroqResponse(userMessage, chatId, userId) {
  try {
    let additionalContext = '';
    
    const githubRegex = /github\.com\/([^\/]+\/[^\/\s]+)(?:\/blob\/[^\/]+)?(?:\/(.+))?/;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const searchRegex = /(?:пошукай|знайди|search|найди|шукай)\s+(.+)/i;
    
    if (githubRegex.test(userMessage)) {
      const match = userMessage.match(githubRegex);
      const repo = match[1];
      const path = match[2] || '';
      
      if (path) {
        const githubData = await fetchFromGitHub(repo, path);
        if (githubData) {
          if (githubData.type === 'file') {
            additionalContext = `\n\nВміст файлу ${githubData.name} з GitHub:\n${githubData.content}`;
          } else if (githubData.type === 'directory') {
            additionalContext = `\n\nВміст директорії з GitHub:\n${githubData.files.map(f => `- ${f.name} (${f.type})`).join('\n')}`;
          }
        }
      } else {
        const [repoInfo, structure] = await Promise.all([
          getRepoInfo(repo),
          analyzeRepoStructure(repo)
        ]);
        
        if (repoInfo || structure) {
          const analysis = formatRepoAnalysis(repoInfo, structure);
          additionalContext = `\n\nАналіз GitHub репозиторія:\n${analysis}`;
        }
      }
    }
    
    else if (urlRegex.test(userMessage)) {
      const urls = userMessage.match(urlRegex);
      if (urls && urls.length > 0) {
        const pageData = await fetchWebPage(urls[0]);
        if (pageData) {
          additionalContext = `\n\nВміст веб-сторінки "${pageData.title}":\n${pageData.content}`;
        }
      }
    }
    
    else if (searchRegex.test(userMessage)) {
      const searchMatch = userMessage.match(searchRegex);
      if (searchMatch && searchMatch[1]) {
        const searchResults = await searchWeb(searchMatch[1]);
        if (searchResults.length > 0) {
          additionalContext = '\n\nРезультати пошуку:\n' + 
            searchResults.map((result, i) => 
              `${i + 1}. ${result.title}\n${result.snippet}\n${result.url}\n`
            ).join('\n');
        }
      }
    }
    
    const systemPrompt = readSystemPrompt();
    const history = getHistory(chatId, userId);
    const chatContext = getChatMemoryContext(chatId);
    
    const messages = [
      { role: 'system', content: systemPrompt + chatContext }
    ];
    
    history.forEach(msg => {
      if (msg.role && msg.content) {
        messages.push({ role: msg.role, content: msg.content });
      }
    });
    
    const fullMessage = userMessage + additionalContext;
    messages.push({ role: 'user', content: fullMessage });
    
    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.6,
      max_tokens: 2048,
    });
    
    let response = chatCompletion.choices[0]?.message?.content || 'Вибачте, не можу відповісти на ваше питання.';
    
    // Стилізація повідомлень для Telegram
    response = formatMessageForTelegram(response);
    
    await addToHistory(chatId, userId, 'user', userMessage);
    await addToHistory(chatId, userId, 'assistant', response);
    
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
  // Перевіряємо команду очищення пам'яті
  if (msg.text === '/clear_memory') {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
      clearUserMemory(chatId, userId);
      bot.sendMessage(chatId, '*Пам\'ять очищено!* 🧹\n\nВаша історія розмови була видалена. Тепер я почну нову розмову з чистого аркуша.', 
        { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Помилка очищення пам\'яті:', error);
      bot.sendMessage(chatId, 'Виникла помилка при очищенні пам\'яті. Спробуйте пізніше.');
    }
    return;
  }
  
  // Додаємо всі повідомлення до пам'яті чату
  if (msg.text && msg.from) {
    const authorName = msg.from.first_name || msg.from.username || 'user';
    await addToChatMemory(msg.chat.id, msg.text, authorName);
  }
  
  // Перевіряємо чи це згадка бота (@ois2025_bot)
  if (msg.text && msg.text.includes('@ois2025_bot')) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Видаляємо згадку бота з тексту
    const userPrompt = msg.text.replace(/@ois2025_bot\s*/g, '').trim();
    
    if (userPrompt) {
      const response = await getGroqResponse(userPrompt, chatId, userId);
      await addToChatMemory(chatId, response, 'bot');
      
      // Спробуємо відправити з Markdown, якщо не вийде - без форматування
      try {
        await bot.sendMessage(chatId, response, {
          reply_to_message_id: msg.message_id,
          parse_mode: 'Markdown'
        });
      } catch (markdownError) {
        console.error('Помилка Markdown, відправляємо без форматування:', markdownError.message);
        const plainText = response.replace(/[*_`~]/g, '').replace(/```[\s\S]*?```/g, '');
        await bot.sendMessage(chatId, plainText, {
          reply_to_message_id: msg.message_id
        });
      }
    }
    return;
  }
  
  if (msg.reply_to_message && msg.reply_to_message.from.is_bot) {
    const originalText = msg.reply_to_message.text;
    const replyText = msg.text;
    const chatId = msg.chat.id;
    
    if (originalText === 'Бот' && replyText === 'Не бот') {
      bot.sendMessage(chatId, 'Це так не працює', {reply_to_message_id: msg.message_id});
    } else {
      const response = await getGroqResponse(replyText, chatId, msg.from.id);
      await addToChatMemory(chatId, response, 'bot');
      
      // Спробуємо відправити з Markdown, якщо не вийде - без форматування
      try {
        await bot.sendMessage(chatId, response, {
          reply_to_message_id: msg.message_id,
          parse_mode: 'Markdown'
        });
      } catch (markdownError) {
        console.error('Помилка Markdown, відправляємо без форматування:', markdownError.message);
        // Видаляємо всі Markdown символи і відправляємо як простий текст
        const plainText = response.replace(/[*_`~]/g, '').replace(/```[\s\S]*?```/g, '');
        await bot.sendMessage(chatId, plainText, {
          reply_to_message_id: msg.message_id
        });
      }
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


bot.onText(/\/broadcast ([\s\S]+)/, (msg, match) => {
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