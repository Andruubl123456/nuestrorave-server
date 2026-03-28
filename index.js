/**
 * NuestroRave — Servidor FINAL (v1 + v3 combinados)
 * ──────────────────────────────────────────────────
 * Del v1: estructura simple db.users + db.room, socketUsers map,
 *         endpoints /register y /login directos.
 * Del v3: Heartbeat + Catch-up, busqueda YouTube API v3,
 *         sync-position al unirse, transfer-host,
 *         Garbage Collection, photoMap.
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════
//  CONSTANTES DE SINCRONIZACION
// ══════════════════════════════════════════════
const SYNC = {
  CATCHUP_THRESHOLD : 0.2,
  CATCHUP_SOFT      : 0.5,
  CATCHUP_HARD      : 3.0,
  ROOM_GC_TIMEOUT   : 30000,
};

// ══════════════════════════════════════════════
//  BASE DE DATOS EN MEMORIA
//  Estructura del v1 + campos extra del v3
// ══════════════════════════════════════════════
const db = {
  users: {},
  room: {
    onlineUsers    : [],
    socketMap      : {},   // v3: username -> socketId
    photoMap       : {},   // v3: username -> foto base64
    queue          : [],
    currentMedia   : null,
    isPlaying      : false,
    currentTime    : 0,
    currentDuration: 0,
    roomOwner      : null,
    messages       : [],
    gcTimer        : null,
    settings       : {
      autoplay        : true,
      micEnabled      : true,
      allowBothControl: true,
      blockedDomains  : [
        'pornhub','xvideos','xnxx','redtube','youporn',
        'xhamster','brazzers','onlyfans','porn','xxx','nude',
      ],
    },
  },
};

// socketId -> username (del v1)
const socketUsers = {};

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function roomPublicState() {
  const r = db.room;
  return {
    onlineUsers    : r.onlineUsers,
    photoMap       : r.photoMap,
    queue          : r.queue,
    currentMedia   : r.currentMedia,
    isPlaying      : r.isPlaying,
    currentTime    : r.currentTime,
    currentDuration: r.currentDuration,
    roomOwner      : r.roomOwner,
    messages       : r.messages.slice(-50),
    settings       : r.settings,
  };
}

function calcCatchup(clientTime, hostTime) {
  const delta = hostTime - clientTime;
  if (Math.abs(delta) < SYNC.CATCHUP_THRESHOLD) return { rate: 1.0,  seek: false };
  if (Math.abs(delta) > SYNC.CATCHUP_HARD)      return { rate: 1.0,  seek: true, seekTo: hostTime };
  if (delta > SYNC.CATCHUP_SOFT)                return { rate: 1.25, seek: false };
  if (delta < -SYNC.CATCHUP_SOFT)               return { rate: 0.9,  seek: false };
  return { rate: 1.0, seek: false };
}

function scheduleGC() {
  cancelGC();
  db.room.gcTimer = setTimeout(() => {
    if (db.room.onlineUsers.length === 0) {
      console.log('[GC] Sala vacia - limpiando estado');
      db.room.currentMedia    = null;
      db.room.isPlaying       = false;
      db.room.currentTime     = 0;
      db.room.currentDuration = 0;
      db.room.roomOwner       = null;
      db.room.queue           = [];
      db.room.messages        = [];
      db.room.socketMap       = {};
      db.room.photoMap        = {};
    }
  }, SYNC.ROOM_GC_TIMEOUT);
}
function cancelGC() {
  if (db.room.gcTimer) { clearTimeout(db.room.gcTimer); db.room.gcTimer = null; }
}

// ══════════════════════════════════════════════
//  YOUTUBE SEARCH (del v3 - requiere YT_API_KEY)
// ══════════════════════════════════════════════
const YT_API_KEY = process.env.YT_API_KEY || '';

async function searchYouTube(query) {
  if (!YT_API_KEY) { console.warn('[YT] Sin API key'); return []; }
  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q='
    + encodeURIComponent(query) + '&key=' + YT_API_KEY;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.items) return [];
  return data.items.map(item => ({
    id       : item.id.videoId,
    title    : item.snippet.title,
    channel  : item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
  }));
}

// ══════════════════════════════════════════════
//  REST ENDPOINTS
// ══════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ ok: true, users: Object.keys(db.users).length, online: db.room.onlineUsers.length })
);

app.post('/register', (req, res) => {
  const { username, pass } = req.body || {};
  if (!username || !pass)                    return res.json({ ok: false, error: 'Faltan datos' });
  if (Object.keys(db.users).length >= 2)     return res.json({ ok: false, error: 'Solo se permiten 2 cuentas' });
  if (db.users[username])                    return res.json({ ok: false, error: 'Usuario ya existe' });
  if (pass.length < 4)                       return res.json({ ok: false, error: 'Contrasena muy corta (minimo 4)' });
  db.users[username] = { pass, createdAt: Date.now() };
  console.log('[AUTH] Nuevo usuario: ' + username);
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { username, pass } = req.body || {};
  if (!db.users[username] || db.users[username].pass !== pass)
    return res.json({ ok: false, error: 'Usuario o contrasena incorrectos' });
  res.json({ ok: true, roomState: roomPublicState() });
});

// ══════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════
io.on('connection', socket => {
  console.log('[WS] Conexion: ' + socket.id);

  // JOIN
  socket.on('join', ({ username, photo }) => {
    if (!username) return;
    cancelGC();

    socketUsers[socket.id]      = username;
    db.room.socketMap[username] = socket.id;
    if (photo) db.room.photoMap[username] = photo;

    if (!db.room.onlineUsers.includes(username)) db.room.onlineUsers.push(username);
    if (!db.room.roomOwner) db.room.roomOwner = username;

    socket.join('room');

    // Estado completo al recien llegado
    socket.emit('room-state', roomPublicState());

    // Avisar a todos
    io.to('room').emit('user-joined', {
      username,
      onlineUsers : db.room.onlineUsers,
      photoMap    : db.room.photoMap,
      roomOwner   : db.room.roomOwner,
    });

    // Si hay video en curso, sincronizar al recien llegado (v3)
    if (db.room.currentMedia && db.room.isPlaying) {
      socket.emit('sync-position', {
        time     : db.room.currentTime,
        isPlaying: db.room.isPlaying,
        media    : db.room.currentMedia,
      });
    }

    console.log('[ROOM] ' + username + ' entro (online: ' + db.room.onlineUsers.length + ')');
  });

  // LEAVE
  socket.on('leave', ({ username }) => _userLeft(socket, username));

  // CHAT
  socket.on('chat', ({ username, text, photo }) => {
    if (!username || !text) return;
    const msg = { username, text, photo, time: Date.now() };
    db.room.messages.push(msg);
    if (db.room.messages.length > 100) db.room.messages.shift();
    io.to('room').emit('chat', msg);
  });

  // PLAY
  socket.on('play', ({ username, time }) => {
    if (!db.room.settings.allowBothControl && username !== db.room.roomOwner) return;
    db.room.isPlaying   = true;
    db.room.currentTime = time ?? db.room.currentTime;
    io.to('room').emit('play', { username, time: db.room.currentTime });
  });

  // PAUSE
  socket.on('pause', ({ username, time }) => {
    if (!db.room.settings.allowBothControl && username !== db.room.roomOwner) return;
    db.room.isPlaying   = false;
    db.room.currentTime = time ?? db.room.currentTime;
    io.to('room').emit('pause', { username, time: db.room.currentTime });
  });

  // SEEK
  socket.on('seek', ({ username, time }) => {
    if (!db.room.settings.allowBothControl && username !== db.room.roomOwner) return;
    db.room.currentTime = time;
    io.to('room').emit('seek', { username, time });
  });

  // HEARTBEAT + CATCH-UP (del v3)
  socket.on('heartbeat', ({ username, time, duration }) => {
    if (username !== db.room.roomOwner) return;
    db.room.currentTime     = time;
    db.room.currentDuration = duration || db.room.currentDuration;

    db.room.onlineUsers.forEach(u => {
      if (u === username) return;
      const sid = db.room.socketMap[u];
      if (!sid) return;
      const guest = io.sockets.sockets.get(sid);
      if (!guest) return;
      guest.timeout(2000).emit('request-position', {}, (err, clientTime) => {
        if (err || clientTime == null) return;
        guest.emit('catchup', calcCatchup(clientTime, db.room.currentTime));
      });
    });
  });

  // LOAD MEDIA
  socket.on('load-media', ({ username, media }) => {
    db.room.currentMedia  = media;
    db.room.isPlaying     = false;
    db.room.currentTime   = 0;
    io.to('room').emit('load-media', { username, media });
  });

  // UPDATE QUEUE
  socket.on('update-queue', ({ queue }) => {
    db.room.queue = queue;
    io.to('room').emit('update-queue', { queue });
  });

  // UPDATE SETTINGS
  socket.on('update-settings', ({ username, settings }) => {
    if (username !== db.room.roomOwner) return;
    db.room.settings = { ...db.room.settings, ...settings };
    io.to('room').emit('update-settings', { settings: db.room.settings });
  });

  // TRANSFER HOST (del v3)
  socket.on('transfer-host', ({ username, newOwner }) => {
    if (username !== db.room.roomOwner) return;
    if (!db.room.onlineUsers.includes(newOwner)) return;
    db.room.roomOwner = newOwner;
    io.to('room').emit('host-changed', { roomOwner: newOwner });
    console.log('[HOST] Nuevo host: ' + newOwner);
  });

  // MIC
  socket.on('mic-on',  ({ username }) => io.to('room').emit('mic-on',  { username }));
  socket.on('mic-off', ({ username }) => io.to('room').emit('mic-off', { username }));

  // BUSQUEDA YOUTUBE (del v3)
  socket.on('search-yt', async ({ query }) => {
    if (!query) return;
    try {
      socket.emit('yt-results', await searchYouTube(query));
    } catch (e) {
      console.error('[YT]', e.message);
      socket.emit('yt-results', []);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const username = socketUsers[socket.id];
    if (username) { delete socketUsers[socket.id]; _userLeft(socket, username); }
  });
});

// ══════════════════════════════════════════════
//  HELPER: sacar usuario de sala
// ══════════════════════════════════════════════
function _userLeft(socket, username) {
  db.room.onlineUsers = db.room.onlineUsers.filter(u => u !== username);
  delete db.room.socketMap[username];

  if (db.room.roomOwner === username) {
    db.room.roomOwner = db.room.onlineUsers[0] || null;
    if (db.room.roomOwner)
      io.to('room').emit('host-changed', { roomOwner: db.room.roomOwner });
  }

  io.to('room').emit('user-left', {
    username,
    onlineUsers: db.room.onlineUsers,
    roomOwner  : db.room.roomOwner,
  });

  if (db.room.onlineUsers.length === 0) scheduleGC();
  console.log('[ROOM] ' + username + ' salio (quedan: ' + db.room.onlineUsers.length + ')');
}

// ══════════════════════════════════════════════
//  RELOJ INTERNO — avanza currentTime mientras
//  hay reproduccion activa
// ══════════════════════════════════════════════
setInterval(() => {
  if (db.room.isPlaying) db.room.currentTime += 5;
}, 5000);

// ══════════════════════════════════════════════
//  ARRANQUE
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('[SERVER] Corriendo en puerto ' + PORT));
