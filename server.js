// server.js - 适用于Render免费空间的多人翻牌系统
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 将pic文件夹暴露为静态资源，使前端可以通过 /pic/0.jpg 访问图片
app.use('/pic', express.static('pic'));

// 根路由返回完整的HTML页面（6列x4行，图片版）
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>多人实时翻牌 · 6x4 图片版 (Render)</title>
    <style>
        * { box-sizing: border-box; font-family: system-ui, 'Segoe UI', Roboto, sans-serif; }
        body {
            background: linear-gradient(145deg, #2b3a4a 0%, #1d2a35 100%);
            min-height: 100vh; margin: 0;
            display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px;
        }
        h1 {
            color: #f0e6d0; text-shadow: 0 4px 8px rgba(0,0,0,0.5);
            margin-top: 0; font-weight: 400; letter-spacing: 2px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(6, 1fr); /* 6列 */
            gap: 15px;
            width: min(1000px, 95vw);
            margin: 20px auto;
            perspective: 1200px;
        }
        .card-container {
            position: relative;
            width: 100%;
            padding-bottom: 100%; /* 保持1:1正方形 */
            cursor: pointer;
            transition: transform 0.6s cubic-bezier(0.23, 1, 0.32, 1);
            transform-style: preserve-3d;
            transform: rotateY(180deg); /* 默认背面 */
        }
        .card-container.flipped {
            transform: rotateY(0deg); /* 正面 */
        }
        .card-front, .card-back {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            backface-visibility: hidden;
            border-radius: 16px;
            box-shadow: 0 12px 20px -8px rgba(0,0,0,0.4);
            border: 2px solid rgba(255,255,240,0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .card-front {
            background: #fcf9f0;
            transform: rotateY(0deg);
        }
        .card-front img {
            width: 100%;
            height: 100%;
            object-fit: cover; /* 铺满，可能裁剪，如需完整显示可改为contain */
            display: block;
        }
        .card-back {
            background: #4a5c6e;
            background-image: repeating-linear-gradient(45deg, #3f5062 0px, #3f5062 4px, #53687a 4px, #53687a 8px);
            color: #ecd9b4;
            transform: rotateY(180deg);
            font-size: 3rem;
            text-shadow: 2px 2px 0 #1f2b33;
        }
        .control-panel {
            background: rgba(20, 30, 40, 0.8);
            backdrop-filter: blur(6px);
            padding: 25px 20px;
            border-radius: 40px;
            margin-top: 30px;
            width: min(500px, 95%);
            display: flex;
            gap: 20px;
            align-items: center;
            justify-content: center;
            border: 1px solid #5f7a94;
            box-shadow: 0 15px 25px rgba(0,0,0,0.5);
        }
        .btn.reset {
            background: #b0c6d9;
            border: none;
            padding: 10px 24px;
            border-radius: 40px;
            font-weight: 600;
            font-size: 1rem;
            color: #1e2b38;
            cursor: pointer;
            box-shadow: 0 6px 0 #5e727e;
            border-bottom: 2px solid #7b92a5;
            transition: 0.2s;
        }
        .btn.reset:hover {
            background: #a5bccf;
            transform: translateY(-2px);
            box-shadow: 0 8px 0 #5e727e;
        }
        .btn.reset:active {
            transform: translateY(4px);
            box-shadow: 0 2px 0 #5e727e;
        }
        .status {
            color: #bed6ed;
            font-size: 0.9rem;
            background: #1d2c39;
            padding: 6px 15px;
            border-radius: 40px;
        }
    </style>
</head>
<body>
    <h1>🎴 多人实时翻牌 · 6x4 图片版</h1>
    <div class="grid" id="grid"></div>

    <div class="control-panel">
        <button class="btn reset" id="resetBtn">重置所有背面</button>
        <span class="status" id="connStatus">📡 连接中...</span>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        (function() {
            const socket = io();
            const grid = document.getElementById('grid');
            let cardElements = [];

            // 创建卡片DOM（每张正面显示对应的图片）
            function createCards(cardsData) {
                grid.innerHTML = '';
                cardElements = [];
                cardsData.forEach((card, idx) => {
                    const cardContainer = document.createElement('div');
                    cardContainer.className = \`card-container \${card.isFlipped ? 'flipped' : ''}\`;
                    cardContainer.dataset.index = idx;

                    // 正面：图片
                    const front = document.createElement('div');
                    front.className = 'card-front';
                    const img = document.createElement('img');
                    img.src = \`/pic/\${idx}.jpg\`;  // 图片路径 0.jpg ~ 23.jpg
                    img.alt = \`card-\${idx}\`;
                    // 图片加载失败时显示简单文字（可选）
                    img.onerror = () => { img.style.display = 'none'; front.textContent = '❌'; };
                    front.appendChild(img);

                    // 背面：问号
                    const back = document.createElement('div');
                    back.className = 'card-back';
                    back.textContent = '?';

                    cardContainer.appendChild(front);
                    cardContainer.appendChild(back);
                    grid.appendChild(cardContainer);
                    cardElements.push(cardContainer);
                });
            }

            // 更新卡片翻转状态
            function updateCards(cardsData) {
                cardsData.forEach((card, idx) => {
                    const cardEl = cardElements[idx];
                    if (!cardEl) return;
                    if (card.isFlipped) {
                        cardEl.classList.add('flipped');
                    } else {
                        cardEl.classList.remove('flipped');
                    }
                });
            }

            socket.on('init', (cards) => {
                createCards(cards);
                document.getElementById('connStatus').innerHTML = '🟢 已连接';
            });

            socket.on('update', (cards) => {
                if (cardElements.length === 0) createCards(cards);
                else updateCards(cards);
            });

            // 点击卡片触发翻转
            grid.addEventListener('click', (e) => {
                const card = e.target.closest('.card-container');
                if (card) {
                    const index = card.dataset.index;
                    socket.emit('flip', { index: parseInt(index) });
                }
            });

            // 重置按钮
            document.getElementById('resetBtn').addEventListener('click', () => {
                socket.emit('reset');
            });

            socket.on('connect', () => {
                document.getElementById('connStatus').innerHTML = '🟢 已连接';
            });
            socket.on('disconnect', () => {
                document.getElementById('connStatus').innerHTML = '🔴 已断开';
            });
        })();
    </script>
</body>
</html>
  `);
});

// 初始化24张牌，只存储翻转状态（图片由前端静态加载）
let cards = [];
for (let i = 0; i < 24; i++) {
  cards.push({
    index: i,
    isFlipped: false,
  });
}

io.on('connection', (socket) => {
  console.log('用户已连接，ID:', socket.id);
  // 发送当前状态给新用户
  socket.emit('init', cards);

  // 处理翻牌
  socket.on('flip', (data) => {
    const { index } = data;
    if (index >= 0 && index < cards.length) {
      cards[index].isFlipped = !cards[index].isFlipped;
      io.emit('update', cards); // 广播给所有客户端
    }
  });

  // 处理重置
  socket.on('reset', () => {
    cards.forEach(card => card.isFlipped = false);
    io.emit('update', cards);
  });

  socket.on('disconnect', () => {
    console.log('用户已断开，ID:', socket.id);
  });
});

// 使用环境变量端口（Render会自动设置PORT）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});