require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const fsNative = require('fs');
const fs = require('fs').promises;
const path = require('path');

// Установка timezone для Германии
process.env.TZ = 'Europe/Berlin';

// ===== Google Drive backup/restore (Render Free friendly) =====
function isAdmin(chatId) {
  const raw = process.env.ADMIN_CHAT_IDS;
  if (!raw) return true; // если не задано — не ограничиваем
  const set = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  return set.has(String(chatId));
}

async function createDriveClient() {
  const keyFile = process.env.GDRIVE_KEYFILE; // /etc/secrets/xxx.json
  if (!keyFile) throw new Error('GDRIVE_KEYFILE не задан');

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  return google.drive({ version: 'v3', auth });
}

async function driveUploadById(drive, fileId, localPath) {
  await drive.files.update({
    fileId,
    media: {
      mimeType: 'application/json',
      body: fsNative.createReadStream(localPath)
    }
  });
}

async function driveDownloadById(drive, fileId, localPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    const dest = fsNative.createWriteStream(localPath);
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });
}

async function backupToDrive() {
  const drive = await createDriveClient();

  const dbId = process.env.GDRIVE_DATABASE_ID;
  const usersId = process.env.GDRIVE_USERS_ID;
  const stationsId = process.env.GDRIVE_STATIONS_ID;

  if (!dbId || !usersId || !stationsId) {
    throw new Error('Нужны GDRIVE_DATABASE_ID, GDRIVE_USERS_ID, GDRIVE_STATIONS_ID');
  }

  await driveUploadById(drive, dbId, DATABASE_FILE);
  await driveUploadById(drive, usersId, USERS_FILE);
  await driveUploadById(drive, stationsId, STATIONS_FILE);
}

async function restoreFromDrive() {
  const drive = await createDriveClient();

  const dbId = process.env.GDRIVE_DATABASE_ID;
  const usersId = process.env.GDRIVE_USERS_ID;
  const stationsId = process.env.GDRIVE_STATIONS_ID;

  if (!dbId || !usersId || !stationsId) {
    throw new Error('Нужны GDRIVE_DATABASE_ID, GDRIVE_USERS_ID, GDRIVE_STATIONS_ID');
  }

  await driveDownloadById(drive, dbId, DATABASE_FILE);
  await driveDownloadById(drive, usersId, USERS_FILE);
  await driveDownloadById(drive, stationsId, STATIONS_FILE);
}
// ===== /Google Drive =====

