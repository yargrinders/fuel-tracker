require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const fsNative = require('fs');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

// Установка timezone для Германии
process.env.TZ = 'Europe/Berlin';

// Время запуска сервера (для uptime)
const serverStartTime = new Date();

// ===== Google Drive backup/restore (ТВОЙ РАБОЧИЙ КОД!) =====
function isAdmin(chatId) {
  const raw = process.env.ADMIN_CHAT_IDS;
  if (!raw) return true;
  const set = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  return set.has(String(chatId));
}

async function createDriveClient() {
  const keyFile = process.env.GDRIVE_KEYFILE;
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

// ✅ ИСПРАВЛЕНИЕ 4: Проверка часов работы станции
function isStationOpen(station, timestamp = new Date()) {
  if (!station.openingHours) return true;
  if (station.openingHours.is24h) return true;
  
  const day = timestamp.getDay();
  const hour = timestamp.getHours();
  const minute = timestamp.getMinutes();
  const currentTime = hour * 60 + minute;
  
  let schedule;
  if (day === 0) {
    schedule = station.openingHours.sun;
  } else if (day === 6) {
    schedule = station.openingHours.sat;
  } else {
    schedule = station.openingHours.monFri;
  }
  
  if (!schedule) return true;
  
  const match = schedule.match(/(\d+):(\d+)-(\d+):(\d+)/);
  if (!match) return true;
  
  const openTime = parseInt(match[1]) * 60 + parseInt(match[2]);
  const closeTime = parseInt(match[3]) * 60 + parseInt(match[4]);
  
  const isOpen = currentTime >= openTime && currentTime < closeTime;
  
  if (!isOpen) {
    console.log(`  ⏰ Станция ${station.name} закрыта (${schedule})`);
  }
  
  return isOpen;
}

// Парсер цен с clever-tanken.de (ТВОЙ РАБОЧИЙ КОД с suffix!)
async function fetchStationPrices(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    const suffixMap = {};
    $('sup[id^="suffix-price-"]').each((i, el) => {
      const id = $(el).attr('id') || '';
      const mm = id.match(/suffix-price-(\d+)/);
      if (!mm) return;
      const key = mm[1];
      const val = (($(el).text() || '').trim()).replace(/[^\d]/g, '');
      if (val) suffixMap[key] = val;
    });
    
    const stationId = url.match(/\/(\d+)$/)?.[1];
    const stationName = $('h1').first().text().trim() || 
                       $('.station-name').first().text().trim() ||
                       `Station ${stationId}`;

    const prices = {
      e5: null,
      e10: null,
      diesel: null
    };

    function fullPrice(baseRaw, suffixRaw) {
      const base = String(baseRaw || '').replace(',', '.').replace(/[^\d.]/g, '').trim();
      if (!base) return null;

      const m = base.match(/^(\d{1,2})\.(\d{2,3})$/);
      if (!m) {
        const n = Number(base);
        return Number.isFinite(n) ? n : null;
      }

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

    // ✅ НОВОЕ: самый надёжный парсинг — напрямую по ID current-price-N / suffix-price-N
    // На clever-tanken обычно:
    // 1 = Diesel, 2 = E10, 3 = E5 (как в твоём примере)
    const directMap = [
      { n: 1, key: 'diesel' },
      { n: 2, key: 'e10' },
      { n: 3, key: 'e5' }
    ];

    for (const m of directMap) {
      const baseText = $(`#current-price-${m.n}`).first().text().trim();
      const suffixText = $(`#suffix-price-${m.n}`).first().text().trim();
      const price = fullPrice(baseText, suffixText);

      if (!isNaN(price) && price > 0 && price < 3) {
        prices[m.key] = price;
      }
    }

    const gotAllById = prices.diesel && prices.e10 && prices.e5;

    if (gotAllById) {
      console.log(`  ✓ Diesel: ${prices.diesel}€ (по ID)`);
      console.log(`  ✓ E10: ${prices.e10}€ (по ID)`);
      console.log(`  ✓ E5: ${prices.e5}€ (по ID)`);
    } else {

      $('.price-field').each((i, priceField) => {
      const fieldHtml = $(priceField).html();
      const fieldText = $(priceField).text().toLowerCase();
      
      const priceSpan = $(priceField).find('span[id^="current-price-"]').first();
      const priceId = priceSpan.attr('id') || '';
      const idMatch = priceId.match(/current-price-(\d+)/);
      const num = idMatch ? idMatch[1] : null;

      let priceText = priceSpan.text().trim();
      let suffixText = '';
      if (num) {
        suffixText = $(`#suffix-price-${num}`).first().text().trim();
      }
      
      if (!priceText) {
        const match = fieldHtml.match(/>(\d{1,2}[.,]\d{2,3})</);
        if (match) priceText = match[1];
      }
      
      if (priceText) {
        const price = fullPrice(priceText, suffixText);
        
        if (!isNaN(price) && price > 0 && price < 3) {
          const parentText = $(priceField).parent().text().toLowerCase();
          const allText = fieldText + ' ' + parentText;
          
          if (!prices.diesel && allText.includes('diesel')) {
            prices.diesel = price;
            console.log(`  ✓ Diesel: ${price}€`);
          } else if (!prices.e5 && (allText.includes('super e5') || allText.includes('e 5'))) {
            prices.e5 = price;
            console.log(`  ✓ E5: ${price}€`);
          } else if (!prices.e10 && allText.includes('super e10')) {
            prices.e10 = price;
            console.log(`  ✓ E10: ${price}€`);
          }
        }
      }
    });

    }

    if (!prices.diesel || !prices.e5 || !prices.e10) {
      $('span[id^="current-price-"]').each((i, span) => {
        const baseText = $(span).text().trim();
        const id = $(span).attr('id') || '';
        const m = id.match(/current-price-(\d+)/);
        const num = m ? m[1] : null;
        const suffixText = num ? $(`#suffix-price-${num}`).first().text().trim() : '';
        const price = fullPrice(baseText, suffixText);
        
        if (!isNaN(price) && price > 0 && price < 3) {
          const parent = $(span).closest('div, tr, li');
          const labelText = parent.text().toLowerCase();
          
          if (!prices.diesel && labelText.includes('diesel')) {
            prices.diesel = price;
            console.log(`  ✓ Diesel: ${price}€ (доп. метод)`);
          } else if (!prices.e5 && labelText.includes('super e5')) {
            prices.e5 = price;
            console.log(`  ✓ E5: ${price}€ (доп. метод)`);
          } else if (!prices.e10 && labelText.includes('super e10')) {
            prices.e10 = price;
            console.log(`  ✓ E10: ${price}€ (доп. метод)`);
          }
        }
      });
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

// ✅ ИСПРАВЛЕНИЕ 4: Проверка цен с учётом графика работы
async function checkAllPrices() {
  console.log('🔍 Checking prices...');
  
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  const now = new Date();
  
  const updates = [];
  
  for (const station of stations) {
    // Проверяем часы работы
    if (!isStationOpen(station, now)) {
      console.log(`  ⏭️  Пропускаем ${station.name} (закрыта)`);
      continue;
    }
    
    const current = await fetchStationPrices(station.url);
    
    if (!current || !current.prices) continue;
    
    const lastEntry = database[station.url]?.[0];
    
    if (!database[station.url]) {
      database[station.url] = [];
    }
    
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
    
    database[station.url].unshift(current);
    
    // Храним только последние 14 дней
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - TWO_WEEKS_MS);
    database[station.url] = database[station.url].filter(entry => 
      new Date(entry.timestamp) > cutoff
    );
    
    if (hasChanges) {
      updates.push({
        name: current.name,
        url: station.url,
        changes: changes,
        prices: current.prices
      });
    }
  }
  
  await saveJSON(DATABASE_FILE, database);
  
  if (updates.length > 0) {
    await notifyUsers(updates);
  }
  
  console.log(`✅ Check complete. ${updates.length} stations with price changes.`);
  return updates;
}

// ✅ ИСПРАВЛЕНИЕ 6: Уведомления с lastAlerts (защита от спама)
async function notifyUsers(updates) {
  const users = await loadJSON(USERS_FILE, {});
  
  for (const update of updates) {
    for (const [chatId, userData] of Object.entries(users)) {
      if (!userData.notifications) continue;
      
      if (!userData.lastAlerts) {
        userData.lastAlerts = {};
      }
      if (!userData.lastAlerts[update.url]) {
        userData.lastAlerts[update.url] = { diesel: null, e5: null, e10: null };
      }
      
      const alerts = [];
      const currentPrices = update.prices;
      const lastAlert = userData.lastAlerts[update.url];
      
      if (userData.targets) {
        // DIESEL
        if (userData.targets.diesel && currentPrices.diesel) {
          if (currentPrices.diesel <= userData.targets.diesel) {
            if (!lastAlert.diesel || currentPrices.diesel < lastAlert.diesel) {
              alerts.push(`🎯 DIESEL достиг целевой цены!\n💰 ${currentPrices.diesel}€ (цель: ${userData.targets.diesel}€)`);
              lastAlert.diesel = currentPrices.diesel;
            }
          } else {
            lastAlert.diesel = null;
          }
        }
        
        // E5
        if (userData.targets.e5 && currentPrices.e5) {
          if (currentPrices.e5 <= userData.targets.e5) {
            if (!lastAlert.e5 || currentPrices.e5 < lastAlert.e5) {
              alerts.push(`🎯 E5 достиг целевой цены!\n💰 ${currentPrices.e5}€ (цель: ${userData.targets.e5}€)`);
              lastAlert.e5 = currentPrices.e5;
            }
          } else {
            lastAlert.e5 = null;
          }
        }
        
        // E10
        if (userData.targets.e10 && currentPrices.e10) {
          if (currentPrices.e10 <= userData.targets.e10) {
            if (!lastAlert.e10 || currentPrices.e10 < lastAlert.e10) {
              alerts.push(`🎯 E10 достиг целевой цены!\n💰 ${currentPrices.e10}€ (цель: ${userData.targets.e10}€)`);
              lastAlert.e10 = currentPrices.e10;
            }
          } else {
            lastAlert.e10 = null;
          }
        }
      }
      
      if (userData.notifyChanges && update.changes.length > 0) {
        alerts.push(`📊 ${update.name}\n${update.changes.join('\n')}`);
      }
      
      for (const alert of alerts) {
        try {
          await bot.sendMessage(chatId, `⛽ *${update.name}*\n\n${alert}`, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error(`Failed to notify ${chatId}:`, error.message);
        }
      }
    }
  }
  
  await saveJSON(USERS_FILE, users);
}

// Аналитика лучшего времени
async function analyzeWeeklyPatterns(stationUrl, fuelType = 'diesel') {
  const database = await loadJSON(DATABASE_FILE, {});
  const allHistory = database[stationUrl] || [];
  
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekAgo = new Date(Date.now() - ONE_WEEK_MS);
  
  const history = allHistory.filter(entry => 
    new Date(entry.timestamp) > weekAgo
  );
  
  if (history.length < 20) {
    return { error: 'Недостаточно данных (минимум 20 записей за неделю)' };
  }
  
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
    
    if (!patterns.byDayOfWeek[dayOfWeek]) patterns.byDayOfWeek[dayOfWeek] = [];
    patterns.byDayOfWeek[dayOfWeek].push(price);
    
    if (!patterns.byHour[hour]) patterns.byHour[hour] = [];
    patterns.byHour[hour].push(price);
    
    if (!patterns.byDayAndHour[key]) patterns.byDayAndHour[key] = [];
    patterns.byDayAndHour[key].push(price);
  }
  
  const avgByDay = {};
  for (const [day, prices] of Object.entries(patterns.byDayOfWeek)) {
    avgByDay[day] = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
  }
  
  const avgByHour = {};
  for (const [hour, prices] of Object.entries(patterns.byHour)) {
    avgByHour[hour] = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
  }
  
  const bestSlots = [];
  for (const [key, prices] of Object.entries(patterns.byDayAndHour)) {
    if (prices.length < 3) continue;
    
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const [day, hour] = key.split('-');
    
    bestSlots.push({
      day,
      hour: parseInt(hour),
      avgPrice: parseFloat(avg.toFixed(3)),
      observations: prices.length
    });
  }
  
  bestSlots.sort((a, b) => a.avgPrice - b.avgPrice);
  
  const top5 = bestSlots.slice(0, 5);
  const bestDay = Object.entries(avgByDay).sort((a, b) => a[1] - b[1])[0];
  const bestHour = Object.entries(avgByHour).sort((a, b) => a[1] - b[1])[0];
  
  return {
    bestDay: { day: bestDay[0], avgPrice: parseFloat(bestDay[1]) },
    bestHour: { hour: parseInt(bestHour[0]), avgPrice: parseFloat(bestHour[1]) },
    top5Slots: top5,
    totalObservations: history.length,
    period: '7 дней'
  };
}

// ========== TELEGRAM BOT COMMANDS ==========

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  
  if (!users[chatId]) {
    users[chatId] = {
      notifications: true,
      notifyChanges: false,
      targets: { diesel: null, e5: null, e10: null },
      fuelType: 'diesel'
    };
    await saveJSON(USERS_FILE, users);
  }
  
  bot.sendMessage(chatId, 
    '⛽ *Fuel Price Tracker*\n\n' +
    '📊 Основные команды:\n' +
    '/prices - Актуальные цены\n' +
    '/analytics - Анализ лучшего времени\n' +
    '/settarget - Установить целевую цену\n' +
    '/settings - Настройки\n' +
    '/help - Помощь\n\n' +
    'Бот работает! 🚀',
    { parse_mode: 'Markdown' }
  );
});

// ✅ ИСПРАВЛЕНИЕ 2: Обновлённая команда /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '📖 *Подробная помощь*\n\n' +
    '*Основные команды:*\n' +
    '`/prices` - Показать актуальные цены\n' +
    '`/check` - Проверить цены сейчас\n' +
    '`/analytics` - Анализ лучшего времени\n' +
    '`/stats` - Статистика базы данных\n\n' +
    '*Настройка алертов:*\n' +
    '`/settarget diesel 1.76` - Уведомить при цене ≤ 1.76€\n' +
    '`/settarget e5 1.80` - Уведомить при цене ≤ 1.80€\n' +
    '`/settings` - Настройки уведомлений\n\n' +
    '*Бэкапы (только для админа):*\n' +
    '`/backup` - Сохранить в Google Drive\n' +
    '`/restore` - Восстановить из Google Drive\n\n' +
    '*Как это работает:*\n' +
    '1️⃣ Бот проверяет цены каждые 5 минут\n' +
    '2️⃣ Автобэкап в Google Drive каждые 6 часов\n' +
    '3️⃣ Уведомления когда цена достигла цели\n' +
    '4️⃣ Аналитика лучшего времени за неделю\n' +
    '5️⃣ Учёт графика работы станций\n\n' +
    '*Пример:*\n' +
    '`/settarget diesel 1.74` → установить цель\n' +
    '`/analytics` → узнать лучшее время\n' +
    '`/prices` → проверить сейчас\n\n' +
    '💡 Совет: используй аналитику для экономии!',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/prices/, async (msg) => {
  const chatId = msg.chat.id;
  const waitMsg = await bot.sendMessage(chatId, '🔄 Проверяю цены...');
  
  await checkAllPrices();
  
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  let message = '⛽ *Актуальные цены:*\n\n';
  
  for (const station of stations) {
    const latest = database[station.url]?.[0];
    if (latest) {
      const timestamp = new Date(latest.timestamp);
      message += `📍 *Station ${latest.id} - ${station.name}*\n`;
      message += `   _${timestamp.toLocaleString('de-DE')}_\n`;
      
      if (latest.prices.diesel) message += `   💰 Diesel: ${latest.prices.diesel}€\n`;
      if (latest.prices.e5) message += `   💰 E5: ${latest.prices.e5}€\n`;
      if (latest.prices.e10) message += `   💰 E10: ${latest.prices.e10}€\n`;
      message += '\n';
    }
  }
  
  await bot.deleteMessage(chatId, waitMsg.message_id);
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
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

bot.onText(/\/settarget (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fuelType = match[1].toLowerCase();
  const price = parseFloat(match[2]);
  
  if (!['diesel', 'e5', 'e10'].includes(fuelType)) {
    bot.sendMessage(chatId, '❌ Неверный тип топлива. Используй: diesel, e5 или e10');
    return;
  }
  
  if (isNaN(price)) {
    bot.sendMessage(chatId, '❌ Неверная цена');
    return;
  }
  
  const users = await loadJSON(USERS_FILE, {});
  if (!users[chatId]) users[chatId] = { notifications: true, targets: {} };
  if (!users[chatId].targets) users[chatId].targets = {};
  
  users[chatId].targets[fuelType] = price;
  await saveJSON(USERS_FILE, users);
  
  bot.sendMessage(chatId, 
    `✅ *Целевая цена установлена!*\n\n` +
    `🎯 ${fuelType.toUpperCase()}: ${price}€\n\n` +
    `Я уведомлю тебя когда цена опустится до этого уровня или ниже.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/analytics/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  const userData = users[chatId] || { fuelType: 'diesel' };
  const fuelType = userData.fuelType || 'diesel';
  
  bot.sendMessage(chatId, '📊 Анализирую данные за неделю...');
  
  const stations = await loadJSON(STATIONS_FILE);
  let message = `📊 *Анализ лучшего времени*\n_Топливо: ${fuelType.toUpperCase()}, Период: 7 дней_\n\n`;
  
  for (const station of stations) {
    const analysis = await analyzeWeeklyPatterns(station.url, fuelType);
    
    if (analysis.error) {
      message += `📍 *${station.name}*\n${analysis.error}\n\n`;
      continue;
    }
    
    message += `📍 *${station.name}*\n`;
    message += `📈 Наблюдений: ${analysis.totalObservations}\n\n`;
    message += `🏆 Лучший день: ${analysis.bestDay.day} (${analysis.bestDay.avgPrice}€)\n`;
    message += `⏰ Лучший час: ${analysis.bestHour.hour}:00 (${analysis.bestHour.avgPrice}€)\n\n`;
    message += `🎯 Топ-5:\n`;
    
    analysis.top5Slots.forEach((slot, i) => {
      message += `${i + 1}. ${slot.day} в ${slot.hour}:00 - ${slot.avgPrice}€\n`;
    });
    message += '\n';
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  let totalRecords = 0;
  let message = '📊 *Статистика базы данных*\n\n';
  
  for (const station of stations) {
    const entries = database[station.url] || [];
    totalRecords += entries.length;
    
    if (entries.length > 0) {
      const newest = new Date(entries[0].timestamp);
      message += `📍 *${station.name}*\n`;
      message += `   Записей: ${entries.length}\n`;
      message += `   Последняя: ${newest.toLocaleString('de-DE')}\n\n`;
    }
  }
  
  const dbSize = JSON.stringify(database).length / 1024;
  message += `\n📈 *Общая статистика:*\n`;
  message += `Всего записей: ${totalRecords}\n`;
  message += `Размер БД: ${dbSize.toFixed(2)} KB\n\n`;
  message += `🧹 Автоочистка: последние 14 дней\n`;
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  const userData = users[chatId] || {};
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: userData.notifications ? '🔔 Уведомления: ВКЛ' : '🔕 Уведомления: ВЫКЛ', callback_data: 'toggle_notifications' }
      ],
      [
        { text: 'Diesel', callback_data: 'fuel_diesel' },
        { text: 'E5', callback_data: 'fuel_e5' },
        { text: 'E10', callback_data: 'fuel_e10' }
      ]
    ]
  };
  
  bot.sendMessage(chatId, '⚙️ *Настройки*\n\nВыбери тип топлива для аналитики:', {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const users = await loadJSON(USERS_FILE, {});
  
  if (!users[chatId]) users[chatId] = { notifications: true, fuelType: 'diesel', targets: {} };
  
  if (query.data === 'toggle_notifications') {
    users[chatId].notifications = !users[chatId].notifications;
    await saveJSON(USERS_FILE, users);
    bot.answerCallbackQuery(query.id, { text: users[chatId].notifications ? 'Уведомления включены' : 'Уведомления выключены' });
  } else if (query.data.startsWith('fuel_')) {
    const fuel = query.data.replace('fuel_', '');
    users[chatId].fuelType = fuel;
    await saveJSON(USERS_FILE, users);
    bot.answerCallbackQuery(query.id, { text: `Выбрано: ${fuel.toUpperCase()}` });
  }
});

// ✅ ИСПРАВЛЕНИЕ 7: Только админ может делать /backup и /restore
bot.onText(/\/backup/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ У вас нет прав для выполнения этой команды');
    return;
  }
  
  bot.sendMessage(chatId, '🔄 Начинаю резервное копирование...');
  
  try {
    await backupToDrive();
    bot.sendMessage(chatId, '✅ Бэкап успешно завершён!');
  } catch (error) {
    bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
  }
});

bot.onText(/\/restore/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ У вас нет прав для выполнения этой команды');
    return;
  }
  
  bot.sendMessage(chatId, '🔄 Начинаю восстановление...');
  
  try {
    await restoreFromDrive();
    bot.sendMessage(chatId, '✅ Восстановление успешно завершено!\n\n🔄 Перезапустите бота для применения изменений');
  } catch (error) {
    bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
  }
});

// ========== EXPRESS WEB SERVER ==========

// ✅ ИСПРАВЛЕНИЕ 5: Современный HTML Dashboard
const app = express();
app.use(express.json());

app.get('/', async (req, res) => {
  const stations = await loadJSON(STATIONS_FILE).catch(() => []);
  const database = await loadJSON(DATABASE_FILE, {}).catch(() => ({}));
  const users = await loadJSON(USERS_FILE, {}).catch(() => ({}));
  
  const totalRecords = Object.values(database).reduce((sum, arr) => sum + arr.length, 0);
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000 / 60);
  
  let lastCheck = null;
  for (const entries of Object.values(database)) {
    if (entries.length > 0) {
      const ts = new Date(entries[0].timestamp);
      if (!lastCheck || ts > lastCheck) lastCheck = ts;
    }
  }
  
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⛽ Fuel Tracker Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
    }
    .sidebar {
      width: 250px;
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(10px);
      box-shadow: 2px 0 10px rgba(0,0,0,0.1);
      padding: 20px;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #667eea;
      margin-bottom: 30px;
      text-align: center;
    }
    .nav-item {
      display: block;
      padding: 12px 15px;
      margin-bottom: 10px;
      background: white;
      border-radius: 8px;
      text-decoration: none;
      color: #333;
      transition: all 0.3s;
      box-shadow: 0 2px 5px rgba(0,0,0,0.05);
    }
    .nav-item:hover {
      transform: translateX(5px);
      box-shadow: 0 4px 10px rgba(102, 126, 234, 0.3);
    }
    .main {
      flex: 1;
      padding: 30px;
      overflow-y: auto;
    }
    .header {
      background: white;
      border-radius: 15px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
      text-align: center;
    }
    .header h1 {
      font-size: 2em;
      color: #667eea;
      margin-bottom: 5px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #00cc00;
      font-weight: 500;
    }
    .status::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00cc00;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-card h3 {
      font-size: 2.5em;
      color: #667eea;
      margin-bottom: 5px;
    }
    .stat-card p {
      color: #666;
      font-size: 0.9em;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 25px;
      margin-bottom: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    }
    .card h2 {
      color: #333;
      margin-bottom: 15px;
    }
    .station-item {
      padding: 10px;
      border-bottom: 1px solid #eee;
    }
    .station-item strong {
      color: #667eea;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="logo">⛽ Fuel Tracker</div>
    <a href="/" class="nav-item">📊 Dashboard</a>
    <a href="/database.json" class="nav-item">💾 Database</a>
    <a href="/users.json" class="nav-item">👥 Users</a>
    <a href="/stations.json" class="nav-item">📍 Stations</a>
    <a href="/api/stats" class="nav-item">📈 Stats API</a>
  </div>
  <div class="main">
    <div class="header">
      <h1>⛽ Fuel Price Tracker</h1>
      <div class="status">Online</div>
      <p style="margin-top: 10px; color: #666;">Render.com • Europe/Berlin</p>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <h3>${stations.length}</h3>
        <p>Станций</p>
      </div>
      <div class="stat-card">
        <h3>${totalRecords}</h3>
        <p>Записей в БД</p>
      </div>
      <div class="stat-card">
        <h3>${Object.keys(users).length}</h3>
        <p>Пользователей</p>
      </div>
      <div class="stat-card">
        <h3>${uptime} мин</h3>
        <p>Uptime</p>
      </div>
    </div>
    <div class="card">
      <h2>📍 Станции</h2>
      ${stations.map(s => {
        const latest = database[s.url]?.[0];
        return `
          <div class="station-item">
            <strong>${s.name}</strong>
            ${latest ? `
              <div style="margin-top: 5px; font-size: 0.9em; color: #666;">
                💰 Diesel: ${latest.prices.diesel || 'N/A'}€ | 
                E5: ${latest.prices.e5 || 'N/A'}€ | 
                E10: ${latest.prices.e10 || 'N/A'}€
                <br>
                🕐 ${new Date(latest.timestamp).toLocaleString('de-DE')}
              </div>
            ` : '<div style="color: #999;">Нет данных</div>'}
          </div>
        `;
      }).join('')}
    </div>
    <div class="card">
      <h2>ℹ️ Информация</h2>
      <p><strong>Запущен:</strong> ${serverStartTime.toLocaleString('de-DE')}</p>
      <p><strong>Uptime:</strong> ${uptime} минут</p>
      <p><strong>Последняя проверка:</strong> ${lastCheck ? lastCheck.toLocaleString('de-DE') : 'N/A'}</p>
      <p><strong>Автобэкап:</strong> Каждые 6 часов</p>
      <p><strong>Проверка цен:</strong> Каждые 5 минут (только открытые станции)</p>
    </div>
  </div>
</body>
</html>`);
});

app.get('/database.json', async (req, res) => {
  const data = await loadJSON(DATABASE_FILE, {});
  res.json(data);
});

app.get('/users.json', async (req, res) => {
  const data = await loadJSON(USERS_FILE, {});
  res.json(data);
});

app.get('/stations.json', async (req, res) => {
  const data = await loadJSON(STATIONS_FILE, []);
  res.json(data);
});

app.get('/api/stats', async (req, res) => {
  const stations = await loadJSON(STATIONS_FILE, []);
  const database = await loadJSON(DATABASE_FILE, {});
  const users = await loadJSON(USERS_FILE, {});
  
  const totalRecords = Object.values(database).reduce((sum, arr) => sum + arr.length, 0);
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  
  res.json({
    stations: stations.length,
    totalRecords,
    users: Object.keys(users).length,
    uptimeSeconds: uptime,
    startedAt: serverStartTime.toISOString()
  });
});

app.get('/health', (req, res) => res.send('OK'));

app.get('/check-prices', async (req, res) => {
  const updates = await checkAllPrices();
  res.json({ status: 'success', updates: updates.length });
});

// ============================================================
// ✅ ИСПРАВЛЕНИЕ 8: НАСТРОЙКИ ТАЙМИНГОВ (В КОНЦЕ ФАЙЛА)
// ============================================================

console.log('\n' + '='.repeat(60));
console.log('🚀 FUEL PRICE TRACKER');
console.log('='.repeat(60));
console.log(`🕐 Запущен: ${serverStartTime.toLocaleString('de-DE')}`);
console.log('='.repeat(60) + '\n');

// ✅ ИСПРАВЛЕНИЕ 3: Автобэкап каждые 6 часов
const AUTO_BACKUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 часов

setInterval(async () => {
  try {
    console.log('⏰ Автобэкап (каждые 6 часов)');
    await backupToDrive();
    console.log('✅ Автобэкап завершён успешно');
  } catch (error) {
    console.error('❌ Ошибка автобэкапа:', error.message);
  }
}, AUTO_BACKUP_INTERVAL);

// Первый бэкап через 5 минут после запуска
setTimeout(async () => {
  try {
    console.log('⏰ Первый бэкап после запуска');
    await backupToDrive();
    console.log('✅ Первый бэкап завершён');
  } catch (error) {
    console.error('❌ Ошибка первого бэкапа:', error.message);
  }
}, 5 * 60 * 1000);

// Проверка цен каждые 5 минут
const PRICE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут

setInterval(async () => {
  try {
    await checkAllPrices();
  } catch (error) {
    console.error('❌ Ошибка проверки цен:', error.message);
  }
}, PRICE_CHECK_INTERVAL);

// Восстановление при старте (если включено)
if (process.env.AUTO_RESTORE_ON_START === '1') {
  (async () => {
    try {
      console.log('🔄 Автовосстановление при старте...');
      await restoreFromDrive();
      console.log('✅ Данные восстановлены из Google Drive');
    } catch (error) {
      console.error('⚠️ Автовосстановление не удалось:', error.message);
    }
  })();
}

// Запуск Express сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  console.log(`📍 Dashboard: http://localhost:${PORT}`);
  console.log(`⏰ Проверка цен: каждые ${PRICE_CHECK_INTERVAL / 60000} мин`);
  console.log(`💾 Автобэкап: каждые ${AUTO_BACKUP_INTERVAL / 3600000} часов`);
  console.log(`🤖 Telegram бот активен`);
  console.log(`👤 Админ ID: ${process.env.ADMIN_CHAT_IDS || 'не установлен'}`);
  console.log('='.repeat(60) + '\n');
});
