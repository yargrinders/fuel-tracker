const axios = require('axios');
const cheerio = require('cheerio');

async function testParser(url) {
  try {
    console.log(`\n🔍 Тестирую: ${url}\n`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    console.log('📄 Заголовки H1:');
    $('h1').each((i, el) => {
      console.log(`  ${i + 1}. "${$(el).text().trim()}"`);
    });
    
    console.log('\n💰 Ищем div.price-field:');
    $('.price-field').each((i, el) => {
      const html = $(el).html();
      const text = $(el).text();
      console.log(`\n  ${i + 1}. Price Field:`);
      console.log(`     HTML: ${html}`);
      console.log(`     Text: ${text}`);
      
      // Извлекаем span с id="current-price-*"
      const priceSpan = $(el).find('span[id^="current-price"]');
      if (priceSpan.length > 0) {
        console.log(`     Span ID: ${priceSpan.attr('id')}`);
        console.log(`     Span Text: ${priceSpan.text()}`);
      }
      
      // Ищем тип топлива рядом
      const parent = $(el).parent();
      console.log(`     Parent Text: ${parent.text().trim()}`);
    });
    
    console.log('\n🏷️ Все span с id="current-price-*" или "suffix-price-*":');
    $('span[id^="current-price"], span[id^="suffix-price"]').each((i, el) => {
      const id = $(el).attr('id');
      const text = $(el).text().trim();
      const parent = $(el).closest('div, tr').text().trim();
      console.log(`  ${i + 1}. ID: ${id}, Value: "${text}"`);
      console.log(`     Context: "${parent}"`);
    });
    
    // Сохраняем HTML для ручного анализа
    const fs = require('fs');
    const stationId = url.match(/\/(\d+)$/)?.[1];
    fs.writeFileSync(`debug-${stationId}.html`, response.data);
    console.log(`\n💾 HTML сохранён в debug-${stationId}.html`);
    
    // Тестируем парсинг
    console.log('\n🧪 ТЕСТИРОВАНИЕ ПАРСИНГА:');
    const prices = { diesel: null, e5: null, e10: null };
    
    $('.price-field').each((i, priceField) => {
      const fieldHtml = $(priceField).html();
      const fieldText = $(priceField).text().toLowerCase();
      
      const priceSpan = $(priceField).find('span[id^="current-price"]').first();
      let priceText = priceSpan.text().trim();
      
      if (!priceText) {
        const match = fieldHtml.match(/>(\d{1,2}[.,]\d{2,3})</);
        if (match) priceText = match[1];
      }
      
      if (priceText) {
        const price = parseFloat(priceText.replace(',', '.').replace(/[^\d.]/g, ''));
        const parentText = $(priceField).parent().text().toLowerCase();
        const allText = fieldText + ' ' + parentText;
        
        if (!prices.diesel && allText.includes('diesel')) {
          prices.diesel = price;
          console.log(`  ✓ Diesel: ${price}€`);
        } else if (!prices.e5 && (allText.includes('super e5') || allText.includes('e 5'))) {
          prices.e5 = price;
          console.log(`  ✓ E5: ${price}€`);
        } else if (!prices.e10 && (allText.includes('super e10') || allText.includes('e 10'))) {
          prices.e10 = price;
          console.log(`  ✓ E10: ${price}€`);
        }
      }
    });
    
    console.log(`\n📊 РЕЗУЛЬТАТ: Diesel=${prices.diesel}, E5=${prices.e5}, E10=${prices.e10}`);
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// Тестируем все три заправки
(async () => {
  await testParser('https://www.clever-tanken.de/tankstelle_details/186650');
  await testParser('https://www.clever-tanken.de/tankstelle_details/11438');
  await testParser('https://www.clever-tanken.de/tankstelle_details/27581');
})();
