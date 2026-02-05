// backup-commands.js - Команды бэкапа для Telegram бота
const path = require('path');
const googleDriveBackup = require('./google-drive-backup');

// Пути к файлам
const STATIONS_FILE = path.join(__dirname, 'stations.json');
const DATABASE_FILE = path.join(__dirname, 'database.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Список файлов для бэкапа
const BACKUP_FILES = [
  { localPath: DATABASE_FILE, remoteName: 'database.json' },
  { localPath: USERS_FILE, remoteName: 'users.json' },
  { localPath: STATIONS_FILE, remoteName: 'stations.json' }
];

// Регистрация команд в боте
function registerBackupCommands(bot) {
  
  // Команда /backup - Ручное сохранение в Google Drive
  bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Проверка прав (только для владельца бота)
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
    if (ADMIN_CHAT_ID && chatId.toString() !== ADMIN_CHAT_ID) {
      bot.sendMessage(chatId, '❌ У вас нет прав для выполнения этой команды');
      return;
    }
    
    bot.sendMessage(chatId, '🔄 Начинаю резервное копирование в Google Drive...');
    
    try {
      const result = await googleDriveBackup.backupAll(BACKUP_FILES);
      
      if (result.success) {
        let message = '✅ *Бэкап успешно завершён!*\n\n';
        message += `📊 Загружено файлов: ${result.successCount}\n`;
        message += `🕐 Время: ${result.timestamp}\n\n`;
        message += '*Файлы:*\n';
        result.results.forEach(r => {
          message += `• ${r.file} - ${r.status === 'success' ? '✅' : '❌'}\n`;
        });
        message += '\n💾 Данные сохранены в Google Drive';
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, 
          `❌ Бэкап завершён с ошибками\n\n` +
          `Успешно: ${result.successCount}\n` +
          `Ошибок: ${result.failCount}\n\n` +
          `Проверьте логи для деталей`
        );
      }
    } catch (error) {
      console.error('Ошибка бэкапа:', error);
      bot.sendMessage(chatId, '❌ Ошибка при создании бэкапа: ' + error.message);
    }
  });
  
  // Команда /restore - Восстановление из Google Drive
  bot.onText(/\/restore/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Проверка прав
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
    if (ADMIN_CHAT_ID && chatId.toString() !== ADMIN_CHAT_ID) {
      bot.sendMessage(chatId, '❌ У вас нет прав для выполнения этой команды');
      return;
    }
    
    bot.sendMessage(chatId, '🔄 Начинаю восстановление из Google Drive...');
    
    try {
      const result = await googleDriveBackup.restoreAll(BACKUP_FILES);
      
      if (result.success) {
        let message = '✅ *Восстановление успешно завершено!*\n\n';
        message += `📊 Восстановлено файлов: ${result.successCount}\n`;
        message += `🕐 Время: ${result.timestamp}\n\n`;
        message += '*Файлы:*\n';
        result.results.forEach(r => {
          message += `• ${r.file} - ${r.status === 'success' ? '✅' : '❌'}\n`;
        });
        message += '\n🔄 Перезапустите бота для применения изменений';
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, 
          `❌ Восстановление завершено с ошибками\n\n` +
          `Успешно: ${result.successCount}\n` +
          `Ошибок: ${result.failCount}\n\n` +
          `Проверьте логи для деталей`
        );
      }
    } catch (error) {
      console.error('Ошибка восстановления:', error);
      bot.sendMessage(chatId, '❌ Ошибка при восстановлении: ' + error.message);
    }
  });
  
  // Команда /backupinfo - Информация о бэкапах
  bot.onText(/\/backupinfo/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, '🔍 Получаю информацию о бэкапах...');
    
    try {
      const files = await googleDriveBackup.getBackupInfo();
      
      if (!files) {
        bot.sendMessage(chatId, '❌ Не удалось получить информацию о бэкапах');
        return;
      }
      
      if (files.length === 0) {
        bot.sendMessage(chatId, '📁 Бэкапы не найдены в Google Drive');
        return;
      }
      
      let message = '📁 *Информация о бэкапах в Google Drive:*\n\n';
      files.forEach(file => {
        message += `📄 *${file.name}*\n`;
        message += `   Обновлён: ${file.lastModified}\n`;
        message += `   Размер: ${file.size}\n\n`;
      });
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Ошибка получения информации:', error);
      bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
    }
  });
}

// Автоматический бэкап (каждые 24 часа)
async function startAutoBackup() {
  console.log('🔄 Запуск автоматического бэкапа (каждые 24 часа)');
  
  // Функция для выполнения бэкапа
  const performBackup = async () => {
    try {
      console.log('⏰ Автоматический бэкап запущен');
      const result = await googleDriveBackup.backupAll(BACKUP_FILES);
      
      if (result.success) {
        console.log(`✅ Автобэкап успешен: ${result.successCount} файлов`);
      } else {
        console.error(`❌ Автобэкап с ошибками: ${result.failCount} ошибок`);
      }
    } catch (error) {
      console.error('❌ Ошибка автобэкапа:', error.message);
    }
  };
  
  // Первый бэкап через 5 минут после запуска
  setTimeout(performBackup, 5 * 60 * 1000);
  
  // Затем каждые 24 часа
  setInterval(performBackup, 24 * 60 * 60 * 1000);
}

// Восстановление при старте (если нет локальных файлов)
async function autoRestoreOnStart() {
  const fs = require('fs').promises;
  
  try {
    // Проверяем существует ли database.json
    try {
      await fs.access(DATABASE_FILE);
      console.log('✅ database.json найден локально');
      return; // Файл есть, восстановление не нужно
    } catch {
      console.log('⚠️ database.json не найден, пытаюсь восстановить из Google Drive...');
    }
    
    // Пытаемся восстановить из Google Drive
    const result = await googleDriveBackup.restoreAll(BACKUP_FILES);
    
    if (result.success) {
      console.log('✅ Данные успешно восстановлены из Google Drive');
    } else {
      console.log('⚠️ Восстановление завершено с ошибками, используем значения по умолчанию');
    }
  } catch (error) {
    console.error('❌ Ошибка авто-восстановления:', error.message);
  }
}

module.exports = {
  registerBackupCommands,
  startAutoBackup,
  autoRestoreOnStart,
  BACKUP_FILES
};
