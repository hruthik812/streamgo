const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt   = require('bcryptjs');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const publicPath  = path.join(__dirname, 'public');
const uploadsPath = path.join(publicPath, 'uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });

app.use(express.static(publicPath));
app.use(express.json());

app.get('/',      (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));

// ── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage, limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Videos only'))
});

// ── In-memory stores ─────────────────────────────────────────────────────────
const users       = new Map();   // email -> user object
const resetTokens = new Map();   // token -> { email, expires }
const bannedUsers = new Set();   // set of user IDs
let   reels       = [];
let   chatHistory = [];          // { id, userA, userB, messages[], startedAt, endedAt }
let   siteSettings = { maintenanceMode: false, allowGuests: true, maxMessageLength: 500, siteName: 'Chatterly' };

// Seed admin account
(async () => {
  const hash = await bcrypt.hash('admin123', 10);
  users.set('admin@chatterly.com', {
    id: 'admin-001', username: 'Admin', email: 'admin@chatterly.com',
    passwordHash: hash, isAdmin: true, createdAt: Date.now(), chatCount: 0, lastSeen: Date.now()
  });
})();

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (users.has(email.toLowerCase()))   return res.status(400).json({ error: 'Email already registered' });
  if (password.length < 6)              return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, email: email.toLowerCase(), passwordHash, isAdmin: false, createdAt: Date.now(), chatCount: 0, lastSeen: Date.now(), bio: '', avatar: '' };
  users.set(email.toLowerCase(), user);
  res.json({ id: user.id, username: user.username, email: user.email, isAdmin: false, bio: '', avatar: '' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = users.get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'No account found with that email' });
  if (bannedUsers.has(user.id)) return res.status(403).json({ error: 'Your account has been banned' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });
  user.lastSeen = Date.now();
  res.json({ id: user.id, username: user.username, email: user.email, isAdmin: user.isAdmin || false, bio: user.bio || '', avatar: user.avatar || '' });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = users.get(email.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email' });
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  resetTokens.set(token, { email: email.toLowerCase(), expires: Date.now() + 15 * 60 * 1000 });
  res.json({ message: 'Reset code generated', token, note: 'In production this would be emailed.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  const entry = resetTokens.get(token);
  if (!entry) return res.status(400).json({ error: 'Invalid reset code' });
  if (Date.now() > entry.expires) { resetTokens.delete(token); return res.status(400).json({ error: 'Code expired' }); }
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = users.get(entry.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  resetTokens.delete(token);
  res.json({ message: 'Password reset successfully!' });
});

// ── PROFILE ───────────────────────────────────────────────────────────────────
app.put('/api/profile/:id', async (req, res) => {
  const { username, bio, currentPassword, newPassword } = req.body;
  let user = null;
  for (const u of users.values()) { if (u.id === req.params.id) { user = u; break; } }
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (username) user.username = username;
  if (bio !== undefined) user.bio = bio;
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
  }
  res.json({ id: user.id, username: user.username, email: user.email, bio: user.bio, isAdmin: user.isAdmin });
});

// ── CHAT HISTORY ──────────────────────────────────────────────────────────────
app.get('/api/chat-history/:userId', (req, res) => {
  const history = chatHistory.filter(s => s.userA === req.params.userId || s.userB === req.params.userId);
  res.json(history.slice(-50)); // last 50
});

// ── REELS ─────────────────────────────────────────────────────────────────────
app.post('/api/reels', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });
  const reel = { id: uuidv4(), url: `/uploads/${req.file.filename}`, caption: req.body.caption || '', username: req.body.username || 'Anonymous', userId: req.body.userId || null, likes: 0, likedBy: [], comments: [], views: 0, createdAt: Date.now() };
  reels.unshift(reel);
  res.json(reel);
});
app.get('/api/reels', (req, res) => res.json(reels));
app.post('/api/reels/:id/like', (req, res) => {
  const reel = reels.find(r => r.id === req.params.id);
  if (!reel) return res.status(404).json({ error: 'Not found' });
  const uid = req.body.uid; const idx = reel.likedBy.indexOf(uid);
  if (idx === -1) { reel.likes++; reel.likedBy.push(uid); } else { reel.likes--; reel.likedBy.splice(idx, 1); }
  res.json({ likes: reel.likes, liked: idx === -1 });
});
app.post('/api/reels/:id/comment', (req, res) => {
  const reel = reels.find(r => r.id === req.params.id);
  if (!reel) return res.status(404).json({ error: 'Not found' });
  const comment = { id: uuidv4(), text: req.body.text, username: req.body.username || 'Anon', ts: Date.now() };
  reel.comments.push(comment); res.json(comment);
});
app.post('/api/reels/:id/view', (req, res) => {
  const reel = reels.find(r => r.id === req.params.id); if (reel) reel.views++; res.json({ ok: true });
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
function adminCheck(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== 'chatterly-admin-secret') return res.status(403).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/stats', adminCheck, (req, res) => {
  res.json({
    totalUsers:    users.size,
    totalReels:    reels.length,
    totalChats:    chatHistory.length,
    activeChats:   pairs.size / 2,
    onlineUsers:   io.engine.clientsCount,
    bannedUsers:   bannedUsers.size,
    totalMessages: chatHistory.reduce((sum, s) => sum + (s.messages?.length || 0), 0)
  });
});

app.get('/api/admin/users', adminCheck, (req, res) => {
  const list = Array.from(users.values()).map(u => ({
    id: u.id, username: u.username, email: u.email, isAdmin: u.isAdmin,
    createdAt: u.createdAt, lastSeen: u.lastSeen, chatCount: u.chatCount,
    banned: bannedUsers.has(u.id)
  }));
  res.json(list);
});

