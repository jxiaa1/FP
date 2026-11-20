const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'admin888';
const CARDS_PER_SEAT = 5;

app.use(express.static(__dirname));

const rooms = new Map();

function makeDeck() {
  const suits = ['♠', '♥', '♣', '♦'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ rank: r, suit: s, faceUp: false });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom() {
  const seats = [0, 1, 2, 3, 4, 5, 6].map(i => ({
    id: i,
    name: `玩家 ${i + 1}`,
    cards: [],
    occupant: null
  }));
  const room = { seats, deck: makeDeck() };
  recalc(room);
  return room;
}

function recalc(room) {
  room.total = room.seats.length * CARDS_PER_SEAT;
  room.remaining = room.seats.reduce(
    (sum, s) => sum + Math.max(0, CARDS_PER_SEAT - s.cards.length),
    0
  );
}

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, createRoom());
  return rooms.get(name);
}

function stateFor(socket) {
  const room = getRoom(socket.data.room);
  const isHost = !!socket.data.isHost;
  const mySeat = socket.data.seatId;
  return {
    role: isHost ? 'host' : (mySeat != null ? 'player' : 'spectator'),
    mySeatId: mySeat != null ? mySeat : null,
    total: room.total,
    remaining: room.remaining,
    cardsPerSeat: CARDS_PER_SEAT,
    seats: room.seats.map(s => ({
      id: s.id,
      name: s.name,
      occupied: !!s.occupant,
      isMine: s.id === mySeat,
      cards: s.cards.map(c => {
        // 主控能看到所有牌；其他人只能看到公开的牌
        const canSee = isHost || c.faceUp;
        return {
          faceUp: c.faceUp,
          rank: canSee ? c.rank : null,
          suit: canSee ? c.suit : null
        };
      })
    }))
  };
}

function broadcastAll(roomName) {
  const ids = io.sockets.adapter.rooms.get(roomName);
  if (!ids) return;
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.room === roomName) s.emit('state', stateFor(s));
  }
}

/* ---------- 发牌 ---------- */

// 所有人各发一张
function dealOneEach(room) {
  for (const seat of room.seats) {
    if (seat.cards.length >= CARDS_PER_SEAT) continue;
    const card = room.deck.pop();
    if (!card) break;
    card.faceUp = seat.cards.length === 0; // 每人第一张明置
    seat.cards.push(card);
  }
  recalc(room);
}

// 一次发完
function dealAll(room) {
  let guard = 0;
  while (
    room.seats.some(s => s.cards.length < CARDS_PER_SEAT) &&
    guard < 1000
  ) {
    dealOneEach(room);
    guard++;
  }
}

/* ---------- 连接 ---------- */

