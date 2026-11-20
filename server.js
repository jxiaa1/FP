const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'admin888';
const SEATS = 7;
const CARDS_PER_SEAT = 5;

app.use(express.static(__dirname));

const rooms = new Map();

function makeDeck() {
  const suits = ['♠', '♥', '♣', '♦'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push({ rank: r, suit: s, faceUp: false });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom() {
  const seats = [];
  for (let i = 0; i < SEATS; i++) {
    seats.push({ id: i, name: `玩家 ${i + 1}`, cards: [] });
  }
  return {
    seats,
    deck: makeDeck(),
    total: SEATS * CARDS_PER_SEAT,
    remaining: SEATS * CARDS_PER_SEAT
  };
}

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, createRoom());
  }
  return rooms.get(name);
}

function publicState(room) {
  return {
    seats: room.seats.map(s => ({
      id: s.id,
      name: s.name,
      cards: s.cards.map(c => ({ rank: c.rank, suit: c.suit, faceUp: c.faceUp }))
    })),
    total: room.total,
    remaining: room.remaining
  };
}

function broadcast(roomName) {
  const room = getRoom(roomName);
  io.to(roomName).emit('state', publicState(room));
}

function dealOne(room) {
  if (room.remaining <= 0) return;
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (seat.cards.length < CARDS_PER_SEAT) {
      const card = room.deck.pop();
      if (!card) return;
      card.faceUp = seat.cards.length === 0; // 每人第一张明置，其余暗置
      seat.cards.push(card);
      room.remaining--;
      return;
    }
  }
}

function dealAll(room) {
  while (room.remaining > 0) {
    let dealt = false;
    for (let i = 0; i < SEATS; i++) {
      const seat = room.seats[i];
      if (seat.cards.length < CARDS_PER_SEAT) {
        const card = room.deck.pop();
        if (!card) {
          room.remaining = 0;
          return;
        }
        card.faceUp = seat.cards.length === 0;
        seat.cards.push(card);
        room.remaining--;
        dealt = true;
      }
    }
    if (!dealt) break;
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let isHost = false;

  socket.on('join', ({ room, host, key }) => {
    currentRoom = String(room || 'default').slice(0, 32) || 'default';
    socket.join(currentRoom);
    isHost = !!host && key === HOST_KEY;
    socket.emit('role', { isHost, seats: SEATS, cardsPerSeat: CARDS_PER_SEAT });
    socket.emit('state', publicState(getRoom(currentRoom)));
  });

  socket.on('host:action', (action) => {
    if (!isHost || !currentRoom) return;
    const room = getRoom(currentRoom);

    if (action.type === 'dealOne') {
      dealOne(room);
    } else if (action.type === 'dealAll') {
      dealAll(room);
    } else if (action.type === 'revealAll') {
      room.seats.forEach(s => s.cards.forEach(c => { c.faceUp = true; }));
    } else if (action.type === 'reset') {
      rooms.set(currentRoom, createRoom());
    } else if (action.type === 'rename') {
      const seat = room.seats[action.seatId];
      if (seat && typeof action.name === 'string') {
        seat.name = action.name.slice(0, 20) || `玩家 ${action.seatId + 1}`;
      }
    } else if (action.type === 'toggle') {
      const seat = room.seats[action.seatId];
      const card = seat && seat.cards[action.index];
      if (card) {
        card.faceUp = !card.faceUp;
      }
    }

    broadcast(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`服务器已启动，端口 ${PORT}`);
});

// 防止 Render 免费实例休眠：每 10 分钟自请求一次
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    const client = SELF_URL.startsWith('https') ? https : http;
    client.get(SELF_URL, (res) => {
      res.resume();
    }).on('error', () => {});
  }, 10 * 60 * 1000);
}