// Инициализация бота
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Пути к файлам
const STATIONS_FILE = path.join(__dirname, 'stations.json');
const DATABASE_FILE = path.join(__dirname, 'database.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Загрузка данных
async function loadJSON(filepath, defaultValue = []) {
  try {
    const data = await fs.readFile(filepath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return defaultValue;
  }
}

// Сохранение данных
async function saveJSON(filepath, data) {
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// Парсер цен с clever-tanken.de
async function fetchStationPrices(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
      },
      timeout: 15000
    });

    
const $ = cheerio.load(response.data);

    // clever-tanken: последняя цифра цены часто в <sup id="suffix-price-N">9</sup>
    // Сохраняем суффиксы в мапу по N, т.к. <sup> может быть НЕ внутри .price-field
    const suffixMap = {};
    $('sup[id^="suffix-price-"]').each((i, el) => {
      const id = $(el).attr('id') || '';
      const mm = id.match(/suffix-price-(\d+)/);
      if (!mm) return;
      const key = mm[1];
      const val = (($(el).text() || '').trim()).replace(/[^\d]/g, '');
      if (val) suffixMap[key] = val;
    });
    
    // Извлекаем ID станции из URL
    const stationId = url.match(/\/(\d+)$/)?.[1];
    
    // Ищем название станции
    const stationName = $('h1').first().text().trim() || 
                       $('.station-name').first().text().trim() ||
                       $('[class*="station"]').first().text().trim() ||
                       `Station ${stationId}`;

    // Парсим цены
    const prices = {
      e5: null,
      e10: null,
      diesel: null
    };

    // Склеиваем current-price + suffix-price (пример: 1.77 + 9 => 1.779)
    function fullPrice(baseRaw, suffixRaw) {
      const base = String(baseRaw || '').replace(',', '.').replace(/[^\d.]/g, '').trim();
      if (!base) return null;

      const m = base.match(/^(\d{1,2})\.(\d{2,3})$/);
      if (!m) {
        const n = Number(base);
        return Number.isFinite(n) ? n : null;
      }

      // если уже 3 знака после точки — суффикс не нужен
      if (m[2].length === 3) {
        const n = Number(base);
        return Number.isFinite(n) ? n : null;
      }

      const suf = String(suffixRaw || '').replace(/[^\d]/g, '').trim();
      const text = suf ? `${m[1]}.${m[2]}${suf}` : base;
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }

    console.log(`\n🔍 Парсинг станции ${stationId} - ${stationName}`);

    // ОСНОВНОЙ МЕТОД: Ищем div.price-field с вложенными span#current-price-X
    $('.price-field').each((i, priceField) => {
      const fieldHtml = $(priceField).html();
      const fieldText = $(priceField).text().toLowerCase();
      
      // Извлекаем цену из span#current-price-N и suffix из sup#suffix-price-N
      const priceSpan = $(priceField).find('span[id^="current-price-"]').first();
      const priceId = priceSpan.attr('id') || '';
      const idMatch = priceId.match(/current-price-(\d+)/);
      const num = idMatch ? idMatch[1] : null;

      let priceText = priceSpan.text().trim();
      let suffixText = '';
      if (num) {
        suffixText = $(`#suffix-price-${num}`).first().text().trim();
      }
      
      // Если цена не в span, ищем прямо в тексте
      if (!priceText) {
        const match = fieldHtml.match(/>(\d{1,2}[.,]\d{2,3})</);
        if (match) priceText = match[1];
      }
      
      if (priceText) {
        const price = fullPrice(priceText, suffixText);
        
        if (!isNaN(price) && price > 0 && price < 3) {
          // Определяем тип топлива по тексту в родительских элементах
          const parentText = $(priceField).parent().text().toLowerCase();
          const allText = fieldText + ' ' + parentText;
          
          if (!prices.diesel && (allText.includes('diesel') || allText.includes('дизель'))) {
            prices.diesel = price;
            console.log(`  ✓ Diesel: ${price}€ (найдено в price-field)`);
          } else if (!prices.e5 && (allText.includes('super e5') || allText.includes('e 5') || allText.includes('super 95'))) {
            prices.e5 = price;
            console.log(`  ✓ E5: ${price}€ (найдено в price-field)`);
          } else if (!prices.e10 && (allText.includes('super e10') || allText.includes('e 10'))) {
            prices.e10 = price;
            console.log(`  ✓ E10: ${price}€ (найдено в price-field)`);
          }
        }
      }
    });

    // ДОПОЛНИТЕЛЬНЫЙ МЕТОД: Если не нашли через price-field, ищем по всей странице
    if (!prices.diesel || !prices.e5 || !prices.e10) {
      console.log('  → Пробую дополнительный поиск...');
      
      // Ищем только current-price-* и доклеиваем suffix-price-* (суффикс по одиночке НЕ парсим)
      $('span[id^="current-price-"]').each((i, span) => {
        const baseText = $(span).text().trim();
        const id = $(span).attr('id') || '';
        const m = id.match(/current-price-(\d+)/);
        const num = m ? m[1] : null;
        const suffixText = num ? $(`#suffix-price-${num}`).first().text().trim() : '';
        const price = fullPrice(baseText, suffixText);
        
        if (!isNaN(price) && price > 0 && price < 3) {
          // Ищем label/текст рядом со span
          const parent = $(span).closest('div, tr, li');
          const labelText = parent.text().toLowerCase();
          
          if (!prices.diesel && labelText.includes('diesel')) {
            prices.diesel = price;
            console.log(`  ✓ Diesel: ${price}€ (дополнительный метод)`);
          } else if (!prices.e5 && (labelText.includes('super e5') || labelText.includes('e 5'))) {
            prices.e5 = price;
            console.log(`  ✓ E5: ${price}€ (дополнительный метод)`);
          } else if (!prices.e10 && (labelText.includes('super e10') || labelText.includes('e 10'))) {
            prices.e10 = price;
            console.log(`  ✓ E10: ${price}€ (дополнительный метод)`);
          }
        }
      });
    }

    // РЕЗЕРВНЫЙ МЕТОД: Regex по всему тексту страницы
    if (!prices.diesel || !prices.e5 || !prices.e10) {
      console.log('  → Пробую regex поиск...');
      const pageText = $('body').text();
      
      if (!prices.diesel) {
        const dieselMatch = pageText.match(/Diesel[^\d]*(\d{1,2}[.,]\d{2,3})/i);
        if (dieselMatch) {
          prices.diesel = parseFloat(dieselMatch[1].replace(',', '.'));
          console.log(`  ✓ Diesel: ${prices.diesel}€ (regex)`);
        }
      }
      
      if (!prices.e5) {
        const e5Match = pageText.match(/Super\s*E5[^\d]*(\d{1,2}[.,]\d{2,3})/i);
        if (e5Match) {
          prices.e5 = parseFloat(e5Match[1].replace(',', '.'));
          console.log(`  ✓ E5: ${prices.e5}€ (regex)`);
        }
      }
      
      if (!prices.e10) {
        const e10Match = pageText.match(/Super\s*E10[^\d]*(\d{1,2}[.,]\d{2,3})/i);
        if (e10Match) {
          prices.e10 = parseFloat(e10Match[1].replace(',', '.'));
          console.log(`  ✓ E10: ${prices.e10}€ (regex)`);
        }
      }
    }

    console.log(`📊 Итого: Diesel=${prices.diesel}, E5=${prices.e5}, E10=${prices.e10}\n`);

    return {
      id: stationId,
      name: stationName,
      url: url,
      prices: prices,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ Error fetching ${url}:`, error.message);
    return null;
  }
}

// Проверка цен на всех станциях
async function checkAllPrices() {
  console.log('🔍 Checking prices...');
  
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  const updates = [];
  
  for (const station of stations) {
    const current = await fetchStationPrices(station.url);
    
    if (!current || !current.prices) continue;
    
    const lastEntry = database[station.url]?.[0];
    
    // Инициализация истории
    if (!database[station.url]) {
      database[station.url] = [];
    }
    
    // Проверка изменений
    let hasChanges = false;
    const changes = [];
    
    if (lastEntry) {
      if (current.prices.e5 && current.prices.e5 !== lastEntry.prices.e5) {
        changes.push(`E5: ${lastEntry.prices.e5}€ → ${current.prices.e5}€`);
        hasChanges = true;
      }
      if (current.prices.e10 && current.prices.e10 !== lastEntry.prices.e10) {
        changes.push(`E10: ${lastEntry.prices.e10}€ → ${current.prices.e10}€`);
        hasChanges = true;
      }
      if (current.prices.diesel && current.prices.diesel !== lastEntry.prices.diesel) {
        changes.push(`Diesel: ${lastEntry.prices.diesel}€ → ${current.prices.diesel}€`);
        hasChanges = true;
      }
    }
    
    // Сохранение в историю
    database[station.url].unshift(current);
    database[station.url] = database[station.url].slice(0, 100); // Храним последние 100 записей
    
    if (hasChanges) {
      updates.push({
        name: current.name,
        changes: changes
      });
    }
  }
  
  await saveJSON(DATABASE_FILE, database);
  
  // Отправка уведомлений
  if (updates.length > 0) {
    await notifyUsers(updates);
  }
  
  console.log(`✅ Check complete. ${updates.length} stations with price changes.`);
  return updates;
}

// Отправка уведомлений пользователям
async function notifyUsers(updates) {
  const users = await loadJSON(USERS_FILE, {});
  
  for (const update of updates) {
    // Находим URL станции по имени
    const stations = await loadJSON(STATIONS_FILE);
    const station = stations.find(s => s.name === update.name);
    if (!station) continue;
    
    const database = await loadJSON(DATABASE_FILE, {});
    const currentPrices = database[station.url]?.[0]?.prices;
    if (!currentPrices) continue;
    
    // Отправляем уведомления каждому подписанному пользователю
    for (const [chatId, userData] of Object.entries(users)) {
      if (!userData.notifications) continue;
      
      const alerts = [];
      
      // Проверка целевых цен
      if (userData.targets) {
        if (userData.targets.diesel && currentPrices.diesel && currentPrices.diesel <= userData.targets.diesel) {
          alerts.push(`🎯 DIESEL достиг целевой цены!\n💰 ${currentPrices.diesel}€ (цель: ${userData.targets.diesel}€)`);
        }
        if (userData.targets.e5 && currentPrices.e5 && currentPrices.e5 <= userData.targets.e5) {
          alerts.push(`🎯 E5 достиг целевой цены!\n💰 ${currentPrices.e5}€ (цель: ${userData.targets.e5}€)`);
        }
        if (userData.targets.e10 && currentPrices.e10 && currentPrices.e10 <= userData.targets.e10) {
          alerts.push(`🎯 E10 достиг целевой цены!\n💰 ${currentPrices.e10}€ (цель: ${userData.targets.e10}€)`);
        }
      }
      
      // Уведомления об изменениях (если включены)
      if (userData.notifyChanges && update.changes.length > 0) {
        alerts.push(`📊 ${update.name}\n${update.changes.join('\n')}`);
      }
      
      // Отправка уведомлений
      for (const alert of alerts) {
        try {
          await bot.sendMessage(chatId, `⛽ ${alert}`);
        } catch (error) {
          console.error(`Failed to notify ${chatId}:`, error.message);
        }
      }
    }
  }
}

// Анализ лучшего времени для заправки
async function analyzeWeeklyPatterns(stationUrl, fuelType = 'diesel') {
  const database = await loadJSON(DATABASE_FILE, {});
  const history = database[stationUrl] || [];
  
  if (history.length < 20) {
    return { error: 'Недостаточно данных (минимум 20 записей)' };
  }
  
  // Группировка по дням недели и часам
  const patterns = {
    byDayOfWeek: {},
    byHour: {},
    byDayAndHour: {}
  };
  
  for (const entry of history) {
    const price = entry.prices[fuelType];
    if (!price) continue;
    
    const date = new Date(entry.timestamp);
    const dayOfWeek = date.toLocaleDateString('ru-RU', { weekday: 'long' });
    const hour = date.getHours();
    const key = `${dayOfWeek}-${hour}`;
    
    // По дням недели
    if (!patterns.byDayOfWeek[dayOfWeek]) {
      patterns.byDayOfWeek[dayOfWeek] = [];
    }
    patterns.byDayOfWeek[dayOfWeek].push(price);
    
    // По часам
    if (!patterns.byHour[hour]) {
      patterns.byHour[hour] = [];
    }
    patterns.byHour[hour].push(price);
    
    // По дням и часам
    if (!patterns.byDayAndHour[key]) {
      patterns.byDayAndHour[key] = [];
    }
    patterns.byDayAndHour[key].push(price);
  }
  
  // Вычисление средних цен
  const avgByDay = {};
  for (const [day, prices] of Object.entries(patterns.byDayOfWeek)) {
    avgByDay[day] = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
  }
  
  const avgByHour = {};
  for (const [hour, prices] of Object.entries(patterns.byHour)) {
    avgByHour[hour] = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
  }
  
  // Поиск лучших слотов (день + час)
  const bestSlots = [];
  for (const [key, prices] of Object.entries(patterns.byDayAndHour)) {
    if (prices.length < 3) continue; // Минимум 3 наблюдения
    
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const [day, hour] = key.split('-');
    
    bestSlots.push({
      day,
      hour: parseInt(hour),
      avgPrice: parseFloat(avg.toFixed(3)),
      observations: prices.length
    });
  }
  
  // Сортировка по цене
  bestSlots.sort((a, b) => a.avgPrice - b.avgPrice);
  
  // Топ-5 лучших временных слотов
  const top5 = bestSlots.slice(0, 5);
  
  // Лучший день недели
  const bestDay = Object.entries(avgByDay).sort((a, b) => a[1] - b[1])[0];
  
  // Лучший час
  const bestHour = Object.entries(avgByHour).sort((a, b) => a[1] - b[1])[0];
  
  return {
    bestDay: { day: bestDay[0], avgPrice: parseFloat(bestDay[1]) },
    bestHour: { hour: parseInt(bestHour[0]), avgPrice: parseFloat(bestHour[1]) },
    top5Slots: top5,
    totalObservations: history.length
  };
}

// Команды бота
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  
  // Инициализация пользователя
  if (!users[chatId]) {
    users[chatId] = {
      notifications: true,
      notifyChanges: false,
      targets: {
        diesel: null,
        e5: null,
        e10: null
      },
      fuelType: 'diesel'
    };
    await saveJSON(USERS_FILE, users);
  }
  
  bot.sendMessage(chatId, 
    '⛽ *Fuel Price Tracker - Умный помощник*\n\n' +
    '📊 *Команды:*\n' +
    '/prices - Текущие цены\n' +
    '/check - Мгновенный update цен\n' +
    '/stations - Список заправок\n' +
    '/settarget - Установить целевую цену\n' +
    '/analytics - Анализ лучшего времени\n' +
    '/settings - Настройки уведомлений\n' +
    '/help - Подробная помощь',
    { parse_mode: 'Markdown' }
  );
});


bot.onText(/\/prices/, async (msg) => {
  const chatId = msg.chat.id;

  // Сообщаем что идёт live-обновление
  const waitMsg = await bot.sendMessage(chatId, '🔄 Проверяю актуальные цены (live)...');

  // Принудительно обновляем цены (это же пишет логи парсинга)
  await checkAllPrices();

  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});

  let message = '⛽ *Актуальные цены:*\n\n';

  for (const station of stations) {
    const latest = database[station.url]?.[0];
    if (latest) {
      const timestamp = new Date(latest.timestamp);
      const dateStr = timestamp.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      message += `📍 *Station ${latest.id} - ${station.name}*\n`;
      message += `   _${dateStr}, ${timeStr}_\n`;
      if (latest.prices.diesel) message += `   💰 Diesel: ${latest.prices.diesel}€\n`;
      if (latest.prices.e10) message += `   💰 E10: ${latest.prices.e10}€\n`;
      if (latest.prices.e5) message += `   💰 E5: ${latest.prices.e5}€\n`;
      message += '\n';
    } else {
      const stationId = station.url.match(/\/(\d+)$/)?.[1];
      message += `📍 *Station ${stationId} - ${station.name}*\n`;
      message += `   _Нет данных_\n\n`;
    }
  }

  // Убираем "подождите" и отправляем итог
  try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch {}
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/check/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔍 Проверяю цены...');
  const updates = await checkAllPrices();
  
  if (updates.length === 0) {
    bot.sendMessage(msg.chat.id, '✅ Изменений нет');
  } else {
    bot.sendMessage(msg.chat.id, `✅ Обновлено: ${updates.length} станций`);
  }
});

bot.onText(/\/cached/, async (msg) => {
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});

  let message = '💾 *Последние известные цены:*\n_Без обновления с сайта_\n\n';

  for (const station of stations) {
    const latest = database[station.url]?.[0];
    if (latest) {
      const timestamp = new Date(latest.timestamp);
      const ageMinutes = Math.floor((Date.now() - timestamp.getTime()) / 60000);

      const dateStr = timestamp.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      message += `📍 *Station ${latest.id} - ${station.name}*\n`;
      message += `   _${dateStr}, ${timeStr} (${ageMinutes} мин назад)_\n`;

      if (latest.prices.diesel) message += `   💰 Diesel: ${latest.prices.diesel}€\n`;
      if (latest.prices.e10) message += `   💰 E10: ${latest.prices.e10}€\n`;
      if (latest.prices.e5) message += `   💰 E5: ${latest.prices.e5}€\n`;
      message += '\n';
    }
  }

  message += '💡 Для актуальных цен используй `/prices`';
  await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/stations/, async (msg) => {
  const stations = await loadJSON(STATIONS_FILE);
  const message = '📋 *Отслеживаемые заправки:*\n\n' +
    stations.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/settarget (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  
  // Формат: diesel 1.76 или e5 1.80
  const parts = input.split(' ');
  if (parts.length !== 2) {
    bot.sendMessage(chatId, 
      '❌ Неверный формат!\n\n' +
      'Используй: `/settarget diesel 1.76`\n' +
      'Или: `/settarget e5 1.80`',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const [fuelType, priceStr] = parts;
  const price = parseFloat(priceStr);
  
  if (!['diesel', 'e5', 'e10'].includes(fuelType.toLowerCase())) {
    bot.sendMessage(chatId, '❌ Тип топлива должен быть: diesel, e5 или e10');
    return;
  }
  
  if (isNaN(price) || price <= 0) {
    bot.sendMessage(chatId, '❌ Неверная цена!');
    return;
  }
  
  const users = await loadJSON(USERS_FILE, {});
  if (!users[chatId]) users[chatId] = { notifications: true, targets: {} };
  if (!users[chatId].targets) users[chatId].targets = {};
  
  users[chatId].targets[fuelType.toLowerCase()] = price;
  await saveJSON(USERS_FILE, users);
  
  bot.sendMessage(chatId, 
    `✅ Целевая цена установлена!\n\n` +
    `🎯 ${fuelType.toUpperCase()}: ${price}€\n\n` +
    `Я уведомлю тебя, когда цена опустится до этого уровня или ниже.`
  );
});

bot.onText(/\/analytics/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  const userData = users[chatId] || { fuelType: 'diesel' };
  const fuelType = userData.fuelType || 'diesel';
  
  bot.sendMessage(chatId, '📊 Анализирую данные за неделю...');
  
  const stations = await loadJSON(STATIONS_FILE);
  let message = `📊 *Анализ лучшего времени для заправки (${fuelType.toUpperCase()})*\n\n`;
  
  for (const station of stations) {
    const analysis = await analyzeWeeklyPatterns(station.url, fuelType);
    
    if (analysis.error) {
      message += `📍 *${station.name}*\n${analysis.error}\n\n`;
      continue;
    }
    
    message += `📍 *${station.name}*\n`;
    message += `📈 Наблюдений: ${analysis.totalObservations}\n\n`;
    
    message += `🏆 *Лучший день:* ${analysis.bestDay.day}\n`;
    message += `   Средняя цена: ${analysis.bestDay.avgPrice}€\n\n`;
    
    message += `⏰ *Лучший час:* ${analysis.bestHour.hour}:00\n`;
    message += `   Средняя цена: ${analysis.bestHour.avgPrice}€\n\n`;
    
    message += `🎯 *Топ-5 временных слотов:*\n`;
    analysis.top5Slots.forEach((slot, i) => {
      message += `${i + 1}. ${slot.day} в ${slot.hour}:00 - ${slot.avgPrice}€\n`;
    });
    message += '\n';
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  const userData = users[chatId] || { notifications: true, notifyChanges: false, fuelType: 'diesel', targets: {} };
  
  const keyboard = {
    inline_keyboard: [
      [
        { 
          text: userData.notifications ? '🔔 Уведомления: ВКЛ' : '🔕 Уведомления: ВЫКЛ', 
          callback_data: 'toggle_notifications' 
        }
      ],
      [
        { 
          text: userData.notifyChanges ? '📊 Все изменения: ВКЛ' : '📊 Все изменения: ВЫКЛ', 
          callback_data: 'toggle_changes' 
        }
      ],
      [
        { text: 'Diesel', callback_data: 'fuel_diesel' },
        { text: 'E5', callback_data: 'fuel_e5' },
        { text: 'E10', callback_data: 'fuel_e10' }
      ]
    ]
  };
  
  let message = '⚙️ *Настройки*\n\n';
  message += `Текущий тип топлива: *${(userData.fuelType || 'diesel').toUpperCase()}*\n\n`;
  
  if (userData.targets) {
    message += '🎯 *Целевые цены:*\n';
    if (userData.targets.diesel) message += `Diesel: ${userData.targets.diesel}€\n`;
    if (userData.targets.e5) message += `E5: ${userData.targets.e5}€\n`;
    if (userData.targets.e10) message += `E10: ${userData.targets.e10}€\n`;
  }
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '📖 *Подробная помощь*\n\n' +
    '*Основные команды:*\n' +
    '`/prices` - Показать текущие цены на всех заправках\n' +
    '`/check` - Синхронизировать цены\n' +
    '`/analytics` - Анализ лучшего времени за неделю\n' +
    '`/settings` - Настройки\n\n' +
    '*Настройка алертов:*\n' +
    '`/settarget diesel 1.76` - Уведомить при цене ≤ 1.76€\n' +
    '`/settarget e5 1.80` - Уведомить при цене ≤ 1.80€\n\n' +
    '*Как это работает:*\n' +
    '1️⃣ Бот проверяет цены каждые 10 минут\n' +
    '2️⃣ Если цена достигла целевой - получишь уведомление\n' +
    '3️⃣ Раз в неделю смотри `/analytics` для оптимального времени\n\n' +
    '*Пример использования:*\n' +
    '• Установи целевую цену: `/settarget diesel 1.74`\n' +
    '• Жди уведомления 🔔\n' +
    '• Заправляйся по лучшей цене!\n\n' +
    '💡 Совет: используй `/analytics` чтобы узнать, в какой день и час обычно самые низкие цены',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/backup/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Нет доступа.');

  try {
    await bot.sendMessage(chatId, '☁️ Делаю backup на Google Drive...');
    await backupToDrive();
    await bot.sendMessage(chatId, '✅ Backup готов: database/users/stations сохранены в Google Drive');
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Backup ошибка: ${e.message}`);
  }
});

