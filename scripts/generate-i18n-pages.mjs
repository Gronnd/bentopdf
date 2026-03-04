import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.resolve(__dirname, '../dist');
const LOCALES_DIR = path.resolve(__dirname, '../public/locales');
const SITE_URL = process.env.SITE_URL || 'https://bentopdf.com';
const BASE_PATH = (process.env.BASE_URL || '/').replace(/\/$/, '');

const languages = fs.readdirSync(LOCALES_DIR).filter((file) => {
  return fs.statSync(path.join(LOCALES_DIR, file)).isDirectory();
});

const toCamelCase = (str) => {
  return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
};

const KEY_MAPPING = {
  index: 'home',
  404: 'notFound',
};

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadAllTranslations() {
  const translations = {};
  for (const lang of languages) {
    if (lang === 'en') continue;
    const commonPath = path.join(LOCALES_DIR, `${lang}/common.json`);
    const toolsPath = path.join(LOCALES_DIR, `${lang}/tools.json`);
    translations[lang] = {
      common: fs.existsSync(commonPath)
        ? JSON.parse(fs.readFileSync(commonPath, 'utf-8'))
        : {},
      tools: fs.existsSync(toolsPath)
        ? JSON.parse(fs.readFileSync(toolsPath, 'utf-8'))
        : {},
    };
  }
  return translations;
}

