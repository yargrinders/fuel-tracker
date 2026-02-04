require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

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

// Проверка работает ли станция в данное время
function isStationOpen(station, timestamp = new Date()) {
  if (!station.openingHours) return true; // Если нет расписания, считаем что работает
  if (station.openingHours.is24h) return true; // Круглосуточно
  
  const day = timestamp.getDay(); // 0 = воскресенье, 1 = понедельник, ...
  const hour = timestamp.getHours();
  const minute = timestamp.getMinutes();
  const currentTime = hour * 60 + minute; // Минуты с начала дня
  
  let schedule;
  if (day === 0) {
    // Воскресенье
    schedule = station.openingHours.sun;
  } else if (day === 6) {
    // Суббота
    schedule = station.openingHours.sat;
  } else {
    // Понедельник-Пятница
    schedule = station.openingHours.monFri;
  }
  
  if (!schedule) return true;
  
  // Парсим расписание "6:00-22:00"
  const match = schedule.match(/(\d+):(\d+)-(\d+):(\d+)/);
  if (!match) return true;
  
  const openHour = parseInt(match[1]);
  const openMinute = parseInt(match[2]);
  const closeHour = parseInt(match[3]);
  const closeMinute = parseInt(match[4]);
  
  const openTime = openHour * 60 + openMinute;
  const closeTime = closeHour * 60 + closeMinute;
  
  const isOpen = currentTime >= openTime && currentTime < closeTime;
  
  if (!isOpen) {
    console.log(`  ⏰ Станция ${station.name} закрыта (${schedule})`);
  }
  
  return isOpen;
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

    console.log(`\n🔍 Парсинг станции ${stationId} - ${stationName}`);

    // ОСНОВНОЙ МЕТОД: Ищем div.price-field с current-price + suffix-price
    $('.price-field').each((i, priceField) => {
      const fieldHtml = $(priceField).html();
      const fieldText = $(priceField).text().toLowerCase();
      
      // Извлекаем основную цену (current-price-X)
      const currentPriceSpan = $(priceField).find('span[id^="current-price"]').first();
      let currentPrice = currentPriceSpan.text().trim();
      
      // Извлекаем дробную часть (suffix-price-X) - обычно "9"
      const suffixPriceSpan = $(priceField).find('sup[id^="suffix-price"]').first();
      let suffixPrice = suffixPriceSpan.text().trim();
      
      // Комбинируем: 1.77 + .9 = 1.779
      if (currentPrice) {
        let fullPrice = currentPrice.replace(',', '.');
        
        // Добавляем suffix если есть
        if (suffixPrice) {
          // Убираем точку если она есть в suffix (.9 → 9)
          suffixPrice = suffixPrice.replace('.', '');
          fullPrice = fullPrice + suffixPrice;
        }
        
        const price = parseFloat(fullPrice);
        
        if (!isNaN(price) && price > 0 && price < 3) {
          // Определяем тип топлива по тексту в родительских элементах
          const parentText = $(priceField).parent().text().toLowerCase();
          const allText = fieldText + ' ' + parentText;
          
          if (!prices.diesel && (allText.includes('diesel') || allText.includes('дизель'))) {
            prices.diesel = price;
            console.log(`  ✓ Diesel: ${price}€ (current: ${currentPrice}, suffix: ${suffixPrice})`);
          } else if (!prices.e5 && (allText.includes('super e5') || allText.includes('e 5') || allText.includes('super 95'))) {
            prices.e5 = price;
            console.log(`  ✓ E5: ${price}€ (current: ${currentPrice}, suffix: ${suffixPrice})`);
          } else if (!prices.e10 && (allText.includes('super e10') || allText.includes('e 10'))) {
            prices.e10 = price;
            console.log(`  ✓ E10: ${price}€ (current: ${currentPrice}, suffix: ${suffixPrice})`);
          }
        }
      }
    });

    // ДОПОЛНИТЕЛЬНЫЙ МЕТОД: Если не нашли, ищем все span отдельно
    if (!prices.diesel || !prices.e5 || !prices.e10) {
      console.log('  → Пробую дополнительный поиск...');
      
      // Группируем current-price и suffix-price по номеру
      const priceMap = {};
      
      $('span[id^="current-price"]').each((i, span) => {
        const id = $(span).attr('id');
        const num = id.match(/\d+$/)?.[0];
        if (num) {
          if (!priceMap[num]) priceMap[num] = {};
          priceMap[num].current = $(span).text().trim();
        }
      });
      
      $('sup[id^="suffix-price"]').each((i, sup) => {
        const id = $(sup).attr('id');
        const num = id.match(/\d+$/)?.[0];
        if (num) {
          if (!priceMap[num]) priceMap[num] = {};
          priceMap[num].suffix = $(sup).text().trim().replace('.', '');
        }
      });
      
      // Собираем полные цены
      Object.values(priceMap).forEach((priceData, idx) => {
        if (!priceData.current) return;
        
        let fullPrice = priceData.current.replace(',', '.');
        if (priceData.suffix) {
          fullPrice = fullPrice + priceData.suffix;
        }
        
        const price = parseFloat(fullPrice);
        if (isNaN(price)) return;
        
        // Определяем тип топлива по порядку (обычно Diesel, E10, E5)
        if (!prices.diesel && idx === 0) {
          prices.diesel = price;
          console.log(`  ✓ Diesel: ${price}€ (дополнительный метод)`);
        } else if (!prices.e10 && idx === 1) {
          prices.e10 = price;
          console.log(`  ✓ E10: ${price}€ (дополнительный метод)`);
        } else if (!prices.e5 && idx === 2) {
          prices.e5 = price;
          console.log(`  ✓ E5: ${price}€ (дополнительный метод)`);
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

// Проверка цен на всех станциях
async function checkAllPrices() {
  console.log('🔍 Checking prices...');
  
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  const updates = [];
  const now = new Date();
  
  for (const station of stations) {
    // ПРОВЕРКА ЧАСОВ РАБОТЫ
    if (!isStationOpen(station, now)) {
      console.log(`  ⏭️ Пропускаем ${station.name} (закрыта)`);
      continue; // Пропускаем закрытую станцию
    }
    
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
    
    // ОПТИМИЗАЦИЯ: Храним только последние 2 недели данных
    const TWO_WEEKS_IN_MS = 14 * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - TWO_WEEKS_IN_MS);
    
    database[station.url] = database[station.url].filter(entry => {
      return new Date(entry.timestamp) > cutoffDate;
    });
    
    // Лог об очистке
    if (database[station.url].length > 0) {
      console.log(`  🧹 Station ${station.name}: Хранится ${database[station.url].length} записей (последние 2 недели)`);
    }
    
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
    // Отправляем уведомления каждому подписанному пользователю
    for (const [chatId, userData] of Object.entries(users)) {
      if (!userData.notifications) continue;
      
      // Инициализация lastAlerts если нет
      if (!userData.lastAlerts) {
        userData.lastAlerts = {};
      }
      if (!userData.lastAlerts[update.url]) {
        userData.lastAlerts[update.url] = { diesel: null, e5: null, e10: null };
      }
      
      const alerts = [];
      const currentPrices = update.prices;
      const lastAlert = userData.lastAlerts[update.url];
      
      // Проверка целевых цен
      if (userData.targets) {
        // DIESEL
        if (userData.targets.diesel && currentPrices.diesel) {
          if (currentPrices.diesel <= userData.targets.diesel) {
            // Проверка: отправляли ли уже алерт для этой или более низкой цены
            if (!lastAlert.diesel || currentPrices.diesel < lastAlert.diesel) {
              alerts.push(`🎯 DIESEL достиг целевой цены!\n💰 ${currentPrices.diesel}€ (цель: ${userData.targets.diesel}€)`);
              lastAlert.diesel = currentPrices.diesel;
            }
          } else {
            // Цена выше цели - сбрасываем lastAlert
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
      
      // Уведомления об изменениях (если включены)
      if (userData.notifyChanges && update.changes.length > 0) {
        alerts.push(`📊 ${update.name}\n${update.changes.join('\n')}`);
      }
      
      // Отправка уведомлений
      for (const alert of alerts) {
        try {
          await bot.sendMessage(chatId, `⛽ *${update.name}*\n\n${alert}`, { parse_mode: 'Markdown' });
          console.log(`  📬 Уведомление отправлено пользователю ${chatId}`);
        } catch (error) {
          console.error(`Failed to notify ${chatId}:`, error.message);
        }
      }
    }
  }
  
  // Сохраняем обновлённые lastAlerts
  await saveJSON(USERS_FILE, users);
}

// Анализ лучшего времени для заправки
async function analyzeWeeklyPatterns(stationUrl, fuelType = 'diesel') {
  const database = await loadJSON(DATABASE_FILE, {});
  const allHistory = database[stationUrl] || [];
  
  // Фильтруем только последние 7 дней для аналитики
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekAgo = new Date(Date.now() - ONE_WEEK_MS);
  
  const history = allHistory.filter(entry => {
    return new Date(entry.timestamp) > weekAgo;
  });
  
  if (history.length < 20) {
    return { error: 'Недостаточно данных (минимум 20 записей за неделю)' };
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
    totalObservations: history.length,
    period: '7 дней'
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
    '📊 *Основные команды:*\n' +
    '/prices - Актуальные цены (live)\n' +
    '/cached - Последние известные цены\n' +
    '/check - Проверить сейчас\n' +
    '/analytics - Анализ лучшего времени\n' +
    '/stats - Статистика базы данных\n\n' +
    '🎯 *Алерты:*\n' +
    '/settarget - Установить целевую цену\n' +
    '/settings - Настройки\n\n' +
    '/help - Подробная помощь',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/prices/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Отправляем сообщение что проверяем
  const waitMsg = await bot.sendMessage(chatId, '🔄 Проверяю актуальные цены...');
  
  // Принудительно обновляем цены
  await checkAllPrices();
  
  // Загружаем обновлённые данные
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  let message = '⛽ *Актуальные цены:*\n\n';
  
  for (const station of stations) {
    const latest = database[station.url]?.[0];
    if (latest) {
      // Формат: Station ID - NAME
      message += `📍 *Station ${latest.id} - ${station.name}*\n`;
      message += `   _${new Date(latest.timestamp).toLocaleString('ru-RU')}_\n`;
      
      // Показываем цены если есть
      if (latest.prices.diesel) message += `   💰 Diesel: ${latest.prices.diesel}€\n`;
      if (latest.prices.e5) message += `   💰 E5: ${latest.prices.e5}€\n`;
      if (latest.prices.e10) message += `   💰 E10: ${latest.prices.e10}€\n`;
      
      message += '\n';
    } else {
      // Если нет данных
      const stationId = station.url.match(/\/(\d+)$/)?.[1];
      message += `📍 *Station ${stationId} - ${station.name}*\n`;
      message += `   _Нет данных_\n\n`;
    }
  }
  
  // Удаляем сообщение "проверяю..." и отправляем результат
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

bot.onText(/\/cached/, async (msg) => {
  const stations = await loadJSON(STATIONS_FILE);
  const database = await loadJSON(DATABASE_FILE, {});
  
  let message = '💾 *Последние известные цены:*\n_Без обновления с сайта_\n\n';
  
  for (const station of stations) {
    const latest = database[station.url]?.[0];
    if (latest) {
      const timestamp = new Date(latest.timestamp);
      const ageMinutes = Math.floor((Date.now() - timestamp.getTime()) / 60000);
      
      message += `📍 *Station ${latest.id} - ${station.name}*\n`;
      message += `   _${timestamp.toLocaleString('ru-RU')} (${ageMinutes} мин назад)_\n`;
      
      if (latest.prices.diesel) message += `   💰 Diesel: ${latest.prices.diesel}€\n`;
      if (latest.prices.e5) message += `   💰 E5: ${latest.prices.e5}€\n`;
      if (latest.prices.e10) message += `   💰 E10: ${latest.prices.e10}€\n`;
      
      message += '\n';
    }
  }
  
  message += '💡 Для актуальных цен используй `/prices`';
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
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
  let message = `📊 *Анализ лучшего времени для заправки*\n_Топливо: ${fuelType.toUpperCase()}, Период: 7 дней_\n\n`;
  
  for (const station of stations) {
    const analysis = await analyzeWeeklyPatterns(station.url, fuelType);
    
    if (analysis.error) {
      message += `📍 *${station.name}*\n${analysis.error}\n\n`;
      continue;
    }
    
    message += `📍 *${station.name}*\n`;
    message += `📈 Наблюдений: ${analysis.totalObservations} (${analysis.period})\n\n`;
    
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
  
  message += '💡 _Данные за последние 7 дней (хранится 14 дней)_';
  
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
    '`/check` - Немедленно проверить цены\n' +
    '`/analytics` - Анализ лучшего времени за неделю\n' +
    '`/stats` - Статистика по базе данных\n\n' +
    '*Настройка алертов:*\n' +
    '`/settarget diesel 1.76` - Уведомить при цене ≤ 1.76€\n' +
    '`/settarget e5 1.80` - Уведомить при цене ≤ 1.80€\n\n' +
    '*Как это работает:*\n' +
    '1️⃣ Бот проверяет цены каждые 5 минут\n' +
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
  
  const ageInDays = Math.floor((newestDate - oldestDate) / (1000 * 60 * 60 * 24));
  const dbSize = JSON.stringify(database).length / 1024; // KB
  
  message += `\n📈 *Общая статистика:*\n`;
  message += `Всего записей: ${totalEntries}\n`;
  message += `Период данных: ${ageInDays} дней\n`;
  message += `Размер БД: ${dbSize.toFixed(2)} KB\n\n`;
  
  message += `🧹 *Автоочистка:* последние 14 дней\n`;
  message += `💾 *Render Free Tier:* 512 MB RAM`;
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// HTTP endpoint для UptimeRobot
const express = require('express');
// const app = express();

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

// HTTP endpoint для UptimeRobot и веб-интерфейс
// const express = require('express');
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public')); // Для статических файлов

// Главная страница - Dashboard
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⛽ Fuel Price Tracker - Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
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
      font-size: 2.5em;
      color: #667eea;
      margin-bottom: 10px;
    }
    
    .header p {
      color: #666;
      font-size: 1.1em;
    }
    
    .status {
      background: white;
      border-radius: 15px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }
    
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    
    .status-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 10px;
      text-align: center;
    }
    
    .status-card h3 {
      font-size: 2em;
      margin-bottom: 5px;
    }
    
    .status-card p {
      opacity: 0.9;
    }
    
    .actions {
      background: white;
      border-radius: 15px;
      padding: 30px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    
    .actions h2 {
      margin-bottom: 20px;
      color: #333;
    }
    
    .btn-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
    }
    
    .btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 15px 25px;
      border-radius: 8px;
      font-size: 1em;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      text-decoration: none;
      display: inline-block;
      text-align: center;
    }
    
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }
    
    .btn:active {
      transform: translateY(0);
    }
    
    .logs {
      background: #1e1e1e;
      color: #00ff00;
      border-radius: 15px;
      padding: 20px;
      font-family: 'Courier New', monospace;
      max-height: 400px;
      overflow-y: auto;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }
    
    .logs h2 {
      color: #00ff00;
      margin-bottom: 15px;
    }
    
    .log-entry {
      margin: 5px 0;
      padding: 5px;
      border-left: 3px solid #00ff00;
      padding-left: 10px;
    }
    
    .footer {
      text-align: center;
      color: white;
      margin-top: 30px;
      opacity: 0.8;
    }
    
    .online {
      display: inline-block;
      width: 12px;
      height: 12px;
      background: #00ff00;
      border-radius: 50%;
      animation: pulse 2s infinite;
      margin-right: 8px;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⛽ Fuel Price Tracker</h1>
      <p><span class="online"></span>Бот активен и работает</p>
      <p style="margin-top: 10px; font-size: 0.9em;">Render.com • Port 3000</p>
    </div>
    
    <div class="status">
      <h2>📊 Статистика</h2>
      <div class="status-grid">
        <div class="status-card">
          <h3 id="stations-count">-</h3>
          <p>Отслеживаемых станций</p>
        </div>
        <div class="status-card">
          <h3 id="last-check">-</h3>
          <p>Последняя проверка</p>
        </div>
        <div class="status-card">
          <h3 id="total-records">-</h3>
          <p>Записей в БД</p>
        </div>
        <div class="status-card">
          <h3 id="uptime">-</h3>
          <p>Время работы</p>
        </div>
      </div>
    </div>
    
    <div class="actions">
      <h2>🎮 Управление</h2>
      <div class="btn-grid">
        <button class="btn" onclick="checkPrices()">🔍 Проверить цены</button>
        <button class="btn" onclick="getStats()">📊 Статистика БД</button>
        <button class="btn" onclick="getLogs()">📋 Показать логи</button>
        <a href="/api/stations" class="btn">📍 Список станций</a>
        <a href="/api/health" class="btn">💚 Health Check</a>
        <a href="https://t.me/YOUR_BOT_USERNAME" class="btn" target="_blank">💬 Открыть бота</a>
      </div>
    </div>
    
    <div class="logs">
      <h2>📋 Последние логи</h2>
      <div id="logs-container">
        <div class="log-entry">[INFO] Загрузка логов...</div>
      </div>
    </div>
    
    <div class="footer">
      <p>Made with ❤️ for smart fuel tracking</p>
      <p style="margin-top: 10px; font-size: 0.9em;">Telegram Bot • Node.js • Render.com</p>
    </div>
  </div>
  
  <script>
    const startTime = Date.now();
    
    // Обновление статистики
    async function updateStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        
        document.getElementById('stations-count').textContent = data.stationsCount;
        document.getElementById('total-records').textContent = data.totalRecords;
        document.getElementById('last-check').textContent = data.lastCheck ? 
          new Date(data.lastCheck).toLocaleTimeString('ru-RU') : 'Нет данных';
      } catch (error) {
        console.error('Error fetching stats:', error);
      }
    }
    
    // Обновление времени работы
    function updateUptime() {
      const uptime = Math.floor((Date.now() - startTime) / 1000 / 60);
      document.getElementById('uptime').textContent = uptime + ' мин';
    }
    
    // Проверка цен
    async function checkPrices() {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '⏳ Проверяю...';
      
      try {
        const response = await fetch('/check-prices');
        const data = await response.json();
        
        alert('✅ Проверка завершена!\\n' + 
              'Обновлено станций: ' + (data.updates || 0));
        
        await updateStats();
        await getLogs();
      } catch (error) {
        alert('❌ Ошибка: ' + error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Проверить цены';
      }
    }
    
    // Получение статистики
    async function getStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        
        alert('📊 Статистика БД:\\n\\n' +
              'Станций: ' + data.stationsCount + '\\n' +
              'Записей: ' + data.totalRecords + '\\n' +
              'Размер: ' + (data.dbSize / 1024).toFixed(2) + ' KB\\n' +
              'Период: ' + data.period + ' дней');
      } catch (error) {
        alert('❌ Ошибка: ' + error.message);
      }
    }
    
    // Получение логов
    async function getLogs() {
      try {
        const response = await fetch('/api/logs');
        const data = await response.json();
        
        const container = document.getElementById('logs-container');
        container.innerHTML = data.logs.map(log => 
          '<div class="log-entry">' + log + '</div>'
        ).join('');
      } catch (error) {
        console.error('Error fetching logs:', error);
      }
    }
    
    // Автообновление
    setInterval(updateStats, 30000); // Каждые 30 секунд
    setInterval(updateUptime, 10000); // Каждые 10 секунд
    setInterval(getLogs, 60000); // Каждую минуту
    
    // Начальная загрузка
    updateStats();
    updateUptime();
    getLogs();
  </script>
</body>
</html>
  `);
});

// Health check для UptimeRobot
app.get('/health', (req, res) => {
  res.send('OK');
});

// Health check для UptimeRobot
app.get('/health', (req, res) => {
  res.send('OK');
});

// API: Статистика
app.get('/api/stats', async (req, res) => {
  try {
    const stations = await loadJSON(STATIONS_FILE);
    const database = await loadJSON(DATABASE_FILE, {});
    
    let totalRecords = 0;
    let lastCheck = null;
    
    for (const station of stations) {
      const entries = database[station.url] || [];
      totalRecords += entries.length;
      
      if (entries.length > 0) {
        const latestTimestamp = new Date(entries[0].timestamp);
        if (!lastCheck || latestTimestamp > lastCheck) {
          lastCheck = latestTimestamp;
        }
      }
    }
    
    const dbSize = JSON.stringify(database).length;
    const oldestEntry = Object.values(database)
      .flatMap(entries => entries)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];
    
    const period = oldestEntry ? 
      Math.floor((Date.now() - new Date(oldestEntry.timestamp)) / (1000 * 60 * 60 * 24)) : 0;
    
    res.json({
      stationsCount: stations.length,
      totalRecords,
      lastCheck: lastCheck ? lastCheck.toISOString() : null,
      dbSize,
      period
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Список станций
app.get('/api/stations', async (req, res) => {
  try {
    const stations = await loadJSON(STATIONS_FILE);
    const database = await loadJSON(DATABASE_FILE, {});
    
    const stationsWithPrices = stations.map(station => {
      const latest = database[station.url]?.[0];
      return {
        name: station.name,
        url: station.url,
        openingHours: station.openingHours,
        isOpen: isStationOpen(station),
        latestPrices: latest ? latest.prices : null,
        lastUpdate: latest ? latest.timestamp : null
      };
    });
    
    res.json(stationsWithPrices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Логи (последние 50 строк)
const recentLogs = [];
const originalConsoleLog = console.log;
console.log = function(...args) {
  const message = args.join(' ');
  recentLogs.push('[' + new Date().toLocaleTimeString('ru-RU') + '] ' + message);
  if (recentLogs.length > 50) recentLogs.shift();
  originalConsoleLog.apply(console, args);
};

app.get('/api/logs', (req, res) => {
  res.json({ logs: recentLogs });
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🤖 Bot started');
  
  // Первая проверка при запуске
  checkAllPrices();
});

// Автоматическая проверка каждые 30 минут (на всякий случай)
setInterval(checkAllPrices, 10 * 60 * 1000);