bot.onText(/\/restore/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Нет доступа.');

  try {
    await bot.sendMessage(chatId, '☁️ Восстанавливаю файлы с Google Drive...');
    await restoreFromDrive();
    await bot.sendMessage(chatId, '✅ Restore готов: database/users/stations восстановлены');
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Restore ошибка: ${e.message}`);
  }
});

bot.onText(/\/stats/, async (msg) => {
  const database = await loadJSON(DATABASE_FILE, {});
  const stations = await loadJSON(STATIONS_FILE);

  let totalEntries = 0;
  let oldestDate = new Date();
  let newestDate = new Date(0);

  let message = '📊 *Статистика базы данных*\n\n';

  for (const station of stations) {
    const entries = database[station.url] || [];
    totalEntries += entries.length;

    if (entries.length > 0) {
      const stationOldest = new Date(entries[entries.length - 1].timestamp);
      const stationNewest = new Date(entries[0].timestamp);

      if (stationOldest < oldestDate) oldestDate = stationOldest;
      if (stationNewest > newestDate) newestDate = stationNewest;

      message += `📍 *${station.name}*\n`;
      message += `   Записей: ${entries.length}\n`;
      message += `   Последняя: ${stationNewest.toLocaleString('ru-RU')}\n\n`;
    }
  }

  const ageInDays = (newestDate > oldestDate) ? Math.floor((newestDate - oldestDate) / (1000 * 60 * 60 * 24)) : 0;
  const dbSize = JSON.stringify(database).length / 1024;

  message += `\n📈 *Общая статистика:*\n`;
  message += `Всего записей: ${totalEntries}\n`;
  message += `Период данных: ${ageInDays} дней\n`;
  message += `Размер БД: ${dbSize.toFixed(2)} KB\n\n`;
  message += `🧹 *Автоочистка:* последние 14 дней`;

  await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// Обработчик inline кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  const users = await loadJSON(USERS_FILE, {});
  if (!users[chatId]) users[chatId] = { notifications: true, targets: {}, fuelType: 'diesel' };
  
  if (data === 'toggle_notifications') {
    users[chatId].notifications = !users[chatId].notifications;
    await saveJSON(USERS_FILE, users);
    bot.answerCallbackQuery(query.id, { 
      text: users[chatId].notifications ? '🔔 Уведомления включены' : '🔕 Уведомления выключены' 
    });
  } else if (data === 'toggle_changes') {
    users[chatId].notifyChanges = !users[chatId].notifyChanges;
    await saveJSON(USERS_FILE, users);
    bot.answerCallbackQuery(query.id, { 
      text: users[chatId].notifyChanges ? '📊 Уведомления о всех изменениях включены' : '📊 Только целевые цены' 
    });
  } else if (data.startsWith('fuel_')) {
    const fuelType = data.replace('fuel_', '');
    users[chatId].fuelType = fuelType;
    await saveJSON(USERS_FILE, users);
    bot.answerCallbackQuery(query.id, { 
      text: `Выбран тип топлива: ${fuelType.toUpperCase()}` 
    });
  }
  
  // Обновляем сообщение с настройками
  const userData = users[chatId];
  const keyboard = {
    inline_keyboard: [
      [
        { 
          text: userData.notifications ? '🔔 Уведомления: ВКЛ' : '🔕 Уведомления: ВЫКЛ', 
          callback_data: 'toggle_notifications' 
        }
      ],
      [
        { 
          text: userData.notifyChanges ? '📊 Все изменения: ВКЛ' : '📊 Все изменения: ВЫКЛ', 
          callback_data: 'toggle_changes' 
        }
      ],
      [
        { text: 'Diesel', callback_data: 'fuel_diesel' },
        { text: 'E5', callback_data: 'fuel_e5' },
        { text: 'E10', callback_data: 'fuel_e10' }
      ]
    ]
  };
  
  let message = '⚙️ *Настройки*\n\n';
  message += `Текущий тип топлива: *${(userData.fuelType || 'diesel').toUpperCase()}*\n\n`;
  
  if (userData.targets) {
    message += '🎯 *Целевые цены:*\n';
    if (userData.targets.diesel) message += `Diesel: ${userData.targets.diesel}€\n`;
    if (userData.targets.e5) message += `E5: ${userData.targets.e5}€\n`;
    if (userData.targets.e10) message += `E10: ${userData.targets.e10}€\n`;
  }
  
  bot.editMessageText(message, {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// HTTP endpoint для UptimeRobot
const express = require('express');
const app = express();

app.get('/health', (req, res) => {
  res.send('OK');
});

app.get('/', async (req, res) => {
  try {
    const stations = await loadJSON(STATIONS_FILE, []);
    const database = await loadJSON(DATABASE_FILE, {});

    const rows = stations.map(s => {
      const latest = database[s.url]?.[0];
      if (!latest) return `<tr><td>${s.name}</td><td colspan="3">нет данных</td></tr>`;
      const t = new Date(latest.timestamp);
      const ts = t.toLocaleString('de-DE', { hour12: false });
      const p = latest.prices || {};
      const fmt = (x) => (x === null || x === undefined) ? '—' : Number(x).toFixed(3);
      return `<tr><td>${s.name}</td><td>${fmt(p.diesel)}</td><td>${fmt(p.e10)}</td><td>${fmt(p.e5)}</td><td>${ts}</td></tr>`;
    }).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"/>
<title>Fuel Tracker</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #3333;padding:8px;text-align:left}th{position:sticky;top:0;background:#111;color:#fff}code{background:#f2f2f2;padding:2px 6px;border-radius:6px}</style></head>
<body>
<h1>Fuel Tracker</h1>
<p>Endpoints: <code>/health</code> <code>/check-prices</code></p>
<p>Telegram: <code>/prices</code> (live) <code>/cached</code> (no refresh) <code>/backup</code> <code>/restore</code></p>
<table><thead><tr><th>Station</th><th>Diesel</th><th>E10</th><th>E5</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  } catch (e) {
    res.status(500).send('error: ' + e.message);
  }
});

app.get('/check-prices', async (req, res) => {
  try {
    await checkAllPrices();
    res.json({ status: 'success' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🤖 Bot started');

  // Авто-восстановление JSON с Google Drive (Render Free friendly)
  if (process.env.AUTO_RESTORE_ON_START === '1') {
    try {
      console.log('☁️ AUTO_RESTORE_ON_START: restoring JSON from Google Drive...');
      await restoreFromDrive();
      console.log('✅ Auto-restore done');
    } catch (e) {
      console.log('⚠️ Auto-restore failed:', e.message);
    }
  }

  // Первая проверка при запуске
  try {
    await checkAllPrices();
  } catch (e) {
    console.log('⚠️ Initial check failed:', e.message);
  }
});

// Автоматическая проверка каждые 30 минут (на всякий случай)
setInterval(checkAllPrices, 10 * 60 * 1000);


// Авто-бэкап на Google Drive
const BACKUP_INTERVAL_MIN = parseInt(process.env.BACKUP_INTERVAL_MIN || '360', 10); // 6 часов
setInterval(async () => {
  if (!process.env.GDRIVE_KEYFILE) return;
  try {
    console.log('☁️ Auto-backup to Drive...');
    await backupToDrive();
    console.log('✅ Auto-backup done');
  } catch (e) {
    console.log('⚠️ Auto-backup failed:', e.message);
  }
}, BACKUP_INTERVAL_MIN * 60 * 1000);