// TODO@ALAM: Let users build only a single language
function buildUrl(langPrefix, pagePath) {
  const parts = [SITE_URL];
  if (BASE_PATH && BASE_PATH !== '') parts.push(BASE_PATH.replace(/^\//, ''));
  if (langPrefix) parts.push(langPrefix);
  if (pagePath) parts.push(pagePath.replace(/^\//, ''));
  return parts.filter(Boolean).join('/').replace(/\/+$/, '') || SITE_URL;
}

function replaceMetaContent(html, selector, newContent) {
  const escaped = escapeHtml(newContent);
  if (selector.includes('property=')) {
    const prop = selector.match(/property="([^"]+)"/)[1];
    return html.replace(
      new RegExp(
        `(<meta\\s[^>]*property="${prop}"[^>]*content=")([^"]*)(")`,
        'i'
      ),
      `$1${escaped}$3`
    );
  }
  if (selector.includes('name=')) {
    const name = selector.match(/name="([^"]+)"/)[1];
    return html.replace(
      new RegExp(
        `(<meta\\s[^>]*name="${name}"[^>]*content=")([^"]*)(")`,
        'i'
      ),
      `$1${escaped}$3`
    );
  }
  return html;
}

function buildAlternateLinks(pagePath) {
  let links = '';
  for (const l of languages) {
    const href = buildUrl(l === 'en' ? '' : l, pagePath);
    links += `<link rel="alternate" hreflang="${l}" href="${href}">`;
  }
  links += `<link rel="alternate" hreflang="x-default" href="${buildUrl('', pagePath)}">`;
  return links;
}

const langPrefixRegex = new RegExp(
  `^(${BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?/(${languages.join('|')})(/|$)`
);

function rewriteInternalLinks(html, lang) {
  return html.replace(/<a\s([^>]*href=")([^"]*)(")([^>]*>)/gi, (match, pre, href, post, rest) => {
    if (
      href.startsWith('http') ||
      href.startsWith('//') ||
      href.startsWith('#') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:')
    ) {
      return match;
    }
    if (href.startsWith('/assets/') || href.includes('/assets/')) return match;
    if (langPrefixRegex.test(href)) return match;

    let newHref;
    if (href.startsWith('/')) {
      const pathWithoutBase = href.startsWith(BASE_PATH)
        ? href.slice(BASE_PATH.length)
        : href;
      newHref = `${BASE_PATH}/${lang}${pathWithoutBase}`;
    } else {
      newHref = `${BASE_PATH}/${lang}/${href}`;
    }

    return `<a ${pre}${newHref}${post}${rest}`;
  });
}

function processFileForLanguage(originalContent, file, lang, translations, langDir) {
  const filenameNoExt = file.replace('.html', '');
  let translationKey = toCamelCase(filenameNoExt);
  if (KEY_MAPPING[filenameNoExt]) {
    translationKey = KEY_MAPPING[filenameNoExt];
  }

  const { tools } = translations[lang];
  let html = originalContent;

  // Set lang and dir on <html>
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  html = html.replace(/<html([^>]*)>/i, (match, attrs) => {
    attrs = attrs.replace(/\s+lang="[^"]*"/, '').replace(/\s+dir="[^"]*"/, '');
    return `<html${attrs} lang="${lang}" dir="${dir}">`;
  });

  let title = null;
  let description = null;

  if (tools[translationKey]) {
    title =
      tools[translationKey].pageTitle ||
      (tools[translationKey].name
        ? `${tools[translationKey].name} - BentoPDF`
        : null);
    description = tools[translationKey].subtitle;
  }

  if (title) {
    html = html.replace(
      /<title>[^<]*<\/title>/i,
      `<title>${escapeHtml(title)}</title>`
    );
    html = replaceMetaContent(html, 'property="og:title"', title);
    html = replaceMetaContent(html, 'name="twitter:title"', title);
  }

  if (description) {
    html = replaceMetaContent(html, 'name="description"', description);
    html = replaceMetaContent(html, 'property="og:description"', description);
    html = replaceMetaContent(html, 'name="twitter:description"', description);
  }

  // Remove existing alternate/hreflang links
  html = html.replace(/<link\s[^>]*rel="alternate"[^>]*hreflang="[^"]*"[^>]*>\s*/gi, '');

  const pagePath = filenameNoExt === 'index' ? '' : filenameNoExt;

  // Add alternate links + canonical
  const alternateLinks = buildAlternateLinks(pagePath);
  const canonicalHref = buildUrl(lang, pagePath);
  const canonicalTag = `<link rel="canonical" href="${canonicalHref}">`;

  // Replace existing canonical or add one
  if (/<link\s[^>]*rel="canonical"[^>]*>/i.test(html)) {
    html = html.replace(/<link\s[^>]*rel="canonical"[^>]*>/i, canonicalTag);
  } else {
    html = html.replace('</head>', `${canonicalTag}\n</head>`);
  }

  // Insert alternate links before </head>
  html = html.replace('</head>', `${alternateLinks}\n</head>`);

  // Rewrite internal links
  html = rewriteInternalLinks(html, lang);

  fs.writeFileSync(path.join(langDir, file), html);
}

function updateEnglishFile(filePath, originalContent) {
  const filenameNoExt = path.basename(filePath, '.html');
  let html = originalContent;

  // Remove existing alternate/hreflang links
  html = html.replace(/<link\s[^>]*rel="alternate"[^>]*hreflang="[^"]*"[^>]*>\s*/gi, '');

  const pagePath = filenameNoExt === 'index' ? '' : filenameNoExt;
  const alternateLinks = buildAlternateLinks(pagePath);

  // Insert alternate links before </head>
  html = html.replace('</head>', `${alternateLinks}\n</head>`);

  fs.writeFileSync(filePath, html);
}

async function generateI18nPages() {
  console.log('Generating i18n pages...');
  console.log(`   SITE_URL: ${SITE_URL}`);
  console.log(`   BASE_PATH: ${BASE_PATH || '/'}`);
  console.log(`   Languages: ${languages.length} (${languages.join(', ')})`);

  if (!fs.existsSync(DIST_DIR)) {
    console.error('dist directory not found. Please run build first.');
    process.exit(1);
  }

  console.log('   Loading translations...');
  const translations = loadAllTranslations();

  const htmlFiles = fs
    .readdirSync(DIST_DIR)
    .filter((file) => file.endsWith('.html'));

  console.log(`   Processing ${htmlFiles.length} HTML files...`);

  for (const lang of languages) {
    if (lang === 'en') continue;
    const langDir = path.join(DIST_DIR, lang);
    if (!fs.existsSync(langDir)) {
      fs.mkdirSync(langDir, { recursive: true });
    }
  }

  let processed = 0;
  const total = htmlFiles.length * (languages.length - 1);

  for (const file of htmlFiles) {
    const filePath = path.join(DIST_DIR, file);
    const originalContent = fs.readFileSync(filePath, 'utf-8');

    for (const lang of languages) {
      if (lang === 'en') continue;

      const langDir = path.join(DIST_DIR, lang);

      processFileForLanguage(
        originalContent,
        file,
        lang,
        translations,
        langDir
      );

      processed++;
      if (processed % 100 === 0 || processed === total) {
        console.log(`   Progress: ${processed}/${total} pages`);
      }
    }

    updateEnglishFile(filePath, originalContent);
  }

  console.log('i18n pages generated successfully!');
}

generateI18nPages().catch((err) => {
  console.error('i18n page generation failed:', err);
  process.exit(1);
});
