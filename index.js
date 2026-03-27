const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── BASE DE DATOS EN MEMORIA ──
const db = {
  users: {},
  room: {
    onlineUsers: [],
    queue: [],
    currentMedia: null,
    isPlaying: false,
    currentTime: 0,
    currentDuration: 0,
    roomOwner: null,
    messages: [],
    settings: {
      autoplay: true,
      micEnabled: true,
      allowBothControl: true,
      blockedDomains: [
        'pornhub','xvideos','xnxx','redtube','youporn',
        'xhamster','brazzers','onlyfans','porn','xxx','nude'
      ]
    }
  }
};

const socketUsers = {};

// ── REST ──
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/register', (req, res) => {
  const { username, pass } = req.body;
  if (!username || !pass) return res.json({ ok: false, error: 'Faltan datos' });
  if (Object.keys(db.users).length >= 2) return res.json({ ok: false, error: 'Solo se permiten 2 cuentas' });
  if (db.users[username]) return res.json({ ok: false, error: 'Usuario ya existe' });
  if (pass.length < 4) return res.json({ ok: false, error: 'Contrasena muy corta (minimo 4 caracteres)' });
  db.users[username] = { pass, createdAt: Date.now() };
  console.log('Nuevo usuario: ' + username);
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { username, pass } = req.body;
  if (!db.users[username] || db.users[username].pass !== pass)
    return res.json({ ok: false, error: 'Usuario o contrasena incorrectos' });
  res.json({ ok: true, roomState: db.room });
});

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  console.log('Conexion: ' + socket.id);

  socket.on('join', ({ username }) => {
    socketUsers[socket.id] = username;
    if (!db.room.onlineUsers.includes(username)) {
      db.room.onlineUsers.push(username);
    }
    if (!db.room.roomOwner) db.room.roomOwner = username;
    socket.join('room');
    socket.emit('room-state', db.room);
    io.to('room').emit('user-joined', {
      username,
      onlineUsers: db.room.onlineUsers,
      roomOwner: db.room.roomOwner
    });
  });

  socket.on('leave', ({ username }) => {
    db.room.onlineUsers = db.room.onlineUsers.filter(u => u !== username);
    if (db.room.roomOwner === username && db.room.onlineUsers.length > 0) {
      db.room.roomOwner = db.room.onlineUsers[0];
    }
    io.to('room').emit('user-left', {
      username,
      onlineUsers: db.room.onlineUsers,
      roomOwner: db.room.roomOwner
    });
  });

  socket.on('chat', ({ username, text }) => {
    const msg = { username, text, time: Date.now() };
    db.room.messages.push(msg);
    if (db.room.messages.length > 100) db.room.messages.shift();
    io.to('room').emit('chat', msg);
  });

  socket.on('play', ({ username, time }) => {
    db.room.isPlaying = true;
    db.room.currentTime = time || db.room.currentTime;
    io.to('room').emit('play', { username, time: db.room.currentTime });
  });

  socket.on('pause', ({ username, time }) => {
    db.room.isPlaying = false;
    db.room.currentTime = time || db.room.currentTime;
    io.to('room').emit('pause', { username, time: db.room.currentTime });
  });

  socket.on('seek', ({ username, time }) => {
    db.room.currentTime = time;
    io.to('room').emit('seek', { username, time });
  });

  socket.on('load-media', ({ username, media }) => {
    db.room.currentMedia = media;
    db.room.isPlaying = false;
    db.room.currentTime = 0;
    io.to('room').emit('load-media', { username, media });
  });

  socket.on('update-queue', ({ queue }) => {
    db.room.queue = queue;
    io.to('room').emit('update-queue', { queue });
  });

  socket.on('update-settings', ({ username, settings }) => {
    if (username !== db.room.roomOwner) return;
    db.room.settings = settings;
    io.to('room').emit('update-settings', { settings });
  });

  socket.on('mic-on', ({ username }) => {
    io.to('room').emit('mic-on', { username });
  });

  socket.on('mic-off', ({ username }) => {
    io.to('room').emit('mic-off', { username });
  });

  socket.on('disconnect', () => {
    const username = socketUsers[socket.id];
    if (username) {
      db.room.onlineUsers = db.room.onlineUsers.filter(u => u !== username);
      if (db.room.roomOwner === username && db.room.onlineUsers.length > 0) {
        db.room.roomOwner = db.room.onlineUsers[0];
      }
      delete socketUsers[socket.id];
      io.to('room').emit('user-left', {
        username,
        onlineUsers: db.room.onlineUsers,
        roomOwner: db.room.roomOwner
      });
      console.log(username + ' desconectado');
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
