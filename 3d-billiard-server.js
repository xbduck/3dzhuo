// Node.js 游戏服务器 - 支持多人在线对战
// 使用 Socket.io 实现实时通信

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// 初始化 Express 应用
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 中间件
app.use(cors());
app.use(express.json());

// 数据库连接（MongoDB）
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/billiard-game';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ MongoDB 连接成功');
}).catch(err => {
    console.error('❌ MongoDB 连接失败:', err);
});

// 用户模型
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isGuest: { type: Boolean, default: false },
    score: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// 游戏房间模型
const GameRoomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    player1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    player2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
    score: {
        player1: { type: Number, default: 0 },
        player2: { type: Number, default: 0 }
    },
    turn: { type: String, enum: ['player1', 'player2'], default: 'player1' },
    createdAt: { type: Date, default: Date.now }
});

const GameRoom = mongoose.model('GameRoom', GameRoomSchema);

// JWT 密钥
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// 存储在线用户和游戏房间
const onlineUsers = new Map();
const waitingQueue = [];
const activeGames = new Map();

// ===== API 路由 =====

// 用户注册
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // 检查用户是否已存在
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ error: '用户名已存在' });
        }

        // 加密密码
        const hashedPassword = await bcrypt.hash(password, 10);

        // 创建用户
        const user = new User({
            username,
            password: hashedPassword
        });
        await user.save();

        // 生成 JWT token
        const token = jwt.sign(
            { userId: user._id, username: user.username },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                score: user.score,
                wins: user.wins,
                losses: user.losses
            }
        });
    } catch (error) {
        console.error('注册错误:', error);
        res.status(500).json({ error: '注册失败' });
    }
});

// 用户登录
app.post('/api/login', async (req, res) => {
    try {
        const { username, password, isGuest } = req.body;

        if (isGuest) {
            // 游客登录
            const user = new User({
                username,
                password: '',
                isGuest: true
            });
            await user.save();

            const token = jwt.sign(
                { userId: user._id, username: user.username, isGuest: true },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            return res.json({
                success: true,
                token,
                user: {
                    id: user._id,
                    username: user.username,
                    isGuest: true,
                    score: user.score,
                    wins: user.wins,
                    losses: user.losses
                }
            });
        }

        // 正常登录
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        const token = jwt.sign(
            { userId: user._id, username: user.username },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                score: user.score,
                wins: user.wins,
                losses: user.losses
            }
        });
    } catch (error) {
        console.error('登录错误:', error);
        res.status(500).json({ error: '登录失败' });
    }
});

// 获取排行榜
app.get('/api/leaderboard', async (req, res) => {
    try {
        const leaderboard = await User.find({ isGuest: false })
            .sort({ score: -1 })
            .limit(50)
            .select('username score wins losses');

        res.json({ leaderboard });
    } catch (error) {
        console.error('获取排行榜错误:', error);
        res.status(500).json({ error: '获取排行榜失败' });
    }
});

// ===== Socket.io 事件处理 =====

