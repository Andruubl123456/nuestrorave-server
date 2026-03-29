// server/search.js - Módulo de búsqueda con Google API
const axios = require('axios');

// ⚠️ CONFIGURACIÓN: Reemplaza con tus credenciales
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyDBnomkrM7iq6u4kDXxwwm6E_lpiBCykmI';
const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID || '52a375b6e10d14cbe';

/**
 * Busca contenido usando Google Programmable Search Engine
 * @param {string} query - Término de búsqueda
 * @param {string} type - Tipo: 'video', 'movies', 'web'
 * @returns {Promise<Array>} - Resultados formateados
 */
async function searchGoogle(query, type = 'video') {
  try {
    // Ajustar query según tipo
    let searchQuery = query;
    if (type === 'video') {
      searchQuery = `${query} site:youtube.com OR site:vimeo.com OR site:dailymotion.com`;
    } else if (type === 'movies') {
      searchQuery = `${query} película completa español latino`;
    }

    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: GOOGLE_API_KEY,
        cx: SEARCH_ENGINE_ID,
        q: searchQuery,
        num: 10, // Resultados por página
        safe: 'off'
      }
    });

    if (!response.data.items) {
      return [];
    }

    // Formatear resultados
    return response.data.items.map(item => ({
      title: item.title,
      snippet: item.snippet,
      url: item.link,
      thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || 
                 item.pagemap?.cse_image?.[0]?.src || '',
      source: extractSource(item.link),
      type: detectMediaType(item.link)
    }));

  } catch (error) {
    console.error('Error en búsqueda Google:', error.message);
    throw new Error('Error al buscar contenido');
  }
}

/**
 * Extrae el dominio de una URL
 */
function extractSource(url) {
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return domain;
  } catch {
    return 'web';
  }
}

/**
 * Detecta el tipo de medio según la URL
 */
function detectMediaType(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'yt';
  }
  if (url.includes('spotify.com')) {
    return 'spotify';
  }
  if (/\.(mp4|webm|m3u8|mkv)(\?|$)/i.test(url)) {
    return 'mp4';
  }
  return 'web';
}

/**
 * Busca videos específicamente en YouTube
 */
async function searchYouTube(query) {
  const results = await searchGoogle(`${query} site:youtube.com`, 'video');
  return results.filter(r => r.type === 'yt').map(r => ({
    ...r,
    videoId: extractYouTubeId(r.url)
  }));
}

/**
 * Extrae ID de video de YouTube
 */
function extractYouTubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

module.exports = {
  searchGoogle,
  searchYouTube,
  extractYouTubeId,
  detectMediaType
};