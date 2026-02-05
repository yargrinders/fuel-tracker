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
  
  // Команда /diagnose - Диагностика Google Drive подключения
  bot.onText(/\/diagnose/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Проверка прав
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
    if (ADMIN_CHAT_ID && chatId.toString() !== ADMIN_CHAT_ID) {
      bot.sendMessage(chatId, '❌ У вас нет прав для выполнения этой команды');
      return;
    }
    
    bot.sendMessage(chatId, '🔍 *Запускаю диагностику Google Drive...*', { parse_mode: 'Markdown' });
    
    let diagnostics = '📋 *ДИАГНОСТИКА GOOGLE DRIVE*\n\n';
    
    // Проверка 1: Environment Variables
    diagnostics += '*1️⃣ Переменные окружения:*\n';
    
    const vars = {
      'GOOGLE_CREDENTIALS': !!process.env.GOOGLE_CREDENTIALS,
      'GOOGLE_CREDENTIALS_BASE64': !!process.env.GOOGLE_CREDENTIALS_BASE64,
      'GDRIVE_KEYFILE': !!process.env.GDRIVE_KEYFILE,
      'GOOGLE_DRIVE_FOLDER_ID': !!process.env.GOOGLE_DRIVE_FOLDER_ID,
      'GDRIVE_FOLDER_ID': !!process.env.GDRIVE_FOLDER_ID
    };
    
    for (const [key, value] of Object.entries(vars)) {
      diagnostics += `  ${value ? '✅' : '❌'} ${key}\n`;
    }
    
    if (process.env.GDRIVE_KEYFILE) {
      diagnostics += `\n  Путь: \`${process.env.GDRIVE_KEYFILE}\`\n`;
    }
    
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.GDRIVE_FOLDER_ID;
    if (folderId) {
      diagnostics += `  Folder ID: \`${folderId}\`\n`;
    }
    
    bot.sendMessage(chatId, diagnostics, { parse_mode: 'Markdown' });
    
    // Проверка 2: Keyfile
    if (process.env.GDRIVE_KEYFILE) {
      const fs = require('fs');
      let keyfileCheck = '\n*2️⃣ Проверка keyfile:*\n';
      
      try {
        const keyfilePath = process.env.GDRIVE_KEYFILE;
        const exists = fs.existsSync(keyfilePath);
        keyfileCheck += `  ${exists ? '✅' : '❌'} Файл существует\n`;
        
        if (exists) {
          const content = fs.readFileSync(keyfilePath, 'utf-8');
          keyfileCheck += `  📏 Размер: ${content.length} байт\n`;
          
          try {
            const json = JSON.parse(content);
            keyfileCheck += '  ✅ JSON валидный\n';
            keyfileCheck += `  📧 Email: \`${json.client_email || 'N/A'}\`\n`;
          } catch {
            keyfileCheck += '  ❌ JSON невалидный\n';
          }
        }
      } catch (error) {
        keyfileCheck += `  ❌ Ошибка: ${error.message}\n`;
      }
      
      bot.sendMessage(chatId, keyfileCheck, { parse_mode: 'Markdown' });
    }
    
    // Проверка 3: Подключение к API
    bot.sendMessage(chatId, '\n*3️⃣ Подключение к Google Drive API:*\n_Тестирую..._', { parse_mode: 'Markdown' });
    
    try {
      const success = await googleDriveBackup.initialize();
      
      if (success) {
        bot.sendMessage(chatId, '✅ *Подключение успешно!*', { parse_mode: 'Markdown' });
        
        // Проверка 4: Доступ к папке
        bot.sendMessage(chatId, '\n*4️⃣ Доступ к папке:*\n_Проверяю..._', { parse_mode: 'Markdown' });
        
        try {
          const files = await googleDriveBackup.getBackupInfo();
          
          if (files !== null) {
            let folderInfo = '✅ *Доступ к папке получен!*\n\n';
            folderInfo += `Файлов в папке: ${files.length}\n\n`;
            
            if (files.length > 0) {
              folderInfo += '*Список файлов:*\n';
              files.forEach((file, i) => {
                folderInfo += `${i + 1}. ${file.name} (${file.size})\n`;
              });
            } else {
              folderInfo += '_Папка пуста_\n';
            }
            
            bot.sendMessage(chatId, folderInfo, { parse_mode: 'Markdown' });
            
            // Проверка 5: Тест записи
            bot.sendMessage(chatId, '\n*5️⃣ Тест записи:*\n_Пытаюсь создать тестовый файл..._', { parse_mode: 'Markdown' });
            
            const fs = require('fs').promises;
            const testFile = '/tmp/test-backup.json';
            await fs.writeFile(testFile, JSON.stringify({ test: true, timestamp: new Date() }));
            
            const uploadResult = await googleDriveBackup.uploadFile(testFile, 'test-backup.json');
            
            if (uploadResult) {
              bot.sendMessage(chatId, '✅ *Тест записи успешен!*\n\n_Google Drive полностью работает!_', { parse_mode: 'Markdown' });
            } else {
              bot.sendMessage(chatId, '❌ *Тест записи не удался*\n\n_Проверьте права Service Account на папку_', { parse_mode: 'Markdown' });
            }
          } else {
            bot.sendMessage(chatId, '❌ *Не удалось получить доступ к папке*\n\n_Возможно Service Account не имеет прав_', { parse_mode: 'Markdown' });
          }
        } catch (error) {
          bot.sendMessage(chatId, `❌ *Ошибка доступа к папке:*\n\`${error.message}\``, { parse_mode: 'Markdown' });
        }
      } else {
        bot.sendMessage(chatId, '❌ *Подключение не удалось*\n\n_Проверьте credentials и переменные окружения_', { parse_mode: 'Markdown' });
      }
    } catch (error) {
      bot.sendMessage(chatId, `❌ *Критическая ошибка:*\n\`${error.message}\``, { parse_mode: 'Markdown' });
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
  
  console.log('\n' + '='.repeat(60));
  console.log('🔍 ДИАГНОСТИКА GOOGLE DRIVE - ЗАПУСК');
  console.log('='.repeat(60));
  
  // Шаг 1: Проверка переменных окружения
  console.log('\n📋 Шаг 1: Проверка переменных окружения');
  console.log('-'.repeat(60));
  
  const hasGoogleCreds = !!process.env.GOOGLE_CREDENTIALS;
  const hasGoogleCredsB64 = !!process.env.GOOGLE_CREDENTIALS_BASE64;
  const hasGdriveKeyfile = !!process.env.GDRIVE_KEYFILE;
  const hasGoogleFolderId = !!process.env.GOOGLE_DRIVE_FOLDER_ID;
  const hasGdriveFolderId = !!process.env.GDRIVE_FOLDER_ID;
  
  console.log(`GOOGLE_CREDENTIALS: ${hasGoogleCreds ? '✅ Найдена' : '❌ Не найдена'}`);
  console.log(`GOOGLE_CREDENTIALS_BASE64: ${hasGoogleCredsB64 ? '✅ Найдена' : '❌ Не найдена'}`);
  console.log(`GDRIVE_KEYFILE: ${hasGdriveKeyfile ? '✅ Найдена' : '❌ Не найдена'}`);
  
  if (hasGdriveKeyfile) {
    console.log(`  └─ Путь: ${process.env.GDRIVE_KEYFILE}`);
  }
  
  console.log(`GOOGLE_DRIVE_FOLDER_ID: ${hasGoogleFolderId ? '✅ Найдена' : '❌ Не найдена'}`);
  console.log(`GDRIVE_FOLDER_ID: ${hasGdriveFolderId ? '✅ Найдена' : '❌ Не найдена'}`);
  
  if (hasGoogleFolderId) {
    console.log(`  └─ ID: ${process.env.GOOGLE_DRIVE_FOLDER_ID}`);
  } else if (hasGdriveFolderId) {
    console.log(`  └─ ID: ${process.env.GDRIVE_FOLDER_ID}`);
  }
  
  // Шаг 2: Проверка доступа к keyfile (если используется)
  if (hasGdriveKeyfile) {
    console.log('\n📄 Шаг 2: Проверка доступа к keyfile');
    console.log('-'.repeat(60));
    
    const keyfilePath = process.env.GDRIVE_KEYFILE;
    const fs = require('fs');
    
    try {
      const fileExists = fs.existsSync(keyfilePath);
      console.log(`Файл существует: ${fileExists ? '✅ Да' : '❌ Нет'}`);
      
      if (fileExists) {
        const fileContent = fs.readFileSync(keyfilePath, 'utf-8');
        console.log(`Размер файла: ${fileContent.length} байт`);
        
        try {
          const json = JSON.parse(fileContent);
          console.log('JSON валидный: ✅ Да');
          console.log(`  ├─ type: ${json.type || '❌ отсутствует'}`);
          console.log(`  ├─ project_id: ${json.project_id || '❌ отсутствует'}`);
          console.log(`  ├─ client_email: ${json.client_email || '❌ отсутствует'}`);
          console.log(`  └─ private_key: ${json.private_key ? '✅ присутствует' : '❌ отсутствует'}`);
        } catch (parseError) {
          console.log('JSON валидный: ❌ Нет');
          console.log(`  └─ Ошибка: ${parseError.message}`);
        }
      }
    } catch (error) {
      console.log(`❌ Ошибка чтения файла: ${error.message}`);
    }
  }
  
  // Шаг 3: Попытка инициализации Google Drive
  console.log('\n🔌 Шаг 3: Подключение к Google Drive API');
  console.log('-'.repeat(60));
  
  try {
    const initResult = await googleDriveBackup.initialize();
    
    if (initResult) {
      console.log('✅ Подключение успешно!');
      
      // Шаг 4: Тест доступа к папке
      console.log('\n📁 Шаг 4: Проверка доступа к папке');
      console.log('-'.repeat(60));
      
      try {
        const files = await googleDriveBackup.getBackupInfo();
        
        if (files !== null) {
          console.log(`✅ Доступ к папке получен!`);
          console.log(`Найдено файлов в папке: ${files.length}`);
          
          if (files.length > 0) {
            console.log('\nСписок файлов:');
            files.forEach((file, i) => {
              console.log(`  ${i + 1}. ${file.name} (${file.size})`);
            });
          } else {
            console.log('📝 Папка пуста (это нормально для первого запуска)');
          }
        } else {
          console.log('❌ Не удалось получить список файлов');
        }
      } catch (error) {
        console.log(`❌ Ошибка доступа к папке: ${error.message}`);
      }
    } else {
      console.log('❌ Подключение не удалось');
      console.log('   Смотри ошибки выше для диагностики');
    }
  } catch (error) {
    console.log(`❌ Критическая ошибка: ${error.message}`);
    console.error('Stack trace:', error.stack);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🏁 ДИАГНОСТИКА ЗАВЕРШЕНА');
  console.log('='.repeat(60) + '\n');
  
  // Теперь пытаемся восстановить данные
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
