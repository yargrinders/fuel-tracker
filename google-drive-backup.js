// google-drive-backup.js - Модуль для работы с Google Drive
const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

class GoogleDriveBackup {
  constructor() {
    this.drive = null;
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    this.initialized = false;
  }

  // Инициализация Google Drive API
  async initialize() {
    if (this.initialized) return true;

    try {
      // Получение credentials из переменной окружения
      let credentials;
      
      // Проверяем все возможные варианты имён переменных
      if (process.env.GOOGLE_CREDENTIALS) {
        // Способ 1: Прямой JSON
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      } else if (process.env.GOOGLE_CREDENTIALS_BASE64) {
        // Способ 2: Base64
        const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8');
        credentials = JSON.parse(decoded);
      } else if (process.env.GDRIVE_KEYFILE) {
        // Способ 3: GDRIVE_KEYFILE (твой вариант из Render)
        try {
          // Пытаемся прочитать как путь к файлу
          const keyfilePath = process.env.GDRIVE_KEYFILE;
          if (keyfilePath.startsWith('/etc/secrets/')) {
            const fs = require('fs');
            const fileContent = fs.readFileSync(keyfilePath, 'utf-8');
            credentials = JSON.parse(fileContent);
          } else {
            // Или как прямой JSON
            credentials = JSON.parse(process.env.GDRIVE_KEYFILE);
          }
        } catch (error) {
          console.error('❌ Ошибка чтения GDRIVE_KEYFILE:', error.message);
          return false;
        }
      } else {
        console.error('❌ Google Drive credentials не найдены в environment variables');
        console.error('   Ожидается: GOOGLE_CREDENTIALS, GOOGLE_CREDENTIALS_BASE64 или GDRIVE_KEYFILE');
        return false;
      }

      // Получение folder ID (проверяем оба варианта)
      this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.GDRIVE_FOLDER_ID;
      
      if (!this.folderId) {
        console.error('❌ Folder ID не установлен');
        console.error('   Ожидается: GOOGLE_DRIVE_FOLDER_ID или GDRIVE_FOLDER_ID');
        return false;
      }

      // Создание auth клиента
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });

      // Инициализация Drive API
      this.drive = google.drive({ version: 'v3', auth });
      this.initialized = true;

      console.log('✅ Google Drive подключён успешно');
      console.log(`📁 Папка для бэкапов: ${this.folderId}`);
      
      return true;
    } catch (error) {
      console.error('❌ Ошибка инициализации Google Drive:', error.message);
      console.error('   Stack:', error.stack);
      return false;
    }
  }

  // Загрузка файла в Google Drive
  async uploadFile(localPath, fileName) {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return null;
    }

    try {
      const fileContent = await fs.readFile(localPath);
      
      // Проверяем, существует ли файл уже в папке
      const existingFile = await this.findFile(fileName);
      
      if (existingFile) {
        // Обновляем существующий файл
        const response = await this.drive.files.update({
          fileId: existingFile.id,
          media: {
            mimeType: 'application/json',
            body: fileContent
          }
        });
        
        console.log(`✅ Обновлён файл: ${fileName}`);
        return response.data;
      } else {
        // Создаём новый файл
        const response = await this.drive.files.create({
          requestBody: {
            name: fileName,
            parents: [this.folderId],
            mimeType: 'application/json'
          },
          media: {
            mimeType: 'application/json',
            body: fileContent
          }
        });
        
        console.log(`✅ Загружен файл: ${fileName}`);
        return response.data;
      }
    } catch (error) {
      console.error(`❌ Ошибка загрузки ${fileName}:`, error.message);
      return null;
    }
  }

  // Поиск файла в папке
  async findFile(fileName) {
    try {
      const response = await this.drive.files.list({
        q: `name='${fileName}' and '${this.folderId}' in parents and trashed=false`,
        fields: 'files(id, name, modifiedTime)',
        spaces: 'drive'
      });

      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error(`❌ Ошибка поиска файла ${fileName}:`, error.message);
      return null;
    }
  }

  // Скачивание файла из Google Drive
  async downloadFile(fileName, localPath) {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return false;
    }

    try {
      const file = await this.findFile(fileName);
      
      if (!file) {
        console.log(`⚠️ Файл ${fileName} не найден в Google Drive`);
        return false;
      }

      const response = await this.drive.files.get({
        fileId: file.id,
        alt: 'media'
      }, { responseType: 'stream' });

      // Сохраняем файл локально
      const dest = require('fs').createWriteStream(localPath);
      
      return new Promise((resolve, reject) => {
        response.data
          .on('end', () => {
            console.log(`✅ Скачан файл: ${fileName}`);
            resolve(true);
          })
          .on('error', err => {
            console.error(`❌ Ошибка скачивания ${fileName}:`, err.message);
            reject(err);
          })
          .pipe(dest);
      });
    } catch (error) {
      console.error(`❌ Ошибка скачивания ${fileName}:`, error.message);
      return false;
    }
  }

  // Полный бэкап всех файлов
  async backupAll(files) {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        return { success: false, error: 'Google Drive не инициализирован' };
      }
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    console.log('🔄 Начинаем бэкап...');

    for (const { localPath, remoteName } of files) {
      try {
        // Проверяем существует ли файл локально
        await fs.access(localPath);
        
        const result = await this.uploadFile(localPath, remoteName);
        
        if (result) {
          successCount++;
          results.push({ file: remoteName, status: 'success' });
        } else {
          failCount++;
          results.push({ file: remoteName, status: 'failed' });
        }
      } catch (error) {
        failCount++;
        results.push({ file: remoteName, status: 'failed', error: error.message });
        console.log(`⚠️ Файл ${localPath} не найден локально, пропускаем`);
      }
    }

    const timestamp = new Date().toLocaleString('de-DE');
    console.log(`✅ Бэкап завершён: ${successCount} успешно, ${failCount} ошибок`);
    console.log(`🕐 Время: ${timestamp}`);

    return {
      success: failCount === 0,
      successCount,
      failCount,
      results,
      timestamp
    };
  }

  // Восстановление всех файлов
  async restoreAll(files) {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        return { success: false, error: 'Google Drive не инициализирован' };
      }
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    console.log('🔄 Начинаем восстановление...');

    for (const { localPath, remoteName } of files) {
      const success = await this.downloadFile(remoteName, localPath);
      
      if (success) {
        successCount++;
        results.push({ file: remoteName, status: 'success' });
      } else {
        failCount++;
        results.push({ file: remoteName, status: 'failed' });
      }
    }

    const timestamp = new Date().toLocaleString('de-DE');
    console.log(`✅ Восстановление завершено: ${successCount} успешно, ${failCount} ошибок`);
    console.log(`🕐 Время: ${timestamp}`);

    return {
      success: failCount === 0,
      successCount,
      failCount,
      results,
      timestamp
    };
  }

  // Получить информацию о бэкапах
  async getBackupInfo() {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return null;
    }

    try {
      const response = await this.drive.files.list({
        q: `'${this.folderId}' in parents and trashed=false`,
        fields: 'files(id, name, modifiedTime, size)',
        orderBy: 'modifiedTime desc'
      });

      const files = response.data.files.map(file => ({
        name: file.name,
        lastModified: new Date(file.modifiedTime).toLocaleString('de-DE'),
        size: file.size ? `${(file.size / 1024).toFixed(2)} KB` : 'N/A'
      }));

      return files;
    } catch (error) {
      console.error('❌ Ошибка получения информации о бэкапах:', error.message);
      return null;
    }
  }
}

module.exports = new GoogleDriveBackup();