app.delete('/api/admin/users/:id', adminCheck, (req, res) => {
  for (const [email, u] of users.entries()) { if (u.id === req.params.id) { users.delete(email); break; } }
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', adminCheck, (req, res) => {
  if (bannedUsers.has(req.params.id)) bannedUsers.delete(req.params.id);
  else bannedUsers.add(req.params.id);
  const banned = bannedUsers.has(req.params.id);
  res.json({ banned });
});

app.get('/api/admin/reels', adminCheck, (req, res) => res.json(reels));

app.delete('/api/admin/reels/:id', adminCheck, (req, res) => {
  reels = reels.filter(r => r.id !== req.params.id); res.json({ ok: true });
});

app.get('/api/admin/chats', adminCheck, (req, res) => res.json(chatHistory.slice(-100)));

app.get('/api/admin/live-chats', adminCheck, (req, res) => {
  const live = [];
  for (const [idA, idB] of pairs.entries()) {
    if (idA < idB) live.push({ socketA: idA, socketB: idB, users: activeSockets.get(idA) || {}, startedAt: Date.now() });
  }
  res.json(live);
});

app.get('/api/admin/settings', adminCheck, (req, res) => res.json(siteSettings));
app.put('/api/admin/settings', adminCheck, (req, res) => {
  siteSettings = { ...siteSettings, ...req.body }; res.json(siteSettings);
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
let waitingQueue = [];
const pairs        = new Map();
const activeSockets = new Map(); // socketId -> { userId, username }
const sessionMessages = new Map(); // socketId -> { sessionId, messages[] }

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const idA = waitingQueue.shift(), idB = waitingQueue.shift();
    const sA = io.sockets.sockets.get(idA), sB = io.sockets.sockets.get(idB);
    if (!sA || !sB) { if (sA) waitingQueue.unshift(idA); if (sB) waitingQueue.unshift(idB); continue; }
    pairs.set(idA, idB); pairs.set(idB, idA);
    const sessionId = uuidv4();
    const session = { id: sessionId, userA: activeSockets.get(idA)?.userId || idA, userB: activeSockets.get(idB)?.userId || idB, usernameA: activeSockets.get(idA)?.username || 'Guest', usernameB: activeSockets.get(idB)?.username || 'Guest', messages: [], startedAt: Date.now(), endedAt: null };
    chatHistory.push(session);
    sessionMessages.set(idA, { sessionId, messages: session.messages });
    sessionMessages.set(idB, { sessionId, messages: session.messages });
    // Update chat counts
    const uA = activeSockets.get(idA)?.userId; const uB = activeSockets.get(idB)?.userId;
    if (uA) { for (const u of users.values()) { if (u.id === uA) { u.chatCount++; break; } } }
    if (uB) { for (const u of users.values()) { if (u.id === uB) { u.chatCount++; break; } } }
    sA.emit('matched', { message: "You're now connected to a stranger! Say hi 👋", sessionId });
    sB.emit('matched', { message: "You're now connected to a stranger! Say hi 👋", sessionId });
  }
}

function removeFromQueue(id) { const i = waitingQueue.indexOf(id); if (i !== -1) waitingQueue.splice(i, 1); }

function endSession(id) {
  const sm = sessionMessages.get(id);
  if (sm) {
    const session = chatHistory.find(s => s.id === sm.sessionId);
    if (session && !session.endedAt) session.endedAt = Date.now();
    sessionMessages.delete(id);
  }
}

function disconnectPair(id) {
  const pid = pairs.get(id);
  if (pid) {
    const p = io.sockets.sockets.get(pid);
    if (p) p.emit('partnerLeft', { message: 'Stranger has disconnected.' });
    endSession(pid);
    pairs.delete(pid);
  }
  endSession(id);
  pairs.delete(id);
}

io.on('connection', socket => {
  io.emit('onlineCount', io.engine.clientsCount);

  socket.on('register', data => { activeSockets.set(socket.id, { userId: data.userId, username: data.username }); });

  socket.on('findPartner', () => {
    disconnectPair(socket.id); removeFromQueue(socket.id);
    if (siteSettings.maintenanceMode) { socket.emit('error', { message: 'Site is under maintenance.' }); return; }
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    socket.emit('waiting', { message: 'Looking for a stranger...' });
    matchUsers();
  });

  socket.on('message', data => {
    const pid = pairs.get(socket.id); if (!pid) return;
    const p = io.sockets.sockets.get(pid); if (p) p.emit('message', { text: data.text });
    // Save to session
    const sm = sessionMessages.get(socket.id);
    if (sm) sm.messages.push({ from: activeSockets.get(socket.id)?.username || 'User', text: data.text, ts: Date.now() });
  });

  socket.on('shareReel', data => { const pid = pairs.get(socket.id); if (!pid) return; const p = io.sockets.sockets.get(pid); if (p) p.emit('reelShared', { reelId: data.reelId }); });

  socket.on('next', () => { disconnectPair(socket.id); removeFromQueue(socket.id); waitingQueue.push(socket.id); socket.emit('waiting', { message: 'Looking for a new stranger...' }); matchUsers(); });

  socket.on('disconnect', () => { disconnectPair(socket.id); removeFromQueue(socket.id); activeSockets.delete(socket.id); io.emit('onlineCount', io.engine.clientsCount); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Chatterly running at http://localhost:${PORT}`));