io.on('connection', (socket) => {
    console.log('🎮 用户连接:', socket.id);

    // 用户登录
    socket.on('login', async (data) => {
        try {
            const { username, password, isGuest } = data;

            let user;
            if (isGuest) {
                // 游客登录
                user = new User({
                    username,
                    password: '',
                    isGuest: true
                });
                await user.save();
            } else {
                // 验证 token
                const token = data.token;
                try {
                    const decoded = jwt.verify(token, JWT_SECRET);
                    user = await User.findById(decoded.userId);
                } catch (tokenError) {
                    console.error('Token 验证失败:', tokenError);
                    return;
                }
            }

            if (!user) {
                socket.emit('login_failed', { error: '登录失败' });
                return;
            }

            // 存储在线用户信息
            onlineUsers.set(socket.id, {
                userId: user._id,
                username: user.username,
                isGuest: user.isGuest,
                socketId: socket.id
            });

            console.log('✅ 用户登录成功:', user.username);
            socket.emit('login_success', {
                userId: user._id,
                username: user.username,
                score: user.score
            });

        } catch (error) {
            console.error('登录处理错误:', error);
            socket.emit('login_failed', { error: '登录失败' });
        }
    });

    // 寻找对手
    socket.on('find_match', async () => {
        const currentUser = onlineUsers.get(socket.id);
        if (!currentUser) {
            socket.emit('match_failed', { error: '请先登录' });
            return;
        }

        console.log('🔍 用户寻找对手:', currentUser.username);

        // 检查是否已经在队列中
        if (waitingQueue.includes(socket.id)) {
            return;
        }

        // 将用户加入匹配队列
        waitingQueue.push(socket.id);

        // 尝试匹配对手
        if (waitingQueue.length >= 2) {
            const player1SocketId = waitingQueue.shift();
            const player2SocketId = waitingQueue.shift();

            const player1 = onlineUsers.get(player1SocketId);
            const player2 = onlineUsers.get(player2SocketId);

            if (!player1 || !player2) {
                // 如果用户已离线，重新放回队列
                if (!player1) waitingQueue.unshift(player1SocketId);
                if (!player2) waitingQueue.unshift(player2SocketId);
                return;
            }

            // 创建游戏房间
            const roomId = `game_${Date.now()}`;
            const gameRoom = new GameRoom({
                roomId,
                player1: player1.userId,
                player2: player2.userId,
                status: 'playing'
            });
            await gameRoom.save();

            // 存储游戏信息
            activeGames.set(roomId, {
                roomId,
                player1: player1,
                player2: player2,
                player1Socket: player1SocketId,
                player2Socket: player2SocketId,
                turn: 'player1',
                balls: [],
                score: { player1: 0, player2: 0 }
            });

            console.log('✅ 匹配成功:', player1.username, 'vs', player2.username);

            // 通知两个玩家
            io.to(player1SocketId).emit('match_found', {
                roomId,
                opponent: {
                    id: player2.userId,
                    username: player2.username,
                    score: player2.score
                },
                isMyTurn: true
            });

            io.to(player2SocketId).emit('match_found', {
                roomId,
                opponent: {
                    id: player1.userId,
                    username: player1.username,
                    score: player1.score
                },
                isMyTurn: false
            });
        }
    });

    // 玩家击球
    socket.on('shoot', (data) => {
        const currentUser = onlineUsers.get(socket.id);
        if (!currentUser) return;

        const { gameId, power, angle } = data;
        const game = activeGames.get(gameId);

        if (!game) {
            console.error('游戏不存在:', gameId);
            return;
        }

        // 验证是否是该玩家的回合
        const isPlayer1 = game.player1.socketId === socket.id;
        if ((isPlayer1 && game.turn !== 'player1') || (!isPlayer1 && game.turn !== 'player2')) {
            console.log('❌ 不是该玩家的回合');
            return;
        }

        console.log('🎱 玩家击球:', currentUser.username, '力度:', power, '角度:', angle);

        // 转发给对手
        const opponentSocketId = isPlayer1 ? game.player2Socket : game.player1Socket;
        io.to(opponentSocketId).emit('opponent_shoot', {
            playerId: currentUser.userId,
            power,
            angle
        });

        // 切换回合（简化逻辑，实际应该等待球停止）
        game.turn = isPlayer1 ? 'player2' : 'player1';

        // 通知双方回合切换
        io.to(game.player1Socket).emit('turn_changed', {
            currentTurn: game.turn
        });

        io.to(game.player2Socket).emit('turn_changed', {
            currentTurn: game.turn
        });
    });

    // 球进袋
    socket.on('ball_pocketed', async (data) => {
        const currentUser = onlineUsers.get(socket.id);
        if (!currentUser) return;

        const { gameId, score } = data;
        const game = activeGames.get(gameId);

        if (!game) return;

        // 更新游戏分数
        game.score = score;

        const isPlayer1 = game.player1.socketId === socket.id;
        const scorer = isPlayer1 ? 'player1' : 'player2';
        const receiver = isPlayer1 ? 'player2' : 'player1';

        // 通知双方得分更新
        io.to(game.player1Socket).emit('score_updated', score);
        io.to(game.player2Socket).emit('score_updated', score);

        console.log('🎯 球进袋:', currentUser.username, '分数:', score);
    });

    // 聊天消息
    socket.on('chat_message', (data) => {
        const currentUser = onlineUsers.get(socket.id);
        if (!currentUser) return;

        const { gameId, message } = data;
        const game = activeGames.get(gameId);

        if (!game) return;

        // 转发消息给对手
        const opponentSocketId = game.player1.socketId === socket.id 
            ? game.player2Socket 
            : game.player1Socket;

        io.to(opponentSocketId).emit('chat_message', {
            username: currentUser.username,
            message
        });

        console.log('💬 聊天消息:', currentUser.username, ':', message);
    });

    // 游戏结束
    socket.on('game_over', async (data) => {
        const currentUser = onlineUsers.get(socket.id);
        if (!currentUser) return;

        const { gameId, winner } = data;
        const game = activeGames.get(gameId);

        if (!game) return;

        // 更新数据库中的游戏结果
        await GameRoom.findOneAndUpdate(
            { roomId: gameId },
            { 
                status: 'finished',
                winner: winner
            }
        );

        // 更新玩家统计数据
        const winnerId = winner === 'player1' ? game.player1.userId : game.player2.userId;
        const loserId = winner === 'player1' ? game.player2.userId : game.player1.userId;

        await User.findByIdAndUpdate(winnerId, {
            $inc: { wins: 1, score: 100 }
        });

        await User.findByIdAndUpdate(loserId, {
            $inc: { losses: 1 }
        });

        // 通知双方游戏结束
        io.to(game.player1Socket).emit('game_over', {
            winner,
            finalScore: game.score
        });

        io.to(game.player2Socket).emit('game_over', {
            winner,
            finalScore: game.score
        });

        // 清理游戏
        activeGames.delete(gameId);
        console.log('🏆 游戏结束:', gameId);
    });

    // 用户断开连接
    socket.on('disconnect', () => {
        const user = onlineUsers.get(socket.id);
        if (user) {
            console.log('👋 用户断开连接:', user.username);
            
            // 从匹配队列中移除
            const queueIndex = waitingQueue.indexOf(socket.id);
            if (queueIndex !== -1) {
                waitingQueue.splice(queueIndex, 1);
            }

            // 处理正在进行的游戏
            activeGames.forEach((game, roomId) => {
                if (game.player1.socketId === socket.id || game.player2.socketId === socket.id) {
                    // 通知对手
                    const opponentSocketId = game.player1.socketId === socket.id 
                        ? game.player2Socket 
                        : game.player1Socket;

                    io.to(opponentSocketId).emit('opponent_disconnected');

                    // 标记游戏结束
                    GameRoom.findOneAndUpdate(
                        { roomId },
                        { status: 'finished' }
                    ).exec();

                    activeGames.delete(roomId);
                    console.log('❌ 游戏因玩家断开连接而结束:', roomId);
                }
            });

            onlineUsers.delete(socket.id);
        }
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 桌球游戏服务器启动成功！');
    console.log(`📡 服务器地址: http://localhost:${PORT}`);
    console.log('⚡ Socket.io 服务已就绪');
});