io.on('connection', (socket) => {

  socket.on('join', ({ room, host, key, token }) => {
    socket.data.room = String(room || 'default').slice(0, 32) || 'default';
    socket.data.isHost = !!host && key === HOST_KEY;
    socket.data.token = token || null;
    socket.data.seatId = null;

    // 玩家刷新后，凭 token 自动恢复座位
    if (!socket.data.isHost && token) {
      const r = getRoom(socket.data.room);
      const seat = r.seats.find(s => s.occupant === token);
      if (seat) socket.data.seatId = seat.id;
    }

    socket.join(socket.data.room);
    socket.emit('role', { isHost: socket.data.isHost });
    broadcastAll(socket.data.room);
  });

  /* ---------- 主控操作 ---------- */
  socket.on('host:action', (action) => {
    if (!socket.data.isHost || !socket.data.room) return;
    const room = getRoom(socket.data.room);

    switch (action.type) {
      case 'dealOneEach':
        dealOneEach(room);
        break;
      case 'dealAll':
        dealAll(room);
        break;
      case 'revealAll':
        room.seats.forEach(s => s.cards.forEach(c => { c.faceUp = true; }));
        break;
      case 'reset': {
        const fresh = createRoom();
        // 保留座位名称与占用者
        fresh.seats = room.seats.map(s => ({
          id: s.id,
          name: s.name,
          cards: [],
          occupant: s.occupant
        }));
        recalc(fresh);
        rooms.set(socket.data.room, fresh);
        break;
      }
      case 'rename': {
        const seat = room.seats.find(s => s.id === action.seatId);
        if (seat && typeof action.name === 'string') {
          seat.name = action.name.slice(0, 20) || `玩家 ${action.seatId + 1}`;
        }
        break;
      }
      case 'toggle': {
        const seat = room.seats.find(s => s.id === action.seatId);
        const card = seat && seat.cards[action.index];
        if (card) card.faceUp = !card.faceUp;
        break;
      }
      case 'addSeat': {
        const nextId = room.seats.length
          ? Math.max(...room.seats.map(s => s.id)) + 1
          : 0;
        room.seats.push({
          id: nextId,
          name: `玩家 ${room.seats.length + 1}`,
          cards: [],
          occupant: null
        });
        recalc(room);
        break;
      }
      case 'removeSeat': {
        if (room.seats.length <= 1) {
          socket.emit('host:msg', '至少保留一个座位');
          return;
        }
        let idx = -1;
        for (let i = room.seats.length - 1; i >= 0; i--) {
          if (!room.seats[i].occupant) { idx = i; break; }
        }
        if (idx === -1) {
          socket.emit('host:msg', '所有座位都有人，无法删除');
          return;
        }
        room.seats.splice(idx, 1);
        recalc(room);
        break;
      }
    }
    broadcastAll(socket.data.room);
  });

  /* ---------- 玩家选座 ---------- */
  socket.on('player:seat', ({ seatId, token }) => {
    if (socket.data.isHost) return;
    if (!socket.data.room) return;
    const room = getRoom(socket.data.room);
    const seat = room.seats.find(s => s.id === seatId);
    if (!seat) {
      socket.emit('seat:error', '座位不存在');
      return;
    }
    if (seat.occupant && seat.occupant !== token) {
      socket.emit('seat:error', '该座位已被其他玩家占用');
      return;
    }
    // 换座时释放旧座位
    if (socket.data.seatId != null && socket.data.seatId !== seatId) {
      const old = room.seats.find(s => s.id === socket.data.seatId);
      if (old && old.occupant === socket.data.token) old.occupant = null;
    }
    seat.occupant = token;
    socket.data.token = token;
    socket.data.seatId = seatId;
    broadcastAll(socket.data.room);
  });

  /* ---------- 玩家查看自己的暗牌 ---------- */
  socket.on('player:peek', ({ seatId, index }) => {
    if (socket.data.isHost) return;
    if (socket.data.seatId !== seatId) return;
    const room = getRoom(socket.data.room);
    const seat = room.seats.find(s => s.id === seatId);
    const card = seat && seat.cards[index];
    if (!card) return;
    socket.emit('peek:result', {
      seatId,
      index,
      rank: card.rank,
      suit: card.suit
    });
  });

  /* ---------- 玩家让出座位 ---------- */
  socket.on('player:leave', () => {
    if (socket.data.seatId == null) return;
    const room = getRoom(socket.data.room);
    const seat = room.seats.find(s => s.id === socket.data.seatId);
    if (seat && seat.occupant === socket.data.token) seat.occupant = null;
    socket.data.seatId = null;
    broadcastAll(socket.data.room);
  });

  /* ---------- 断线 60 秒后释放座位 ---------- */
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    const token = socket.data.token;
    const seatId = socket.data.seatId;
    if (!roomName || seatId == null || !token) return;

    setTimeout(() => {
      const room = rooms.get(roomName);
      if (!room) return;
      const ids = io.sockets.adapter.rooms.get(roomName);
      let stillOnline = false;
      if (ids) {
        for (const id of ids) {
          const s = io.sockets.sockets.get(id);
          if (s && s.data.token === token && s.data.seatId === seatId) {
            stillOnline = true;
            break;
          }
        }
      }
      if (!stillOnline) {
        const seat = room.seats.find(s => s.id === seatId);
        if (seat && seat.occupant === token) {
          seat.occupant = null;
          broadcastAll(roomName);
        }
      }
    }, 60000);
  });
});

server.listen(PORT, () => {
  console.log(`服务器已启动，端口 ${PORT}`);
});

// 防止 Render 免费实例休眠
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    const client = SELF_URL.startsWith('https') ? https : http;
    client.get(SELF_URL, res => res.resume()).on('error', () => {});
  }, 10 * 60 * 1000);
}
